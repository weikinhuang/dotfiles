/**
 * Tests for lib/node/pi/ext/comfyui/refine-loop.ts: the available-action
 * hint, the action -> param projection, and the refiner-aware loop driver
 * (runRefinePass) with a mocked refiner + injected renderAction (no network,
 * no subagent).
 */

import { expect, test } from 'vitest';

import type { CriticDecision, Refiner } from '../../../../../../lib/node/pi/comfyui/refine.ts';
import type { WorkflowConfig } from '../../../../../../lib/node/pi/comfyui/types.ts';
import type { ResolvedGenerateParams } from '../../../../../../lib/node/pi/ext/comfyui/layer-params.ts';
import {
  applyRefineAction,
  availableActionsFor,
  planRefineRender,
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

test('runRefinePass: threads the just-critiqued image into renderAction as currentImage', async () => {
  const seenInit: string[] = [];
  let n = 0;
  const loop = await runRefinePass<unknown>({
    refiner: fakeRefiner([
      {
        verdict: 'revise',
        score: 4,
        assessment: '',
        issues: [{ kind: 'bad_hands', scope: 'local' }],
        action: { type: 'reroll' },
      },
      {
        verdict: 'revise',
        score: 5,
        assessment: '',
        issues: [{ kind: 'bad_hands', scope: 'local' }],
        action: { type: 'reroll' },
      },
      { verdict: 'accept', score: 8, assessment: '', issues: [] },
    ]),
    agentCtx,
    initialImage: img('/out/r0.png'),
    renderAction: (_action, currentImage) => {
      seenInit.push(currentImage.savedPath);
      n += 1;
      return Promise.resolve(img(`/out/r${n}.png`));
    },
    request: { prompt: 'a cat' },
    availableChannels: [],
    maxRefineIterations: 2,
    refineAcceptThreshold: 7,
  });
  // Each corrective render is fed the render it is meant to repair: round 1
  // repairs r0, round 2 repairs r1 (the result of round 1).
  expect(seenInit).toEqual(['/out/r0.png', '/out/r1.png']);
  expect(loop.image.savedPath).toBe('/out/r2.png');
});

const animaInpaint: WorkflowConfig = {
  file: 'anima-inpaint.api.json',
  inputs: { prompt: { node: '65', key: 'string' }, denoise: { node: '20', key: 'denoise' } },
  images: {
    init: { node: '16', key: 'image' },
    mask: { node: '17', key: 'image', kind: 'mask' },
  },
};
const animaImg2img: WorkflowConfig = {
  file: 'anima-img2img.api.json',
  inputs: { prompt: { node: '65', key: 'string' }, denoise: { node: '20', key: 'denoise' } },
  images: { init: { node: '16', key: 'image' } },
};
const planCtx = {
  baseParams,
  workflows: { 'anima-inpaint': animaInpaint, 'anima-img2img': animaImg2img },
  refineWith: { inpaint: 'anima-inpaint', img2img: 'anima-img2img', ground: 'missing' },
};

test('planRefineRender: t2i channels render the source workflow', () => {
  for (const type of ['reroll', 'revise_prompt'] as const) {
    const plan = planRefineRender({ type }, img('/out/r0.png'), planCtx);
    expect(plan).toMatchObject({ kind: 'source', action: { type } });
    expect((plan as { downgradedFrom?: string }).downgradedFrom).toBeUndefined();
  }
});

test('planRefineRender: img2img routes to the companion, feeds init, layers denoise', () => {
  const plan = planRefineRender({ type: 'img2img', denoise: 0.35 }, img('/out/r1.png'), planCtx);
  expect(plan.kind).toBe('companion');
  if (plan.kind !== 'companion') throw new Error('expected companion');
  expect(plan.name).toBe('anima-img2img');
  expect(plan.roleSources).toEqual({ init: '/out/r1.png' });
  expect(plan.params.denoise).toBe(0.35);
  expect(plan.params.count).toBe(1);
  expect(plan.params.inputImages).toBeUndefined();
});

test('planRefineRender: inpaint synthesizes a coarse-region mask via the bbox path', () => {
  const plan = planRefineRender({ type: 'inpaint', region: 'center', denoise: 0.6 }, img('/out/r1.png'), planCtx);
  expect(plan.kind).toBe('companion');
  if (plan.kind !== 'companion') throw new Error('expected companion');
  expect(plan.name).toBe('anima-inpaint');
  // The coarse-region mask carries a modest default feather so the repaint
  // blends at the boundary (the critic names only a coarse region).
  expect(plan.roleSources).toEqual({ init: '/out/r1.png', mask: { bbox: [[0.25, 0.25, 0.5, 0.5]], feather: 12 } });
});

test('planRefineRender: inpaint with no/unknown region masks the whole image', () => {
  const plan = planRefineRender({ type: 'inpaint' }, img('/out/r1.png'), planCtx);
  if (plan.kind !== 'companion') throw new Error('expected companion');
  expect(plan.roleSources.mask).toEqual({ bbox: [[0, 0, 1, 1]], feather: 12 });
});

test('planRefineRender: ground/detailer carry target + detect onto the companion params', () => {
  const grounded = planRefineRender({ type: 'ground', target: 'the left pauldron' }, img('/out/r1.png'), {
    ...planCtx,
    workflows: { ...planCtx.workflows, 'anima-ground': animaImg2img },
    refineWith: { ...planCtx.refineWith, ground: 'anima-ground' },
  });
  if (grounded.kind !== 'companion') throw new Error('expected companion');
  expect(grounded.params.target).toBe('the left pauldron');
});

const animaDetailer: WorkflowConfig = {
  file: 'anima-detailer.api.json',
  inputs: { prompt: { node: '65', key: 'string' }, detect: { node: '30', key: 'model_name' } },
  images: { init: { node: '16', key: 'image' } },
};

test('planRefineRender: detailer translates the detect keyword to a detector model filename', () => {
  const plan = planRefineRender({ type: 'detailer', detect: 'hand' }, img('/out/r1.png'), {
    ...planCtx,
    workflows: { ...planCtx.workflows, 'anima-detailer': animaDetailer },
    refineWith: { ...planCtx.refineWith, detailer: 'anima-detailer' },
  });
  if (plan.kind !== 'companion') throw new Error('expected companion');
  // The critic emits a semantic keyword; the loop maps it to the YOLO filename.
  expect(plan.params.detect).toBe('bbox/hand_yolov8s.pt');
});

test('planRefineRender: detailer detect translation honors a workflow detectModels override', () => {
  const custom: WorkflowConfig = { ...animaDetailer, detectModels: { hand: 'bbox/custom_hand.pt' } };
  const plan = planRefineRender({ type: 'detailer', detect: 'hand' }, img('/out/r1.png'), {
    ...planCtx,
    workflows: { ...planCtx.workflows, 'anima-detailer': custom },
    refineWith: { ...planCtx.refineWith, detailer: 'anima-detailer' },
  });
  if (plan.kind !== 'companion') throw new Error('expected companion');
  expect(plan.params.detect).toBe('bbox/custom_hand.pt');
});

test('planRefineRender: passes the critic instruction only when the companion maps an instruction input', () => {
  // The img2img companion in planCtx maps prompt + denoise but NOT
  // `instruction`, so a supplied instruction is dropped (passing it would trip
  // the graph builder's unmapped-but-supplied mapping-error guard).
  const dropped = planRefineRender({ type: 'img2img', instruction: 'add rain' }, img('/out/r1.png'), planCtx);
  if (dropped.kind !== 'companion') throw new Error('expected companion');
  expect(dropped.params.instruction).toBeUndefined();

  // A companion that DOES map `instruction` receives the critic's text.
  const withInstr: WorkflowConfig = {
    file: 'anima-img2img.api.json',
    inputs: { prompt: { node: '65', key: 'string' }, instruction: { node: '70', key: 'text' } },
    images: { init: { node: '16', key: 'image' } },
  };
  const kept = planRefineRender({ type: 'img2img', instruction: 'add rain' }, img('/out/r1.png'), {
    ...planCtx,
    workflows: { ...planCtx.workflows, 'anima-img2img': withInstr },
  });
  if (kept.kind !== 'companion') throw new Error('expected companion');
  expect(kept.params.instruction).toBe('add rain');
});

test('planRefineRender: an unconfigured companion downgrades to a source reroll', () => {
  const plan = planRefineRender({ type: 'ground', target: 'x' }, img('/out/r1.png'), planCtx);
  expect(plan.kind).toBe('source');
  if (plan.kind !== 'source') throw new Error('expected source');
  expect(plan.action.type).toBe('reroll');
  expect(plan.downgradedFrom).toBe('ground');
});

test('planRefineRender: a companion missing its init role downgrades to a source reroll', () => {
  const noInit: WorkflowConfig = {
    file: 'x.json',
    inputs: {},
    images: { mask: { node: '1', key: 'image', kind: 'mask' } },
  };
  const plan = planRefineRender({ type: 'img2img' }, img('/out/r1.png'), {
    baseParams,
    workflows: { bad: noInit },
    refineWith: { img2img: 'bad' },
  });
  expect(plan.kind).toBe('source');
  if (plan.kind !== 'source') throw new Error('expected source');
  expect(plan.downgradedFrom).toBe('img2img');
});
