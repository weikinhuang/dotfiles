/**
 * Tests for lib/node/pi/comfyui/enhance.ts: the task builder, the
 * adversarial tolerant parse, the model resolver, and the enhancer's
 * null-on-any-failure / inherit-parent-model contract.
 */

import { expect, test } from 'vitest';

import {
  buildEnhanceTask,
  createEnhancer,
  type EnhanceRunResult,
  type Enhancer,
  parseEnhanceResult,
  resolveEnhanceModel,
} from '../../../../../lib/node/pi/comfyui/enhance.ts';
import { type AgentDef } from '../../../../../lib/node/pi/subagent/loader.ts';

// ── Task builder ──────────────────────────────────────────────────────

test('buildEnhanceTask includes guidance, protocol, context, prompt, negative, JSON contract', () => {
  const task = buildEnhanceTask({
    prompt: 'a knight',
    negative: 'blurry',
    guidance: 'Use booru tags.',
    promptProtocol: 'Danbooru tags, comma-separated',
    context: 'It is night; the knight lost an arm last scene.',
  });
  expect(task).toContain('Use booru tags.');
  expect(task).toContain('Danbooru tags, comma-separated');
  expect(task).toContain('Background to honor');
  expect(task).toContain('lost an arm');
  expect(task).toContain('a knight');
  expect(task).toContain('blurry');
  expect(task).toContain('"prompt"');
});

test('buildEnhanceTask falls back to description/tags when no guidance doc', () => {
  const task = buildEnhanceTask({
    prompt: 'a cat',
    description: 'anime / illustration',
    tags: ['anime', 'sdxl', '  '],
  });
  expect(task).toContain('Target workflow: anime / illustration');
  expect(task).toContain('Workflow tags: anime, sdxl');
  expect(task).not.toContain('Guidance for prompting');
});

test('buildEnhanceTask notes an absent baseline negative', () => {
  const task = buildEnhanceTask({ prompt: 'a dog' });
  expect(task).toContain('Baseline negative prompt:\n(none)');
});

// ── Tolerant parse ────────────────────────────────────────────────────

test('parseEnhanceResult: clean JSON', () => {
  expect(parseEnhanceResult('{"prompt":"a","negative":"b"}', 100)).toEqual({ prompt: 'a', negative: 'b' });
});

test('parseEnhanceResult: fenced (tagged and untagged)', () => {
  expect(parseEnhanceResult('```json\n{"prompt":"a"}\n```', 100)).toEqual({ prompt: 'a' });
  expect(parseEnhanceResult('```\n{"prompt":"a"}\n```', 100)).toEqual({ prompt: 'a' });
});

test('parseEnhanceResult: prose-wrapped + trailing commentary', () => {
  expect(parseEnhanceResult('Here you go: {"prompt":"a","negative":"b"} hope that helps!', 100)).toEqual({
    prompt: 'a',
    negative: 'b',
  });
});

test('parseEnhanceResult: nested braces inside string values stay balanced', () => {
  expect(parseEnhanceResult('{"prompt":"a {glow} b","negative":"x"}', 100)).toEqual({
    prompt: 'a {glow} b',
    negative: 'x',
  });
});

test('parseEnhanceResult: caps both fields to maxChars', () => {
  const out = parseEnhanceResult(JSON.stringify({ prompt: 'P'.repeat(50), negative: 'N'.repeat(50) }), 10);
  expect(out?.prompt.length).toBe(10);
  expect(out?.negative?.length).toBe(10);
});

test('parseEnhanceResult: negative omitted vs empty', () => {
  expect(parseEnhanceResult('{"prompt":"a"}', 100)).toEqual({ prompt: 'a' });
  expect(parseEnhanceResult('{"prompt":"a","negative":"   "}', 100)).toEqual({ prompt: 'a' });
});

test('parseEnhanceResult: ignores extra keys', () => {
  expect(parseEnhanceResult('{"prompt":"a","seed":5,"foo":true}', 100)).toEqual({ prompt: 'a' });
});

test('parseEnhanceResult: failures return null', () => {
  expect(parseEnhanceResult('', 100)).toBeNull();
  expect(parseEnhanceResult('   ', 100)).toBeNull();
  expect(parseEnhanceResult('just some prose, no json', 100)).toBeNull();
  expect(parseEnhanceResult('{"prompt": 42}', 100)).toBeNull();
  expect(parseEnhanceResult('{"negative":"b"}', 100)).toBeNull();
  expect(parseEnhanceResult('{"prompt":"   "}', 100)).toBeNull();
  expect(parseEnhanceResult('{"prompt":"a"', 100)).toBeNull();
  expect(parseEnhanceResult('[1,2,3]', 100)).toBeNull();
});

// ── Model resolution ──────────────────────────────────────────────────

test('resolveEnhanceModel validates a provider/model spec', () => {
  expect(resolveEnhanceModel('openai/gpt-4o-mini')).toEqual({ enhanceModel: 'openai/gpt-4o-mini' });
  expect(resolveEnhanceModel(undefined)).toBeNull();
  expect(resolveEnhanceModel('no-slash')).toBeNull();
});

// ── Adapter ───────────────────────────────────────────────────────────

