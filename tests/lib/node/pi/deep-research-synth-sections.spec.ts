/**
 * Tests for lib/node/pi/deep-research-synth-sections.ts.
 *
 * Drives the per-sub-question synth stage against a mock
 * ResearchSessionLike + scripted replies. Covers:
 *
 *   - Happy path: a single sub-question with a valid finding and
 *     two cached sources produces a section markdown file, a
 *     provenance sidecar, and `SectionOutcome.kind === 'ok'`.
 *   - Placeholder validation: a reply citing an unknown source id
 *     triggers the callTyped nudge loop, and when retries exhaust
 *     the section is quarantined.
 *   - Per-section retry: a bad-shape reply followed by a valid one
 *     is accepted without quarantine.
 *   - Missing-finding short-circuit: a sub-question whose findings
 *     file doesn't exist returns `missing-finding`.
 *   - Stuck response: the section is recorded as `stuck` without
 *     creating an on-disk section file.
 *   - `{{SRC:<id>}}` placeholder emission: the outcome carries the
 *     referenced ids.
 *   - Full `runAllSections`: quarantining one section does not
 *     abort the remaining sub-questions.
 *   - Tiny provenance summary: when the adapter returns a
 *     `summarize-provenance` line, the section sidecar carries it.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync as fsExistsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  SECTION_MAX_CHARS,
  makeSectionOutputSchema,
  renderSectionPrompt,
  runAllSections,
  runSectionSynth,
  type SectionOutcome,
} from '../../../../lib/node/pi/deep-research-synth-sections.ts';
import { type DeepResearchPlan } from '../../../../lib/node/pi/research-plan.ts';
import { readProvenance } from '../../../../lib/node/pi/research-provenance.ts';
import { type ResearchSessionLike } from '../../../../lib/node/pi/research-structured.ts';
import { STUCK_STATUS } from '../../../../lib/node/pi/research-stuck.ts';
import { type TinyAdapter } from '../../../../lib/node/pi/research-tiny.ts';
import { assertErr, assertKind, assertOk } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Mocks.
// ──────────────────────────────────────────────────────────────────────

function makeSession(scripted: string[]): ResearchSessionLike & { prompts: string[] } {
  const messages: { role: string; content: { type: string; text: string }[] }[] = [];
  const prompts: string[] = [];
  let next = 0;
  return {
    prompts,
    state: { messages },
    prompt: (task: string) => {
      prompts.push(task);
      const reply = scripted[next++] ?? '';
      messages.push({ role: 'user', content: [{ type: 'text', text: task }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      return Promise.resolve();
    },
  };
}

function disabledTiny(): TinyAdapter<unknown> {
  return {
    isEnabled: () => false,
    callTinyRewrite: () => Promise.resolve(null),
    callTinyClassify: () => Promise.resolve(null),
    callTinyMatch: () => Promise.resolve(null),
    getTotalCost: () => 0,
  };
}

function enabledTiny(summary: string): TinyAdapter<unknown> {
  return {
    isEnabled: () => true,
    callTinyRewrite: (_ctx, task) => Promise.resolve(task === 'summarize-provenance' ? summary : null),
    callTinyClassify: () => Promise.resolve(null),
    callTinyMatch: () => Promise.resolve(null),
    getTotalCost: () => 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Fixtures.
// ──────────────────────────────────────────────────────────────────────

function makePlan(subQuestions: { id: string; question: string }[]): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: 'demo',
    question: 'demo question',
    status: 'planning',
    budget: { maxSubagents: 6, maxFetches: 40, maxCostUsd: 3, wallClockSec: 1800 },
    subQuestions: subQuestions.map((sq) => ({ id: sq.id, question: sq.question, status: 'pending' })),
  };
}

/**
 * Write a source store entry (`sources/<id>.{json,md}`) into the
 * run root. Mirrors the on-disk shape `research-sources.persist`
 * produces so downstream code sees a real cache.
 */
