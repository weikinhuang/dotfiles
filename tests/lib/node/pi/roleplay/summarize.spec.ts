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
  DEFAULT_SUMMARY_GUIDANCE,
  planSummarization,
  renderSpan,
  resolveSummarizeSettings,
  type SummarizableMessage,
  type SummarizeRunResult,
  clampSummary,
  validateSummary,
  type SummarizerWiring,
} from '../../../../../lib/node/pi/roleplay/summarize.ts';
import { readSummaryAttempt } from '../../../../../lib/node/pi/roleplay/summary-attempt.ts';

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

test('buildSummarizeTask uses default guidance, and an override replaces it while keeping the contract', () => {
  const dflt = buildSummarizeTask('NEW SPAN');
  expect(dflt).toContain(DEFAULT_SUMMARY_GUIDANCE);

  const overridden = buildSummarizeTask('NEW SPAN', undefined, 'Recap ONLY the combat outcomes.');
  expect(overridden).toContain('Recap ONLY the combat outcomes.');
  expect(overridden).not.toContain(DEFAULT_SUMMARY_GUIDANCE);
  // Faithful-only contract + null sentinel + span stay builder-owned.
  expect(overridden).toContain('never invent');
  expect(overridden).toContain('null');
  expect(overridden).toContain('NEW SPAN');

  // Blank override falls back to the default.
  expect(buildSummarizeTask('NEW SPAN', undefined, '   ')).toContain(DEFAULT_SUMMARY_GUIDANCE);
});

test('validateSummary rejects empty, null sentinel, and over-cap; trims otherwise', () => {
  expect(validateSummary('   ', 1000)).toBeNull();
  expect(validateSummary('null', 1000)).toBeNull();
  expect(validateSummary('X'.repeat(50), 10)).toBeNull();
  expect(validateSummary('  a recap.  ', 1000)).toBe('a recap.');
});

test('clampSummary salvages an over-cap recap at a natural boundary (forced-path only helper)', () => {
  // Empty / null sentinel: nothing usable, mirrors validateSummary.
  expect(clampSummary('   ', 1000)).toBeNull();
  expect(clampSummary('null', 1000)).toBeNull();
  expect(clampSummary('anything', 0)).toBeNull();
  // Under cap: returned unchanged (trimmed).
  expect(clampSummary('  a recap.  ', 1000)).toBe('a recap.');
  // Over cap with a sentence boundary in the back half: clamp at the sentence.
  const two = 'First sentence here. Second sentence goes on and on and on.';
  const clampedSentence = clampSummary(two, 25);
  expect(clampedSentence).toBe('First sentence here.');
  expect(clampedSentence!.length).toBeLessThanOrEqual(25);
  // Over cap, no sentence boundary but a word boundary: clamp on the word.
  const words = 'alpha beta gamma delta epsilon zeta';
  const clampedWord = clampSummary(words, 20);
  expect(clampedWord).toBe('alpha beta gamma');
  expect(clampedWord!.length).toBeLessThanOrEqual(20);
  // No usable boundary near the end (one long token): hard clamp to the cap.
  const long = 'X'.repeat(50);
  const clampedHard = clampSummary(long, 10);
  expect(clampedHard).toBe('X'.repeat(10));
  expect(clampedHard!.length).toBe(10);
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

const ctx = { cwd: '/tmp/x', model: { id: 'parent' }, modelRegistry: registry };

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
    model: { id: 'parent' },
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

test('summarizeDetailed surfaces the raw over-cap text so the forced path can salvage it', async () => {
  const overCap = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    maxOutputChars: 10,
    runOneShot: () => Promise.resolve({ finalText: '  a long over-cap recap.  ', stopReason: 'completed' }),
  });
  const detailed = await overCap.summarizeDetailed(ctx, 'span');
  // Validated recap is dropped (over cap), but the raw trimmed text survives.
  expect(detailed.recap).toBeNull();
  expect(detailed.raw).toBe('a long over-cap recap.');

  // The null sentinel and a spawn failure yield raw=null (nothing to salvage).
  const sentinel = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: 'null', stopReason: 'completed' }),
  });
  expect(await sentinel.summarizeDetailed(ctx, 'span')).toEqual({
    recap: null,
    raw: null,
    attempt: {
      targetChars: 1000,
      maxChars: 1500,
      minChars: 0,
      priorChars: 0,
      outputChars: 4,
      reason: 'null-response',
      attempts: [{ reason: 'null-response', outputChars: 4 }],
    },
  });

  const failed = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: 'partial', stopReason: 'max_turns' }),
  });
  expect(await failed.summarizeDetailed(ctx, 'span')).toEqual({
    recap: null,
    raw: null,
    attempt: {
      targetChars: 1000,
      maxChars: 1500,
      minChars: 0,
      priorChars: 0,
      outputChars: 0,
      reason: 'child-failed',
      attempts: [{ reason: 'child-failed', outputChars: 0 }],
    },
  });

  // Under cap: recap and raw agree.
  const ok = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: '  tidy recap.  ', stopReason: 'completed' }),
  });
  expect(await ok.summarizeDetailed(ctx, 'span')).toEqual({
    recap: 'tidy recap.',
    raw: 'tidy recap.',
    attempt: {
      targetChars: 1000,
      maxChars: 1500,
      minChars: 0,
      priorChars: 0,
      outputChars: 11,
      reason: 'accepted',
      attempts: [{ reason: 'accepted', outputChars: 11 }],
    },
  });
});

