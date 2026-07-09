/**
 * Tests for the auto-summarization module (`summarize.ts`): pure
 * helpers (span rendering, trigger, validation, record shaping), the
 * settings resolver, and the adapter's null-on-any-failure contract.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { type AgentDef } from '../../../../../lib/node/pi/subagent/loader.ts';
import {
  AUTO_SUMMARY_ID,
  buildSummarizeTask,
  composeAutoSummaryRecord,
  createSummarizer,
  planSummarization,
  renderSpan,
  resolveSummarizeSettings,
  type SummarizableMessage,
  type SummarizeRunResult,
  validateSummary,
} from '../../../../../lib/node/pi/roleplay/summarize.ts';

// ── Pure helpers ──────────────────────────────────────────────────────

test('renderSpan joins role-prefixed lines and skips empty text', () => {
  const msgs: SummarizableMessage[] = [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: '  ' },
    { role: 'assistant', text: 'hi there' },
  ];
  expect(renderSpan(msgs, 1000)).toBe('user: hello\n\nassistant: hi there');
});

test('renderSpan head-truncates the oldest lines when over the char cap', () => {
  const msgs: SummarizableMessage[] = [
    { role: 'user', text: 'A'.repeat(100) },
    { role: 'assistant', text: 'B'.repeat(100) },
    { role: 'user', text: 'tail' },
  ];
  const out = renderSpan(msgs, 60);
  expect(out.startsWith('[...earlier turns omitted...]')).toBe(true);
  expect(out).toContain('user: tail');
  expect(out).not.toContain('A'.repeat(100));
});

test('renderSpan always keeps the newest line (truncated) when every line overflows', () => {
  const msgs: SummarizableMessage[] = [
    { role: 'user', text: 'A'.repeat(500) },
    { role: 'assistant', text: 'B'.repeat(500) },
  ];
  // Budget smaller than any single line: must not degrade to just the marker.
  const out = renderSpan(msgs, 80);
  expect(out.startsWith('[...earlier turns omitted...]')).toBe(true);
  expect(out.length).toBeGreaterThan('[...earlier turns omitted...]'.length + 2);
  // The retained content comes from the newest (assistant) line.
  expect(out).toContain('assistant: ');
  expect(out).toContain('B');
});

test('planSummarization returns null below the minimum non-empty count', () => {
  const msgs: SummarizableMessage[] = [
    { role: 'user', text: 'one' },
    { role: 'assistant', text: '' },
    { role: 'user', text: 'two' },
  ];
  expect(planSummarization(msgs, { minMessages: 3 })).toBeNull();
});

test('planSummarization returns the rendered span + non-empty count when it fires', () => {
  const msgs: SummarizableMessage[] = [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'b' },
    { role: 'user', text: 'c' },
    { role: 'assistant', text: 'd' },
  ];
  const plan = planSummarization(msgs, { minMessages: 4 });
  expect(plan).not.toBeNull();
  expect(plan?.messageCount).toBe(4);
  expect(plan?.spanText).toContain('user: a');
});

test('planSummarization default minimum is 4', () => {
  const three: SummarizableMessage[] = [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'b' },
    { role: 'user', text: 'c' },
  ];
  expect(planSummarization(three)).toBeNull();
});

test('buildSummarizeTask folds in a prior recap only when present', () => {
  const withPrior = buildSummarizeTask('NEW SPAN', 'OLD RECAP');
  expect(withPrior).toContain('OLD RECAP');
  expect(withPrior).toContain('NEW SPAN');
  expect(withPrior).toContain('null');

  const without = buildSummarizeTask('NEW SPAN', '   ');
  expect(without).not.toContain('Existing running recap');
  expect(without).toContain('NEW SPAN');
});

test('validateSummary rejects empty, null sentinel, and over-cap; trims otherwise', () => {
  expect(validateSummary('   ', 1000)).toBeNull();
  expect(validateSummary('null', 1000)).toBeNull();
  expect(validateSummary('X'.repeat(50), 10)).toBeNull();
  expect(validateSummary('  a recap.  ', 1000)).toBe('a recap.');
});

test('composeAutoSummaryRecord shapes a rolling auto record with a dated description', () => {
  const rec = composeAutoSummaryRecord('  the scene so far  ', new Date('2026-06-07T10:00:00Z'));
  expect(rec.id).toBe(AUTO_SUMMARY_ID);
  expect(rec.id).toBe('auto');
  expect(rec.body).toBe('the scene so far');
  expect(rec.description).toContain('2026-06-07');
});

// ── Settings resolution ───────────────────────────────────────────────

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rp-sum-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'rp-sum-cwd-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('resolveSummarizeSettings returns null when nothing is configured', () => {
  expect(resolveSummarizeSettings({ cwd, home })).toBeNull();
});

test('resolveSummarizeSettings reads the project file first', () => {
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'roleplay-summarize.json'), JSON.stringify({ summarizeModel: 'prov/proj-model' }));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ roleplay: { summarizeModel: 'prov/user-model' } }),
  );
  const out = resolveSummarizeSettings({ cwd, home });
  expect(out?.summarizeModel).toBe('prov/proj-model');
});

test('resolveSummarizeSettings falls back to settings.json roleplay.summarizeModel', () => {
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ roleplay: { summarizeModel: 'prov/settings-model' } }),
  );
  const out = resolveSummarizeSettings({ cwd, home });
  expect(out?.summarizeModel).toBe('prov/settings-model');
});

test('resolveSummarizeSettings ignores a malformed model spec', () => {
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'roleplay-summarize.json'), JSON.stringify({ summarizeModel: 'no-slash' }));
  expect(resolveSummarizeSettings({ cwd, home })).toBeNull();
});

// ── Adapter ───────────────────────────────────────────────────────────

function fakeAgent(): AgentDef {
  return {
    name: 'roleplay-summarizer',
    description: 'test',
    tools: [],
    model: 'inherit',
    thinkingLevel: undefined,
    maxTurns: 1,
    timeoutMs: 60000,
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

function ranOnce(result: SummarizeRunResult): {
  run: (args: { task: string }) => Promise<SummarizeRunResult>;
  calls: { task: string }[];
} {
  const calls: { task: string }[] = [];
  const run = (args: { task: string }): Promise<SummarizeRunResult> => {
    calls.push({ task: args.task });
    return Promise.resolve(result);
  };
  return { run, calls };
}

test('isEnabled is false when settings or agent is missing', () => {
  const noSettings = createSummarizer<FakeModel>({
    settings: null,
    summarizerAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(noSettings.isEnabled()).toBe(false);
  const noAgent = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: null,
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(noAgent.isEnabled()).toBe(false);
});

test('summarize returns the recap on a completed run and folds the prior into the task', async () => {
  const { run, calls } = ranOnce({ finalText: '  A tidy recap.  ', stopReason: 'completed' });
  const s = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'prov/model-x', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: run,
  });
  const out = await s.summarize(ctx, 'span text', 'prior recap');
  expect(out).toBe('A tidy recap.');
  expect(calls[0].task).toContain('prior recap');
  expect(calls[0].task).toContain('span text');
});

test('summarize returns null for an empty span without spawning', async () => {
  const { run, calls } = ranOnce({ finalText: 'x', stopReason: 'completed' });
  const s = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: run,
  });
  expect(await s.summarize(ctx, '   ')).toBeNull();
  expect(calls).toHaveLength(0);
});

test('summarize returns null when model resolution fails', async () => {
  const { run } = ranOnce({ finalText: 'x', stopReason: 'completed' });
  const s = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'prov/missing', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: run,
  });
  // registry.find returns undefined for every lookup here
  const badCtx = {
    cwd: '/tmp/x',
    model: { id: 'parent' } as FakeModel,
    modelRegistry: { find: () => undefined, authStorage: {} },
  };
  expect(await s.summarize(badCtx, 'span')).toBeNull();
});

test('summarize returns null on a non-completed stop reason', async () => {
  const { run } = ranOnce({ finalText: 'partial', stopReason: 'max_turns', errorMessage: 'hit cap' });
  const s = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: run,
  });
  expect(await s.summarize(ctx, 'span')).toBeNull();
});

test('summarize returns null when the run throws', async () => {
  const s = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: () => Promise.reject(new Error('boom')),
  });
  expect(await s.summarize(ctx, 'span')).toBeNull();
});

test('summarize returns null on the null sentinel and on over-cap output', async () => {
  const sentinel = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: 'null', stopReason: 'completed' }),
  });
  expect(await sentinel.summarize(ctx, 'span')).toBeNull();

  const overCap = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    maxOutputChars: 10,
    runOneShot: () => Promise.resolve({ finalText: 'X'.repeat(50), stopReason: 'completed' }),
  });
  expect(await overCap.summarize(ctx, 'span')).toBeNull();
});
