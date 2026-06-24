/**
 * Tests for lib/node/pi/ext/comfyui/refine-loop.ts: the available-action
 * hint, the action -> param projection, and the refiner-aware loop driver
 * (runRefinePass) with a mocked refiner + injected renderAction (no network,
 * no subagent).
 */

import { expect, test } from 'vitest';

import type { CriticDecision, Refiner } from '../../../../../../lib/node/pi/comfyui/refine.ts';
import type { ResolvedGenerateParams } from '../../../../../../lib/node/pi/ext/comfyui/layer-params.ts';
import {
  applyRefineAction,
  availableActionsFor,
  type RenderedImage,
  runRefinePass,
} from '../../../../../../lib/node/pi/ext/comfyui/refine-loop.ts';

const baseParams: ResolvedGenerateParams = { prompt: 'a cat', negative: 'blurry', seed: 42, width: 512, height: 512 };

function img(savedPath: string, prompt = 'a cat', seed = 42): RenderedImage {
  return { block: { type: 'image', data: '', mimeType: 'image/png' }, savedPath, prompt, seed };
}

test('availableActionsFor always includes the t2i channels and dedupes', () => {
  expect(availableActionsFor([])).toEqual(['reroll', 'revise_prompt']);
  expect(availableActionsFor(['img2img', 'reroll'])).toEqual(['reroll', 'revise_prompt', 'img2img']);
});

test('applyRefineAction: reroll drops the seed so the graph randomizes', () => {
  const next = applyRefineAction(baseParams, { type: 'reroll' });
  expect(next.seed).toBeUndefined();
  expect(next.prompt).toBe('a cat'); // unchanged
});

test('applyRefineAction: revise_prompt swaps prompt/negative, keeps seed unless newSeed', () => {
  const kept = applyRefineAction(baseParams, { type: 'revise_prompt', prompt: 'a dog', negative: 'lowres' });
  expect(kept.prompt).toBe('a dog');
  expect(kept.negative).toBe('lowres');
  expect(kept.seed).toBe(42);
  const rerolled = applyRefineAction(baseParams, { type: 'revise_prompt', prompt: 'a dog', newSeed: true });
  expect(rerolled.seed).toBeUndefined();
});

function fakeRefiner(decisions: (CriticDecision | null)[]): Refiner<unknown> {
  let i = 0;
  return {
    isEnabled: () => true,
    critique: () => Promise.resolve(decisions[i++] ?? null),
  };
}

const agentCtx = { cwd: '/cwd', model: undefined, modelRegistry: {} as never };

test('runRefinePass: revises once then accepts, returning the corrective render as best', async () => {
  const renders: string[] = [];
  const progress: string[] = [];
  const loop = await runRefinePass<unknown>({
    refiner: fakeRefiner([
      {
        verdict: 'revise',
        score: 4,
        assessment: '',
        issues: [{ kind: 'prompt_miss', scope: 'global' }],
        action: { type: 'revise_prompt', prompt: 'a better cat' },
      },
      { verdict: 'accept', score: 8, assessment: '', issues: [] },
    ]),
    agentCtx,
    initialImage: img('/out/r0.png'),
    renderAction: (action) => {
      renders.push(action.type);
      return Promise.resolve(img('/out/r1.png', 'a better cat'));
    },
    request: { prompt: 'a cat' },
    availableChannels: [],
    maxRefineIterations: 2,
    refineAcceptThreshold: 7,
    onProgress: (text) => progress.push(text),
  });
  expect(renders).toEqual(['revise_prompt']);
  expect(loop.accepted).toBe(true);
  expect(loop.finalScore).toBe(8);
  expect(loop.image.savedPath).toBe('/out/r1.png');
  expect(loop.journey.map((j) => j.action)).toEqual(['initial', 'revise_prompt']);
  // Progress reports the previous round's score before each corrective render.
  expect(progress).toEqual(['refining 1/2, score 4']);
});

test('runRefinePass: accepts the initial render with no corrective round', async () => {
  let rendered = 0;
  const loop = await runRefinePass<unknown>({
    refiner: fakeRefiner([{ verdict: 'accept', score: 9, assessment: '', issues: [] }]),
    agentCtx,
    initialImage: img('/out/r0.png'),
    renderAction: () => {
      rendered++;
      return Promise.resolve(img('/out/never.png'));
    },
    request: { prompt: 'a cat' },
    availableChannels: [],
    maxRefineIterations: 2,
    refineAcceptThreshold: 7,
  });
  expect(rendered).toBe(0);
  expect(loop.image.savedPath).toBe('/out/r0.png');
  expect(loop.journey).toHaveLength(1);
});