test('the summarizer child uses the agent frontmatter timeoutMs unless the wiring overrides it', async () => {
  const seen: (number | undefined)[] = [];
  const run = (args: { timeoutMs?: number }): Promise<SummarizeRunResult> => {
    seen.push(args.timeoutMs);
    return Promise.resolve({ finalText: 'RECAP', stopReason: 'completed' });
  };
  const slow: AgentDef = { ...fakeAgent(), timeoutMs: 300000 };
  await createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: slow,
    runOneShot: run,
  }).summarize(ctx, 'span');
  await createSummarizer<FakeModel>({
    settings: { summarizeModel: 'p/m', source: 's' },
    summarizerAgent: slow,
    runOneShot: run,
    timeoutMs: 1234,
  }).summarize(ctx, 'span');
  expect(seen).toEqual([300000, 1234]);
});

// Only scripted child results and synthetic spans are used below.
function scriptedSummarizer(
  results: (SummarizeRunResult | Error)[],
  overrides: Partial<SummarizerWiring<FakeModel>> = {},
): { summarizer: ReturnType<typeof createSummarizer<FakeModel>>; tasks: string[] } {
  const tasks: string[] = [];
  const summarizer = createSummarizer<FakeModel>({
    settings: { summarizeModel: 'private/model', source: 'private settings' },
    summarizerAgent: fakeAgent(),
    maxOutputChars: 30,
    runOneShot: (args) => {
      tasks.push(args.task);
      const result = results[tasks.length - 1];
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result ?? { finalText: '', stopReason: 'error' });
    },
    ...overrides,
  });
  return { summarizer, tasks };
}

function completed(finalText: string): SummarizeRunResult {
  return { finalText, stopReason: 'completed' };
}

test('numeric character contract follows custom guidance and cannot be replaced by it', () => {
  const task = buildSummarizeTask('SPAN', 'PRIOR', 'Use 9000 tokens and append.', {
    targetChars: 80,
    maxChars: 100,
    minChars: 20,
  });
  expect(task).toContain('Aim to stay within 80 characters (soft target)');
  expect(task).toContain('Do not pad to reach the target');
  expect(task).toContain('never exceed 100 characters (hard maximum)');
  expect(task).toContain('at least 20 characters');
  expect(task).toContain('CHARACTERS, not tokens');
  expect(task).toContain('rewrite ONE cumulative recap, do not append');
  expect(task).toContain('takes precedence over any guidance above');
  expect(task.indexOf('Fixed output contract')).toBeGreaterThan(task.indexOf('Use 9000 tokens and append.'));
  expect(task).toContain('never invent');
  expect(task).toContain('literal string null');
});

