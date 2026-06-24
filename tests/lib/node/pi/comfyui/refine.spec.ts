/**
 * Tests for lib/node/pi/comfyui/refine.ts: the forgiving critic-decision
 * parse, the class-aware validate + downgrade, and the locked engine
 * reducer (accept via verdict / threshold, best-so-far selection, the
 * 1+N iteration cap, plateau-exit, and unparseable -> stop).
 */

import { expect, test } from 'vitest';

import {
  type CriticDecision,
  fallbackFor,
  parseCriticDecision,
  type RefineAction,
  type RefineChannel,
  type RefineLoopResult,
  runRefineLoop,
  validateAction,
} from '../../../../../lib/node/pi/comfyui/refine.ts';

// ── Forgiving parse ───────────────────────────────────────────────────

test('parseCriticDecision: valid JSON with every field', () => {
  const raw = JSON.stringify({
    verdict: 'revise',
    score: 6,
    assessment: 'good comp, left hand malformed',
    issues: [
      { kind: 'bad_hands', scope: 'local', detail: '6 fingers' },
      { kind: 'prompt_miss', scope: 'global' },
    ],
    action: { type: 'detailer', detect: 'hand' },
  });
  expect(parseCriticDecision(raw)).toEqual({
    verdict: 'revise',
    score: 6,
    assessment: 'good comp, left hand malformed',
    issues: [
      { kind: 'bad_hands', scope: 'local', detail: '6 fingers' },
      { kind: 'prompt_miss', scope: 'global' },
    ],
    action: { type: 'detailer', detect: 'hand' },
  });
});

test('parseCriticDecision: fenced (tagged and untagged) + prose-wrapped', () => {
  expect(parseCriticDecision('```json\n{"verdict":"accept","score":8}\n```')).toEqual({
    verdict: 'accept',
    score: 8,
    assessment: '',
    issues: [],
  });
  expect(parseCriticDecision('```\n{"verdict":"accept","score":8}\n```')?.verdict).toBe('accept');
  expect(parseCriticDecision('Here: {"verdict":"revise","score":3} - hope it helps')?.score).toBe(3);
});

test('parseCriticDecision: garbage / empty returns null', () => {
  expect(parseCriticDecision('')).toBeNull();
  expect(parseCriticDecision('   ')).toBeNull();
  expect(parseCriticDecision('just some prose, no json')).toBeNull();
  expect(parseCriticDecision('[1,2,3]')).toBeNull();
});

test('parseCriticDecision: missing / junk fields fall back to safe defaults', () => {
  expect(parseCriticDecision('{}')).toEqual({ verdict: 'revise', score: 0, assessment: '', issues: [] });
  // Unknown verdict -> revise; out-of-range score clamps to 0-10.
  expect(parseCriticDecision('{"verdict":"meh","score":15}')).toEqual({
    verdict: 'revise',
    score: 10,
    assessment: '',
    issues: [],
  });
  expect(parseCriticDecision('{"score":-4}')?.score).toBe(0);
  expect(parseCriticDecision('{"score":"high"}')?.score).toBe(0);
});

test('parseCriticDecision: issues without a usable kind are dropped; bad scope defaults to local', () => {
  const d = parseCriticDecision(
    JSON.stringify({
      verdict: 'revise',
      score: 5,
      issues: [{ kind: 'bad_object', scope: 'weird' }, { scope: 'local' }, 'nope', { kind: '   ' }],
    }),
  );
  expect(d?.issues).toEqual([{ kind: 'bad_object', scope: 'local' }]);
});

test('parseCriticDecision: an action with an unknown type is dropped entirely', () => {
  expect(parseCriticDecision('{"verdict":"revise","score":4,"action":{"type":"teleport"}}')?.action).toBeUndefined();
  expect(parseCriticDecision('{"verdict":"revise","score":4,"action":"reroll"}')?.action).toBeUndefined();
  const d = parseCriticDecision('{"verdict":"revise","score":4,"action":{"type":"img2img","denoise":0.4}}');
  expect(d?.action).toEqual({ type: 'img2img', denoise: 0.4 });
});

// ── Validate ──────────────────────────────────────────────────────────

test('validateAction: reroll/revise_prompt are always runnable; companions gate on availability', () => {
  expect(validateAction({ type: 'reroll' }, [])).toEqual({ type: 'reroll' });
  expect(validateAction({ type: 'revise_prompt', prompt: 'x' }, [])).toEqual({ type: 'revise_prompt', prompt: 'x' });
  expect(validateAction({ type: 'detailer' }, [])).toBeNull();
  expect(validateAction({ type: 'detailer' }, ['detailer'])).toEqual({ type: 'detailer' });
  expect(validateAction(undefined, ['detailer'])).toBeNull();
});