function writeSource(runRoot: string, opts: { id: string; url: string; title: string; content?: string }): void {
  const dir = join(runRoot, 'sources');
  mkdirSync(dir, { recursive: true });
  const ref = {
    id: opts.id,
    url: opts.url,
    title: opts.title,
    fetchedAt: '2025-01-01T00:00:00.000Z',
    contentHash: 'deadbeef',
    method: 'fetch',
    mediaType: 'text/markdown',
  };
  writeFileSync(join(dir, `${opts.id}.json`), JSON.stringify(ref) + '\n');
  writeFileSync(join(dir, `${opts.id}.md`), opts.content ?? `# ${opts.title}\n\nBody.\n`);
}

function writeFinding(runRoot: string, id: string, sources: { label: string; url: string }[]): void {
  const dir = join(runRoot, 'findings');
  mkdirSync(dir, { recursive: true });
  const sourcesBody =
    sources.length === 0 ? '  - None.' : sources.map((s) => `- [${s.label}] ${s.url} — description`).join('\n');
  const body = [
    `# Sub-question: ${id}`,
    '',
    '## Findings',
    sources.length === 0 ? '- nothing to say.' : sources.map((s) => `- claim [${s.label}]`).join('\n'),
    '',
    '## Sources',
    sourcesBody,
    '',
    '## Open questions',
    '- None.',
    '',
  ].join('\n');
  writeFileSync(join(dir, `${id}.md`), body);
}

let sandbox: string;
let runRoot: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-synth-sections-'));
  runRoot = join(sandbox, 'research', 'demo');
  mkdirSync(runRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Pure helpers.
// ──────────────────────────────────────────────────────────────────────

describe('renderSectionPrompt', () => {
  test('lists available source ids with urls and titles', () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q1?' }]);
    const sq = plan.subQuestions[0];
    const prompt = renderSectionPrompt(sq, '## Findings\n- body.', [
      { id: 'abc', url: 'https://example.com/a', title: 'A' },
    ]);

    expect(prompt).toContain('id=abc url=https://example.com/a title=A');
    expect(prompt).toContain('{{SRC:<id>}}');
    expect(prompt).toContain(sq.question);
  });

  test('handles zero sources by forbidding placeholders', () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q1?' }]);
    const prompt = renderSectionPrompt(plan.subQuestions[0], '', []);

    expect(prompt).toContain('do not emit any {{SRC:...}}');
  });
});