test('soft-target miss within the hard cap is accepted on the first attempt', async () => {
  const { summarizer, tasks } = scriptedSummarizer([completed('R'.repeat(25))]);
  const result = await summarizer.summarizeDetailed(ctx, 'private span', '  old  ', 'private guidance');
  expect(result).toEqual({
    recap: 'R'.repeat(25),
    raw: 'R'.repeat(25),
    attempt: {
      targetChars: 20,
      maxChars: 30,
      minChars: 2,
      priorChars: 3,
      outputChars: 25,
      reason: 'accepted',
      attempts: [{ reason: 'accepted', outputChars: 25 }],
    },
  });
  expect(tasks).toHaveLength(1);
  expect(readSummaryAttempt(result.attempt)).toEqual(result.attempt);
  const safe = JSON.stringify(result.attempt);
  for (const secret of ['private span', 'old', 'private guidance', 'private/model', 'private settings', 'RRR']) {
    expect(safe).not.toContain(secret);
  }
});

test('per-call limits override cached wiring on both summarize APIs, including target=0 auto', async () => {
  const { summarizer, tasks } = scriptedSummarizer(
    [completed('R'.repeat(40)), completed('R'.repeat(40)), completed('ok')],
    { maxOutputChars: 10, targetOutputChars: 4 },
  );
  expect(await summarizer.summarize(ctx, 'span', undefined, undefined, { maxChars: 60, targetChars: 0 })).toBe(
    'R'.repeat(40),
  );
  const next = await summarizer.summarizeDetailed(ctx, 'span', undefined, undefined, {
    maxChars: 50,
    targetChars: 900,
  });
  expect(next.attempt?.targetChars).toBe(50);
  expect(next.attempt?.maxChars).toBe(50);
  const fallback = await summarizer.summarizeDetailed(ctx, 'span');
  expect(fallback.attempt?.maxChars).toBe(10);
  expect(fallback.attempt?.targetChars).toBe(4);
  expect(tasks).toHaveLength(3);
  expect(tasks[0]).toContain('Aim to stay within 40 characters');
});

test('factory always sends default numeric limits even with custom guidance', async () => {
  const { summarizer, tasks } = scriptedSummarizer([completed('ok')], { maxOutputChars: undefined });
  const result = await summarizer.summarizeDetailed(ctx, 'span', undefined, 'Custom coverage');
  expect(tasks[0]).toContain('Aim to stay within 1000 characters');
  expect(tasks[0]).toContain('never exceed 1500 characters');
  expect(result.attempt?.maxChars).toBe(1500);
});

test('over-hard output gets exactly one compact rewrite of original inputs with length only', async () => {
  const draft = 'UNTRUSTED-DRAFT'.repeat(20);
  const { summarizer, tasks } = scriptedSummarizer([completed(draft), completed('A compact recap.')]);
  const result = await summarizer.summarizeDetailed(ctx, 'ORIGINAL SPAN', 'ORIGINAL PRIOR');
  expect(result.recap).toBe('A compact recap.');
  expect(result.raw).toBe('A compact recap.');
  expect(result.attempt?.reason).toBe('accepted');
  expect(result.attempt?.attempts).toEqual([
    { reason: 'over-limit', outputChars: draft.length },
    { reason: 'accepted', outputChars: 16 },
  ]);
  expect(tasks).toHaveLength(2);
  expect(tasks[1].startsWith(tasks[0])).toBe(true);
  expect(tasks[1]).toContain('ORIGINAL SPAN');
  expect(tasks[1]).toContain('ORIGINAL PRIOR');
  expect(tasks[1]).toContain(`previous output was ${draft.length} characters`);
  expect(tasks[1]).toContain('compact, information-dense prose');
  expect(tasks[1]).not.toContain('UNTRUSTED-DRAFT');
});