// ── Class-aware downgrade ─────────────────────────────────────────────

test('fallbackFor: prompt miss -> revise_prompt', () => {
  expect(fallbackFor([{ kind: 'prompt_miss', scope: 'global' }], [])).toEqual({ type: 'revise_prompt' });
});

test('fallbackFor: bad_hands -> detailer when available, else reroll (NOT img2img)', () => {
  expect(fallbackFor([{ kind: 'bad_hands', scope: 'local' }], ['detailer', 'img2img'])).toEqual({ type: 'detailer' });
  // Unavailable-channel fallback: no detailer -> a fresh seed, not whole-image img2img.
  expect(fallbackFor([{ kind: 'bad_hands', scope: 'local' }], ['img2img'])).toEqual({ type: 'reroll' });
});

test('fallbackFor: structural anatomy -> reroll, never inpaint', () => {
  expect(fallbackFor([{ kind: 'bad_anatomy', scope: 'structural' }], ['inpaint', 'detailer'])).toEqual({
    type: 'reroll',
  });
});

test('fallbackFor: named object -> ground, downgrading to inpaint then img2img then reroll', () => {
  const issue = { kind: 'bad_object', scope: 'local' as const };
  expect(fallbackFor([issue], ['ground', 'inpaint', 'img2img'])).toEqual({ type: 'ground' });
  expect(fallbackFor([issue], ['inpaint', 'img2img'])).toEqual({ type: 'inpaint' });
  expect(fallbackFor([issue], ['img2img'])).toEqual({ type: 'img2img' });
  expect(fallbackFor([issue], [])).toEqual({ type: 'reroll' });
});

test('fallbackFor: generic local polish -> img2img when available, else reroll', () => {
  expect(fallbackFor([{ kind: 'soft_focus', scope: 'local' }], ['img2img'])).toEqual({ type: 'img2img' });
  expect(fallbackFor([{ kind: 'soft_focus', scope: 'local' }], [])).toEqual({ type: 'reroll' });
});

test('fallbackFor: no issues -> null (nothing runnable)', () => {
  expect(fallbackFor([], ['img2img', 'detailer'])).toBeNull();
});

// ── Engine reducer ────────────────────────────────────────────────────

interface LoopOpts {
  available?: RefineChannel[];
  max?: number;
  threshold?: number;
}

/**
 * Drive `runRefineLoop` with a scripted critique sequence (one decision
 * consumed per image, oldest first) and a renderer that hands out
 * `r1`, `r2`, … image ids. The initial image is `r0`.
 */
function drive(
  decisions: (CriticDecision | null)[],
  opts: LoopOpts = {},
): Promise<{ result: RefineLoopResult<string>; actions: string[] }> {
  let i = 0;
  let rendered = 0;
  const actions: string[] = [];
  return runRefineLoop<string>({
    initialImage: 'r0',
    critique: () => decisions[i++] ?? null,
    render: (action: RefineAction) => {
      actions.push(action.type);
      rendered += 1;
      return `r${rendered}`;
    },
    availableChannels: opts.available ?? [],
    maxRefineIterations: opts.max ?? 2,
    refineAcceptThreshold: opts.threshold ?? 7,
    savedPathOf: (image) => `/out/${image}.png`,
  }).then((result) => ({ result, actions }));
}

function decision(over: Partial<CriticDecision>): CriticDecision {
  return { verdict: 'revise', score: 0, assessment: '', issues: [], ...over };
}

test('reducer: accept via verdict on the initial render does zero corrective renders', async () => {
  const { result, actions } = await drive([decision({ verdict: 'accept', score: 5 })]);
  expect(actions).toEqual([]);
  expect(result.image).toBe('r0');
  expect(result.accepted).toBe(true);
  expect(result.finalScore).toBe(5);
  expect(result.journey).toEqual([{ action: 'initial', score: 5, savedPath: '/out/r0.png' }]);
});

test('reducer: accept via the score threshold even when the verdict says revise', async () => {
  const { result, actions } = await drive([decision({ verdict: 'revise', score: 8 })], { threshold: 7 });
  expect(actions).toEqual([]);
  expect(result.accepted).toBe(true);
  expect(result.finalScore).toBe(8);
  expect(result.image).toBe('r0');
});