describe('makeSectionOutputSchema', () => {
  test('rejects drafts with unknown source ids', () => {
    const schema = makeSectionOutputSchema(new Set(['a']));
    const r = schema.validate({ markdown: 'body cites {{SRC:unknown}}' });

    assertErr(r);

    expect(r.error).toContain('unknown');
  });

  test('accepts drafts using only known ids', () => {
    const schema = makeSectionOutputSchema(new Set(['a', 'b']));
    const r = schema.validate({ markdown: '## X\nfoo {{SRC:a}} bar {{SRC:b}}.' });

    assertOk(r);

    expect(r.value.markdown).toContain('{{SRC:a}}');
  });

  test('rejects non-object root', () => {
    const schema = makeSectionOutputSchema(new Set(['a']));

    expect(schema.validate('string')).toEqual({ ok: false, error: 'root value must be an object' });
  });

  test('rejects empty markdown', () => {
    const schema = makeSectionOutputSchema(new Set(['a']));
    const r = schema.validate({ markdown: '' });

    expect(r.ok).toBe(false);
  });

  test('rejects zero-citation markdown when sources are available', () => {
    const schema = makeSectionOutputSchema(new Set(['a', 'b']));
    const r = schema.validate({ markdown: '## X\n\nUncited prose paragraph.' });

    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/no \{\{SRC:<id>\}\} placeholders/);
  });

  test('accepts zero-citation markdown when no sources are available (nothing to cite)', () => {
    const schema = makeSectionOutputSchema(new Set());
    const r = schema.validate({ markdown: '## X\n\nUncited prose is fine here — the finding had no sources.' });

    expect(r.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// runSectionSynth.
// ──────────────────────────────────────────────────────────────────────

describe('runSectionSynth', () => {
  test('(a) happy path: valid section written with sources cited', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'What is A?' }]);
    writeSource(runRoot, { id: 'src-a', url: 'https://example.com/a', title: 'A page' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);

    const reply = JSON.stringify({ markdown: '## What is A?\n\nA is a thing {{SRC:src-a}}.' });
    const session = makeSession([reply]);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: 'off',
    });

    assertKind(outcome, 'ok');

    expect(outcome.sourceIds).toEqual(['src-a']);
    expect(outcome.truncated).toBe(false);
    expect(outcome.markdown).toContain('{{SRC:src-a}}');

    const onDisk = readFileSync(outcome.sectionPath, 'utf8');

    expect(onDisk).toContain('{{SRC:src-a}}');
    expect(readProvenance(outcome.sectionPath)).toMatchObject({ model: 'local/test', thinkingLevel: 'off' });
  });

  test('(b) unknown source id triggers retry; valid second attempt succeeds', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'What is A?' }]);
    writeSource(runRoot, { id: 'src-a', url: 'https://example.com/a', title: 'A' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);

    const bad = JSON.stringify({ markdown: '## A\n\ncite {{SRC:hallucinated}}.' });
    const good = JSON.stringify({ markdown: '## A\n\ncite {{SRC:src-a}}.' });
    const session = makeSession([bad, good]);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: null,
      maxRetries: 3,
    });

    assertKind(outcome, 'ok');

    expect(outcome.sourceIds).toEqual(['src-a']);
    expect(session.prompts.length).toBe(2);
    expect(session.prompts[1]).toContain('failed validation');
  });

  test('(c) retries exhausted → quarantines the section', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q?' }]);
    writeSource(runRoot, { id: 'src-a', url: 'https://example.com/a', title: 'A' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);

    // All three attempts cite an unknown id → validator keeps
    // rejecting → fallback fires → quarantine.
    const bad = JSON.stringify({ markdown: '## A\n\n{{SRC:ghost}}.' });
    const session = makeSession([bad, bad, bad]);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: null,
      maxRetries: 3,
    });

    assertKind(outcome, 'quarantined');

    expect(outcome.reason).toContain('retries exhausted');

    // The original section file has been moved under _quarantined/.
    const sectionsDir = join(runRoot, 'snapshots', 'sections');

    expect(fsExistsSync(join(sectionsDir, 'sq-1.md'))).toBe(false);

    const quarantineRoot = join(sectionsDir, '_quarantined');

    expect(fsExistsSync(quarantineRoot)).toBe(true);

    const entries = readdirSync(quarantineRoot);

    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  test('(d) missing finding → missing-finding outcome', async () => {
    const plan = makePlan([{ id: 'sq-x', question: 'Q?' }]);
    const session = makeSession(['should-not-be-called']);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-x',
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    assertKind(outcome, 'missing-finding');

    expect(session.prompts.length).toBe(0);
  });

  test('(e) quarantinedFindings override short-circuits before session', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q?' }]);
    writeFinding(runRoot, 'sq-1', []);
    const session = makeSession(['should-not-be-called']);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: null,
      quarantinedFindings: new Set(['sq-1']),
    });

    assertKind(outcome, 'missing-finding');

    expect(outcome.reason).toContain('quarantined');
    expect(session.prompts.length).toBe(0);
  });

  test('(f) stuck response → stuck outcome, no on-disk file', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q?' }]);
    writeFinding(runRoot, 'sq-1', []);

    const session = makeSession([`{"status":"${STUCK_STATUS}","reason":"too thin"}`]);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    assertKind(outcome, 'stuck');

    expect(outcome.reason).toBe('too thin');
    expect(fsExistsSync(join(runRoot, 'snapshots', 'sections', 'sq-1.md'))).toBe(false);
  });

  test('(g) section output over cap → truncated + journaled', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q?' }]);
    writeSource(runRoot, { id: 's1', url: 'https://example.com/a', title: 'A' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);

    const big = '## A\n\n' + 'x'.repeat(SECTION_MAX_CHARS + 500) + ' {{SRC:s1}}';
    const session = makeSession([JSON.stringify({ markdown: big })]);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    assertKind(outcome, 'ok');

    expect(outcome.truncated).toBe(true);
    expect(outcome.markdown.length).toBeLessThanOrEqual(SECTION_MAX_CHARS);
    expect(outcome.markdown).toContain('truncated');
  });

  test('(h) tiny summary lands on provenance when adapter is enabled', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q?' }]);
    writeSource(runRoot, { id: 's1', url: 'https://example.com/a', title: 'A' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);

    const session = makeSession([JSON.stringify({ markdown: '## A\n\nbody {{SRC:s1}}.' })]);
    const tiny = enabledTiny('short summary');

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: null,
      tinyAdapter: tiny,
      tinyCtx: {
        cwd: sandbox,
        model: undefined,
        modelRegistry: { find: () => undefined, authStorage: {} },
      },
    });

    assertKind(outcome, 'ok');
    const prov = readProvenance(outcome.sectionPath);

    expect(prov?.summary).toBe('short summary');
  });

  test('(h-disabled) tiny adapter off → summary omitted', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q?' }]);
    writeSource(runRoot, { id: 's1', url: 'https://example.com/a', title: 'A' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);

    const session = makeSession([JSON.stringify({ markdown: '## A\n\nbody {{SRC:s1}}.' })]);

    const outcome = await runSectionSynth({
      runRoot,
      plan,
      subQuestionId: 'sq-1',
      session,
      model: 'local/test',
      thinkingLevel: null,
      tinyAdapter: disabledTiny(),
    });

    assertKind(outcome, 'ok');
    const prov = readProvenance(outcome.sectionPath);

    expect(prov?.summary).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// runAllSections.
// ──────────────────────────────────────────────────────────────────────

describe('runAllSections', () => {
  test('continues past a quarantined section and processes the rest', async () => {
    const plan = makePlan([
      { id: 'sq-a', question: 'A?' },
      { id: 'sq-b', question: 'B?' },
      { id: 'sq-c', question: 'C?' },
    ]);
    writeSource(runRoot, { id: 's1', url: 'https://example.com/a', title: 'A' });
    writeFinding(runRoot, 'sq-a', [{ label: 'S1', url: 'https://example.com/a' }]);
    writeFinding(runRoot, 'sq-b', [{ label: 'S1', url: 'https://example.com/a' }]);
    writeFinding(runRoot, 'sq-c', [{ label: 'S1', url: 'https://example.com/a' }]);

    // sq-a succeeds, sq-b fails 3x (quarantine), sq-c succeeds.
    const goodA = JSON.stringify({ markdown: '## A\n\n{{SRC:s1}}.' });
    const bad = JSON.stringify({ markdown: '## B\n\n{{SRC:ghost}}.' });
    const goodC = JSON.stringify({ markdown: '## C\n\n{{SRC:s1}}.' });

    const session = makeSession([goodA, bad, bad, bad, goodC]);

    const outcomes = await runAllSections({
      runRoot,
      plan,
      session,
      model: 'local/test',
      thinkingLevel: null,
      maxRetries: 3,
    });

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].kind).toBe('ok');
    expect(outcomes[1].kind).toBe('quarantined');
    expect(outcomes[2].kind).toBe('ok');
  });

  test('emits onSection for every outcome in order', async () => {
    const plan = makePlan([
      { id: 'sq-a', question: 'A?' },
      { id: 'sq-b', question: 'B?' },
    ]);
    writeFinding(runRoot, 'sq-a', []);
    writeFinding(runRoot, 'sq-b', []);

    const reply = JSON.stringify({ markdown: '## q\n\nbody.' });
    const session = makeSession([reply, reply]);

    const order: string[] = [];
    const onSection = (o: SectionOutcome): void => {
      order.push(o.subQuestionId + ':' + o.kind);
    };

    await runAllSections({
      runRoot,
      plan,
      session,
      model: 'local/test',
      thinkingLevel: null,
      onSection,
    });

    expect(order).toEqual(['sq-a:ok', 'sq-b:ok']);
  });
});
