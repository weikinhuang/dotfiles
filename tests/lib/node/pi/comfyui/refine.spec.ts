/**
 * Tests for lib/node/pi/comfyui/refine.ts: the forgiving critic-decision
 * parse, the class-aware validate + downgrade, and the locked engine
 * reducer (accept via verdict / threshold, best-so-far selection, the
 * 1+N iteration cap, plateau-exit, and unparseable -> stop), plus the
 * critic task builder, the model-spec resolver, and the createRefiner
 * adapter's null-on-any-failure / vision-required contract.
 */

import { expect, test } from 'vitest';

import {
  buildCritiqueTask,
  createRefiner,
  type CriticDecision,
  type CritiqueRunResult,
  fallbackFor,
  parseCriticDecision,
  type RefineAction,
  type RefineChannel,
  type Refiner,
  type RefineLoopResult,
  resolveRefineModel,
  runRefineLoop,
  validateAction,
} from '../../../../../lib/node/pi/comfyui/refine.ts';
import { type AgentDef } from '../../../../../lib/node/pi/subagent/loader.ts';

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

// ── Critic task builder ───────────────────────────────────────────────

test('buildCritiqueTask includes the image path, prompt, protocol, context, criteria, and action hint', () => {
  const task = buildCritiqueTask({
    imagePath: '/out/r0.png',
    request: {
      prompt: 'a knight in the rain',
      negative: 'blurry',
      promptProtocol: 'Danbooru tags, comma-separated',
      context: 'It is night; the knight lost an arm last scene.',
      guidance: 'Hands and faces must be clean.',
    },
    availableActions: ['reroll', 'revise_prompt', 'detailer'],
    criteria: 'full body, facing left',
  });
  expect(task).toContain('/out/r0.png');
  expect(task).toContain('a knight in the rain');
  expect(task).toContain('blurry');
  expect(task).toContain('Danbooru tags, comma-separated');
  expect(task).toContain('Background the render was meant to honor');
  expect(task).toContain('lost an arm');
  expect(task).toContain('Hands and faces must be clean.');
  expect(task).toContain('authoritative');
  expect(task).toContain('full body, facing left');
  expect(task).toContain('reroll, revise_prompt, detailer');
  expect(task).toContain('verdict');
});

test('buildCritiqueTask notes derive-from-prompt when no criteria, and prompt-only channels when none available', () => {
  const task = buildCritiqueTask({
    imagePath: '/out/r0.png',
    request: { prompt: 'a cat' },
    availableActions: [],
  });
  expect(task).toContain('No explicit acceptance criteria were given');
  expect(task).toContain('Only the prompt-level channels (reroll, revise_prompt)');
  expect(task).not.toContain('Guidance on what counts as good');
});

// ── Model resolution ──────────────────────────────────────────────────

test('resolveRefineModel normalizes a valid spec and returns null for absent / malformed', () => {
  expect(resolveRefineModel('local/gemma-12b-vision')).toEqual({ refineModel: 'local/gemma-12b-vision' });
  expect(resolveRefineModel(undefined)).toBeNull();
  expect(resolveRefineModel('no-slash')).toBeNull();
});

// ── createRefiner adapter ─────────────────────────────────────────────

interface FakeModel {
  id: string;
}

function fakeCriticAgent(): AgentDef {
  return {
    name: 'comfyui-critic',
    description: 'test',
    tools: ['read'],
    model: 'inherit',
    thinkingLevel: 'low',
    maxTurns: 2,
    timeoutMs: 120000,
    isolation: 'shared-cwd',
    appendSystemPrompt: undefined,
    body: '',
  } as unknown as AgentDef;
}

const refineRegistry = {
  find: (_provider: string, modelId: string): FakeModel | undefined => ({ id: modelId }),
  authStorage: {},
};

const refineCtx = { cwd: '/tmp/x', model: { id: 'parent' } as FakeModel, modelRegistry: refineRegistry };
const visionAll = (): boolean => true;

const sampleInput = {
  imagePath: '/out/r0.png',
  request: { prompt: 'a knight' },
  availableActions: ['reroll', 'revise_prompt'] as RefineChannel[],
};