test('reducer: accept after one corrective render returns the accepted image', async () => {
  const { result, actions } = await drive(
    [decision({ score: 3, action: { type: 'reroll' } }), decision({ verdict: 'accept', score: 6 })],
    { threshold: 7, max: 2 },
  );
  expect(actions).toEqual(['reroll']);
  expect(result.image).toBe('r1');
  expect(result.accepted).toBe(true);
  expect(result.finalScore).toBe(6);
  expect(result.journey.map((j) => j.action)).toEqual(['initial', 'reroll']);
});

test('reducer: best-so-far keeps the higher-scoring earlier render when a later one is worse', async () => {
  const { result } = await drive([decision({ score: 6, action: { type: 'reroll' } }), decision({ score: 4 })], {
    threshold: 9,
    max: 2,
  });
  expect(result.image).toBe('r0');
  expect(result.finalScore).toBe(6);
  expect(result.accepted).toBe(false);
  expect(result.journey).toEqual([
    { action: 'initial', score: 6, savedPath: '/out/r0.png' },
    { action: 'reroll', score: 4, savedPath: '/out/r1.png' },
  ]);
});

test('reducer: maxRefineIterations caps corrective renders at N (total <= 1 + N)', async () => {
  const { result, actions } = await drive(
    [
      decision({ score: 3, action: { type: 'reroll' } }),
      decision({ score: 5, action: { type: 'reroll' } }),
      decision({ score: 6, action: { type: 'reroll' } }),
    ],
    { threshold: 9, max: 2 },
  );
  expect(actions).toEqual(['reroll', 'reroll']);
  expect(result.journey).toHaveLength(3);
  expect(result.image).toBe('r2');
  expect(result.finalScore).toBe(6);
  expect(result.accepted).toBe(false);
});

test('reducer: plateau-exit stops early when a render fails to improve the score', async () => {
  const { result, actions } = await drive(
    [decision({ score: 5, action: { type: 'reroll' } }), decision({ score: 5 })],
    { threshold: 9, max: 5 },
  );
  expect(actions).toEqual(['reroll']);
  expect(result.journey).toHaveLength(2);
  expect(result.image).toBe('r0');
  expect(result.finalScore).toBe(5);
});

test('reducer: an unparseable initial decision stops immediately and returns the initial', async () => {
  const { result, actions } = await drive([null], { max: 3 });
  expect(actions).toEqual([]);
  expect(result.image).toBe('r0');
  expect(result.accepted).toBe(false);
  expect(result.finalScore).toBe(0);
  expect(result.journey).toEqual([{ action: 'initial', score: 0, savedPath: '/out/r0.png' }]);
});

test('reducer: no runnable action (no companion, no issues) stops with the best-so-far', async () => {
  // revise verdict, below threshold, but the proposed channel is unavailable
  // and there are no issues to derive a fallback from -> stop.
  const { result, actions } = await drive([decision({ score: 4, action: { type: 'detailer' }, issues: [] })], {
    available: [],
    threshold: 7,
    max: 3,
  });
  expect(actions).toEqual([]);
  expect(result.image).toBe('r0');
  expect(result.finalScore).toBe(4);
  expect(result.accepted).toBe(false);
});

test('reducer: a later render with an unparseable critique stops and keeps the prior best', async () => {
  // r0 scores 6; the corrective render r1 comes back unparseable (null) ->
  // the loop stops and returns r0, never the null-scored r1.
  const { result, actions } = await drive([decision({ score: 6, action: { type: 'reroll' } }), null], {
    threshold: 9,
    max: 3,
  });
  expect(actions).toEqual(['reroll']);
  expect(result.image).toBe('r0');
  expect(result.finalScore).toBe(6);
  expect(result.accepted).toBe(false);
  expect(result.journey).toEqual([
    { action: 'initial', score: 6, savedPath: '/out/r0.png' },
    { action: 'reroll', score: 0, savedPath: '/out/r1.png' },
  ]);
});

test('reducer: an invalid proposed action downgrades via the issue classes', async () => {
  // detailer proposed but unavailable; bad_hands issue -> reroll fallback.
  const { result, actions } = await drive(
    [
      decision({ score: 4, action: { type: 'detailer' }, issues: [{ kind: 'bad_hands', scope: 'local' }] }),
      decision({ verdict: 'accept', score: 8 }),
    ],
    { available: [], threshold: 7, max: 2 },
  );
  expect(actions).toEqual(['reroll']);
  expect(result.accepted).toBe(true);
  expect(result.finalScore).toBe(8);
});