test('two over-hard outputs stop at two attempts and preserve the better raw recap without truncation', async () => {
  const { summarizer, tasks } = scriptedSummarizer([completed('A'.repeat(100)), completed('B'.repeat(40))]);
  const result = await summarizer.summarizeDetailed(ctx, 'span');
  expect(result.recap).toBeNull();
  expect(result.raw).toBe('B'.repeat(40));
  expect(result.attempt?.reason).toBe('over-limit');
  expect(result.attempt?.outputChars).toBe(40);
  expect(result.attempt?.attempts).toEqual([
    { reason: 'over-limit', outputChars: 100 },
    { reason: 'over-limit', outputChars: 40 },
  ]);
  expect(tasks).toHaveLength(2);
});

test('prior-collapse floor is rounded up and raises the soft target; a collapsed recap retries once', async () => {
  const { summarizer, tasks } = scriptedSummarizer([completed('tiny'), completed('R'.repeat(26))], {
    targetOutputChars: 5,
  });
  const result = await summarizer.summarizeDetailed(ctx, 'span', `  ${'P'.repeat(51)}  `);
  expect(result.recap).toBe('R'.repeat(26));
  expect(result.attempt?.minChars).toBe(26);
  expect(result.attempt?.targetChars).toBe(26);
  expect(result.attempt?.priorChars).toBe(51);
  expect(result.attempt?.attempts).toEqual([
    { reason: 'collapsed', outputChars: 4 },
    { reason: 'accepted', outputChars: 26 },
  ]);
  expect(tasks).toHaveLength(2);
  expect(tasks[1]).toContain('collapsed below the minimum');
});

test('repeated collapse fails rather than weakening the prior floor', async () => {
  const { summarizer, tasks } = scriptedSummarizer([completed('tiny'), completed('still tiny')]);
  const result = await summarizer.summarizeDetailed(ctx, 'span', 'P'.repeat(51));
  expect(result.recap).toBeNull();
  expect(result.raw).toBe('still tiny');
  expect(result.attempt?.reason).toBe('collapsed');
  expect(result.attempt?.attempts).toHaveLength(2);
  expect(tasks).toHaveLength(2);
});

test.each([
  [completed(''), 'no-output', 0],
  [completed('   '), 'no-output', 0],
  [completed('  null  '), 'null-response', 4],
  [{ finalText: 'private partial', stopReason: 'aborted' }, 'cancelled', 0],
  [{ finalText: 'private partial', stopReason: 'error', errorMessage: 'private provider error' }, 'child-failed', 0],
  [new Error('private thrown error'), 'child-failed', 0],
] as const)('no retry on non-sizing failure %#', async (first, reason, outputChars) => {
  const { summarizer, tasks } = scriptedSummarizer([first]);
  const result = await summarizer.summarizeDetailed(ctx, 'span');
  expect(result.recap).toBeNull();
  expect(result.raw).toBeNull();
  expect(result.attempt?.reason).toBe(reason);
  expect(result.attempt?.attempts).toEqual([{ reason, outputChars }]);
  expect(tasks).toHaveLength(1);
  expect(JSON.stringify(result.attempt)).not.toContain('private');
});

test.each([
  completed(''),
  completed('null'),
  new Error('private error'),
  { finalText: 'private partial', stopReason: 'aborted' },
])('rewrite failure %# retains the first nonempty raw output for forced salvage', async (second) => {
  const draft = 'R'.repeat(45);
  const { summarizer, tasks } = scriptedSummarizer([completed(draft), second]);
  const result = await summarizer.summarizeDetailed(ctx, 'span');
  expect(result.recap).toBeNull();
  expect(result.raw).toBe(draft);
  expect(result.attempt?.attempts).toHaveLength(2);
  expect(readSummaryAttempt(result.attempt)).toEqual(result.attempt);
  expect(tasks).toHaveLength(2);
});