test('createRefiner: isEnabled is false only when the critic agent is missing', () => {
  const noAgent = createRefiner<FakeModel>({
    settings: null,
    criticAgent: null,
    isVisionModel: visionAll,
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(noAgent.isEnabled()).toBe(false);
  const withAgent = createRefiner<FakeModel>({
    settings: null,
    criticAgent: fakeCriticAgent(),
    isVisionModel: visionAll,
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(withAgent.isEnabled()).toBe(true);
});

test('createRefiner: critique returns the parsed decision on a completed run and passes the image path in the task', async () => {
  const calls: { task: string }[] = [];
  const refiner = createRefiner<FakeModel>({
    settings: null,
    criticAgent: fakeCriticAgent(),
    isVisionModel: visionAll,
    runOneShot: (args) => {
      calls.push({ task: args.task });
      return Promise.resolve({ finalText: '{"verdict":"accept","score":8}', stopReason: 'completed' });
    },
  });
  const decision = await refiner.critique(refineCtx, sampleInput);
  expect(decision).toEqual({ verdict: 'accept', score: 8, assessment: '', issues: [] });
  expect(calls[0].task).toContain('/out/r0.png');
});

test('createRefiner: critique no-ops (null) when the resolved model has no vision capability', async () => {
  const logs: string[] = [];
  const refiner = createRefiner<FakeModel>({
    settings: null,
    criticAgent: fakeCriticAgent(),
    isVisionModel: () => false,
    log: (_level, message) => logs.push(message),
    runOneShot: () => Promise.resolve({ finalText: '{"verdict":"accept","score":8}', stopReason: 'completed' }),
  });
  expect(await refiner.critique(refineCtx, sampleInput)).toBeNull();
  expect(logs[0]).toContain('no vision capability');
});

test('createRefiner: critique returns null for empty path, throw, non-completed, and unparseable output', async () => {
  const base = (result: Promise<CritiqueRunResult>): Refiner<FakeModel> =>
    createRefiner<FakeModel>({
      settings: null,
      criticAgent: fakeCriticAgent(),
      isVisionModel: visionAll,
      runOneShot: () => result,
    });

  expect(
    await base(Promise.resolve({ finalText: '{"verdict":"accept","score":8}', stopReason: 'completed' })).critique(
      refineCtx,
      { ...sampleInput, imagePath: '   ' },
    ),
  ).toBeNull();
  expect(await base(Promise.reject(new Error('boom'))).critique(refineCtx, sampleInput)).toBeNull();
  expect(
    await base(Promise.resolve({ finalText: '{"verdict":"accept"}', stopReason: 'max_turns' })).critique(
      refineCtx,
      sampleInput,
    ),
  ).toBeNull();
  expect(
    await base(Promise.resolve({ finalText: 'not json', stopReason: 'completed' })).critique(refineCtx, sampleInput),
  ).toBeNull();
});

test('createRefiner: critique returns null when model resolution fails', async () => {
  const refiner = createRefiner<FakeModel>({
    settings: { refineModel: 'prov/missing' },
    criticAgent: fakeCriticAgent(),
    isVisionModel: visionAll,
    runOneShot: () => Promise.resolve({ finalText: '{"verdict":"accept","score":8}', stopReason: 'completed' }),
  });
  const badCtx = {
    cwd: '/tmp/x',
    model: { id: 'parent' } as FakeModel,
    modelRegistry: { find: () => undefined, authStorage: {} },
  };
  expect(await refiner.critique(badCtx, sampleInput)).toBeNull();
});

test('createRefiner: critique distinguishes an internal timeout from a parent-turn cancellation', async () => {
  const aborted = { finalText: '', stopReason: 'aborted' as const };

  const timeoutLogs: string[] = [];
  const onTimeout = createRefiner<FakeModel>({
    settings: null,
    criticAgent: fakeCriticAgent(),
    isVisionModel: visionAll,
    timeoutMs: 12345,
    log: (_level, message) => timeoutLogs.push(message),
    runOneShot: () => Promise.resolve(aborted),
  });
  expect(await onTimeout.critique(refineCtx, sampleInput)).toBeNull();
  expect(timeoutLogs[0]).toContain('timed out after 12345ms');

  const cancelLogs: string[] = [];
  const onCancel = createRefiner<FakeModel>({
    settings: null,
    criticAgent: fakeCriticAgent(),
    isVisionModel: visionAll,
    log: (_level, message) => cancelLogs.push(message),
    runOneShot: () => Promise.resolve(aborted),
  });
  expect(await onCancel.critique({ ...refineCtx, signal: AbortSignal.abort() }, sampleInput)).toBeNull();
  expect(cancelLogs[0]).toContain('parent turn ended');
});