function fakeAgent(): AgentDef {
  return {
    name: 'comfyui-enhance',
    description: 'test',
    tools: [],
    model: 'inherit',
    thinkingLevel: undefined,
    maxTurns: 1,
    timeoutMs: 30000,
    isolation: 'shared-cwd',
    appendSystemPrompt: undefined,
    body: '',
  } as unknown as AgentDef;
}

interface FakeModel {
  id: string;
}

const registry = {
  find: (_provider: string, modelId: string): FakeModel | undefined => ({ id: modelId }),
  authStorage: {},
};

const ctx = { cwd: '/tmp/x', model: { id: 'parent' } as FakeModel, modelRegistry: registry };

test('isEnabled is false only when the agent is missing', () => {
  const noAgent = createEnhancer<FakeModel>({
    settings: null,
    enhanceAgent: null,
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(noAgent.isEnabled()).toBe(false);
  const withAgent = createEnhancer<FakeModel>({
    settings: null,
    enhanceAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(withAgent.isEnabled()).toBe(true);
});

test('enhance returns the parsed result on a completed run', async () => {
  const calls: { task: string }[] = [];
  const enh = createEnhancer<FakeModel>({
    settings: null,
    enhanceAgent: fakeAgent(),
    runOneShot: (args) => {
      calls.push({ task: args.task });
      return Promise.resolve({ finalText: '{"prompt":"1girl, solo","negative":"lowres"}', stopReason: 'completed' });
    },
  });
  expect(await enh.enhance(ctx, 'enhance this')).toEqual({ prompt: '1girl, solo', negative: 'lowres' });
  expect(calls[0].task).toBe('enhance this');
});

test('enhance returns null for empty task, throw, non-completed, and unparseable output', async () => {
  const base = (result: Promise<EnhanceRunResult>): Enhancer<FakeModel> =>
    createEnhancer<FakeModel>({ settings: null, enhanceAgent: fakeAgent(), runOneShot: () => result });

  expect(
    await base(Promise.resolve({ finalText: '{"prompt":"a"}', stopReason: 'completed' })).enhance(ctx, '  '),
  ).toBeNull();
  expect(await base(Promise.reject(new Error('boom'))).enhance(ctx, 'task')).toBeNull();
  expect(
    await base(Promise.resolve({ finalText: '{"prompt":"a"}', stopReason: 'max_turns' })).enhance(ctx, 'task'),
  ).toBeNull();
  expect(
    await base(Promise.resolve({ finalText: 'not json', stopReason: 'completed' })).enhance(ctx, 'task'),
  ).toBeNull();
});

test('enhance returns null when model resolution fails', async () => {
  const enh = createEnhancer<FakeModel>({
    settings: { enhanceModel: 'prov/missing' },
    enhanceAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: '{"prompt":"a"}', stopReason: 'completed' }),
  });
  const badCtx = {
    cwd: '/tmp/x',
    model: { id: 'parent' } as FakeModel,
    modelRegistry: { find: () => undefined, authStorage: {} },
  };
  expect(await enh.enhance(badCtx, 'task')).toBeNull();
});

test('enhance emits a debug log on success and an info log on parse failure', async () => {
  const logs: { level: string; message: string }[] = [];
  const log = (level: 'debug' | 'info' | 'warn', message: string): void => {
    logs.push({ level, message });
  };

  const ok = createEnhancer<FakeModel>({
    settings: null,
    enhanceAgent: fakeAgent(),
    log,
    runOneShot: () => Promise.resolve({ finalText: '{"prompt":"1girl"}', stopReason: 'completed' }),
  });
  await ok.enhance(ctx, 'task');
  expect(logs).toEqual([{ level: 'debug', message: 'enhanced \u2192 1girl' }]);

  logs.length = 0;
  const bad = createEnhancer<FakeModel>({
    settings: null,
    enhanceAgent: fakeAgent(),
    log,
    runOneShot: () => Promise.resolve({ finalText: 'not json', stopReason: 'completed' }),
  });
  await bad.enhance(ctx, 'task');
  expect(logs).toEqual([{ level: 'info', message: 'produced no usable JSON; keeping the original prompt' }]);
});

test('enhance distinguishes an internal timeout from a parent-turn cancellation', async () => {
  const aborted = { finalText: '', stopReason: 'aborted' as const };

  // Parent signal still live → the enhancer's own wall-clock timeout fired.
  const timeoutLogs: string[] = [];
  const onTimeout = createEnhancer<FakeModel>({
    settings: null,
    enhanceAgent: fakeAgent(),
    timeoutMs: 12345,
    log: (_level, message) => timeoutLogs.push(message),
    runOneShot: () => Promise.resolve(aborted),
  });
  expect(await onTimeout.enhance(ctx, 'task')).toBeNull();
  expect(timeoutLogs[0]).toContain('timed out after 12345ms');

  // Parent signal aborted → the turn ended before the enhancer finished.
  const cancelLogs: string[] = [];
  const onCancel = createEnhancer<FakeModel>({
    settings: null,
    enhanceAgent: fakeAgent(),
    log: (_level, message) => cancelLogs.push(message),
    runOneShot: () => Promise.resolve(aborted),
  });
  const cancelledCtx = { ...ctx, signal: AbortSignal.abort() };
  expect(await onCancel.enhance(cancelledCtx, 'task')).toBeNull();
  expect(cancelLogs[0]).toContain('parent turn ended');
});