test('disabled, empty, conflicting and unavailable-model cases never spawn', async () => {
  const disabled = scriptedSummarizer([], { settings: null });
  const empty = scriptedSummarizer([]);
  const conflict = scriptedSummarizer([]);
  const unavailable = scriptedSummarizer([]);
  const results = [
    await disabled.summarizer.summarizeDetailed(ctx, 'span'),
    await empty.summarizer.summarizeDetailed(ctx, '   '),
    await conflict.summarizer.summarizeDetailed(ctx, 'span', 'P'.repeat(61)),
    await unavailable.summarizer.summarizeDetailed(
      {
        ...ctx,
        modelRegistry: { find: () => undefined, authStorage: {} },
      },
      'span',
    ),
  ];
  expect(results.map((result) => result.attempt?.reason)).toEqual([
    'disabled',
    'empty-span',
    'constraints-conflict',
    'model-unavailable',
  ]);
  for (const result of results) {
    expect(result.recap).toBeNull();
    expect(result.raw).toBeNull();
    expect(result.attempt?.attempts).toEqual([]);
    expect(readSummaryAttempt(result.attempt)).toEqual(result.attempt);
  }
  expect(results[2].attempt?.minChars).toBe(31);
  expect(results[2].attempt?.maxChars).toBe(30);
  for (const script of [disabled, empty, conflict, unavailable]) expect(script.tasks).toHaveLength(0);
});

test('pre-aborted signal never spawns and an abort during the first run never issues a retry', async () => {
  const controller = new AbortController();
  controller.abort();
  const before = scriptedSummarizer([]);
  const pre = await before.summarizer.summarizeDetailed({ ...ctx, signal: controller.signal }, 'span');
  expect(pre.attempt?.reason).toBe('cancelled');
  expect(pre.attempt?.attempts).toEqual([]);
  expect(before.tasks).toHaveLength(0);

  const during = new AbortController();
  let runs = 0;
  const { summarizer } = scriptedSummarizer([], {
    runOneShot: () => {
      runs++;
      during.abort();
      return Promise.resolve(completed('R'.repeat(100)));
    },
  });
  const result = await summarizer.summarizeDetailed({ ...ctx, signal: during.signal }, 'span');
  expect(result.recap).toBeNull();
  expect(result.attempt?.reason).toBe('cancelled');
  expect(result.attempt?.attempts).toEqual([{ reason: 'cancelled', outputChars: 0 }]);
  expect(runs).toBe(1);
});

test('hard-cap and prior-floor equality are accepted without a retry', async () => {
  const { summarizer, tasks } = scriptedSummarizer([completed('R'.repeat(30))]);
  const result = await summarizer.summarizeDetailed(ctx, 'span', 'P'.repeat(60));
  expect(result.recap).toBe('R'.repeat(30));
  expect(result.attempt?.minChars).toBe(30);
  expect(result.attempt?.targetChars).toBe(30);
  expect(tasks).toHaveLength(1);
});

test('a collapsed rewrite does not replace an over-cap draft that the forced path can salvage', async () => {
  const { summarizer, tasks } = scriptedSummarizer([completed('R'.repeat(45)), completed('T'.repeat(20))]);
  const result = await summarizer.summarizeDetailed(ctx, 'span', 'P'.repeat(51));
  expect(result.recap).toBeNull();
  expect(result.raw).toBe('R'.repeat(45));
  expect(result.attempt?.reason).toBe('collapsed');
  expect(result.attempt?.outputChars).toBe(20);
  expect(clampSummary(result.raw!, 30)).toBe('R'.repeat(30));
  expect(tasks).toHaveLength(2);
});
