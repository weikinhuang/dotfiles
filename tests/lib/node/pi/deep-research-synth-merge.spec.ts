/**
 * Tests for lib/node/pi/deep-research-synth-merge.ts.
 *
 * Covers:
 *
 *   - Section ordering follows plan.subQuestions (NOT outcome
 *     array order).
 *   - Footnote renumbering: `{{SRC:<id>}}` is rewritten to `[^n]`
 *     with first-use order, and the footnotes block is appended.
 *   - `UnknownPlaceholderError` fires when a section file cites an
 *     id not in the source store (the "inject one manually"
 *     acceptance test).
 *   - Quarantined / stuck / missing-finding outcomes render as a
 *     visible `[section unavailable: ...]` stub inside report.md.
 *   - Merge LLM turn that emits stuck → deterministic wrapper
 *     used, report still written.
 *   - Merge LLM turn that exhausts retries → deterministic
 *     wrapper used, `usedFallback: true`.
 *   - Tiny provenance summary on the report sidecar when the
 *     adapter is enabled.
 *   - Merge prompt includes section leads but NOT raw findings.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  UnknownPlaceholderError,
  formatStub,
  mergeOutputSchema,
  renderMergePrompt,
  runSynthMerge,
} from '../../../../lib/node/pi/deep-research-synth-merge.ts';
import { type SectionOutcome } from '../../../../lib/node/pi/deep-research-synth-sections.ts';
import { paths } from '../../../../lib/node/pi/research-paths.ts';
import { type DeepResearchPlan } from '../../../../lib/node/pi/research-plan.ts';
import { readProvenance } from '../../../../lib/node/pi/research-provenance.ts';
import { type ResearchSessionLike } from '../../../../lib/node/pi/research-structured.ts';
import { STUCK_STATUS } from '../../../../lib/node/pi/research-stuck.ts';
import { type TinyAdapter } from '../../../../lib/node/pi/research-tiny.ts';

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

function makePlan(subs: { id: string; question: string }[]): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: 'demo',
    question: 'demo question',
    status: 'planning',
    budget: { maxSubagents: 6, maxFetches: 40, maxCostUsd: 3, wallClockSec: 1800 },
    subQuestions: subs.map((sq) => ({ id: sq.id, question: sq.question, status: 'complete' })),
  };
}

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

function okOutcome(args: {
  runRoot: string;
  subQuestionId: string;
  heading: string;
  markdown: string;
  sourceIds: string[];
}): SectionOutcome {
  const p = join(args.runRoot, 'snapshots', 'sections', `${args.subQuestionId}.md`);
  mkdirSync(join(args.runRoot, 'snapshots', 'sections'), { recursive: true });
  writeFileSync(p, args.markdown);
  return {
    kind: 'ok',
    subQuestionId: args.subQuestionId,
    sectionPath: p,
    markdown: args.markdown,
    sourceIds: args.sourceIds,
    truncated: false,
  };
}

let sandbox: string;
let runRoot: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-synth-merge-'));
  runRoot = join(sandbox, 'research', 'demo');
  mkdirSync(runRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const VALID_MERGE = JSON.stringify({
  title: 'Research Report',
  introduction: 'This report addresses the demo question.',
  conclusion: 'In summary, the sub-questions are addressed above.',
});

// ──────────────────────────────────────────────────────────────────────
// mergeOutputSchema.
// ──────────────────────────────────────────────────────────────────────

describe('mergeOutputSchema', () => {
  test('rejects a missing field', () => {
    expect(mergeOutputSchema.validate({ title: 'x', introduction: 'y' }).ok).toBe(false);
  });

  test('rejects over-long title', () => {
    const r = mergeOutputSchema.validate({
      title: 'x'.repeat(1000),
      introduction: 'i',
      conclusion: 'c',
    });

    expect(r.ok).toBe(false);
  });

  test('accepts the happy-path shape', () => {
    const r = mergeOutputSchema.validate({ title: 'T', introduction: 'I', conclusion: 'C' });

    expect(r.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// renderMergePrompt.
// ──────────────────────────────────────────────────────────────────────

describe('renderMergePrompt', () => {
  test('includes the user question + each sub-question lead', () => {
    const plan = makePlan([
      { id: 'sq-a', question: 'A?' },
      { id: 'sq-b', question: 'B?' },
    ]);
    const prompt = renderMergePrompt(plan, [
      { subQuestionId: 'sq-a', question: 'A?', lead: 'A lead' },
      { subQuestionId: 'sq-b', question: 'B?', lead: 'B lead' },
    ]);

    expect(prompt).toContain('User question: demo question');
    expect(prompt).toContain('id=sq-a');
    expect(prompt).toContain('id=sq-b');
    expect(prompt).toContain('A lead');
    expect(prompt).toContain('B lead');
  });
});

// ──────────────────────────────────────────────────────────────────────
// runSynthMerge.
// ──────────────────────────────────────────────────────────────────────

describe('runSynthMerge', () => {
  test('(a) orders sections by plan, renumbers footnotes, appends footnotes block', async () => {
    const plan = makePlan([
      { id: 'sq-a', question: 'A?' },
      { id: 'sq-b', question: 'B?' },
    ]);
    writeSource(runRoot, { id: 'src1', url: 'https://example.com/1', title: 'S1' });
    writeSource(runRoot, { id: 'src2', url: 'https://example.com/2', title: 'S2' });

    const sectionA = okOutcome({
      runRoot,
      subQuestionId: 'sq-a',
      heading: 'A',
      markdown: '## A\n\nclaim a {{SRC:src1}}.',
      sourceIds: ['src1'],
    });
    const sectionB = okOutcome({
      runRoot,
      subQuestionId: 'sq-b',
      heading: 'B',
      markdown: '## B\n\nclaim b {{SRC:src2}} (and {{SRC:src1}}).',
      sourceIds: ['src2', 'src1'],
    });

    // Deliberately swap outcome array order — plan ordering should
    // win over argument order.
    const session = makeSession([VALID_MERGE]);
    const result = await runSynthMerge({
      runRoot,
      plan,
      sectionOutcomes: [sectionB, sectionA],
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    const report = readFileSync(result.reportPath, 'utf8');

    // Section A appears BEFORE section B in the output.
    const idxA = report.indexOf('## A');
    const idxB = report.indexOf('## B');

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);

    // Footnote markers renumbered in first-use order: src1 → [^1], src2 → [^2].
    expect(report).toContain('claim a [^1]');
    expect(report).toContain('claim b [^2]');
    expect(report).toContain('and [^1]');

    // Footnotes block appended.
    expect(report).toContain('[^1]: S1 — https://example.com/1');
    expect(report).toContain('[^2]: S2 — https://example.com/2');

    expect(result.footnoteCount).toBe(2);
    expect(result.stubbedSubQuestions).toEqual([]);
    expect(result.usedFallback).toBe(false);
  });

  test('(b) rejects a draft with an unknown source id (manual injection)', async () => {
    const plan = makePlan([{ id: 'sq-a', question: 'A?' }]);
    writeSource(runRoot, { id: 'real', url: 'https://example.com/real', title: 'Real' });

    // Inject a section that references a hallucinated id. The
    // synth stage's schema validator would have rejected this,
    // but here we bypass synth and feed the bad body directly
    // into merge — acceptance: research-citations refuses.
    const sectionA = okOutcome({
      runRoot,
      subQuestionId: 'sq-a',
      heading: 'A',
      markdown: '## A\n\nbad cite {{SRC:ghost}}.',
      sourceIds: ['ghost'],
    });

    const session = makeSession([VALID_MERGE]);

    await expect(
      runSynthMerge({
        runRoot,
        plan,
        sectionOutcomes: [sectionA],
        session,
        model: 'local/test',
        thinkingLevel: null,
      }),
    ).rejects.toThrow(UnknownPlaceholderError);
  });

  test('(c) quarantined / missing / stuck sections render as visible stubs', async () => {
    const plan = makePlan([
      { id: 'sq-ok', question: 'Ok?' },
      { id: 'sq-q', question: 'Quarantined?' },
      { id: 'sq-s', question: 'Stuck?' },
      { id: 'sq-m', question: 'Missing?' },
    ]);
    writeSource(runRoot, { id: 'src1', url: 'https://example.com/1', title: 'S1' });

    const good = okOutcome({
      runRoot,
      subQuestionId: 'sq-ok',
      heading: 'Ok',
      markdown: '## Ok?\n\nbody {{SRC:src1}}.',
      sourceIds: ['src1'],
    });
    const outcomes: SectionOutcome[] = [
      good,
      { kind: 'quarantined', subQuestionId: 'sq-q', reason: 'retries exhausted' },
      { kind: 'stuck', subQuestionId: 'sq-s', reason: 'too thin' },
      { kind: 'missing-finding', subQuestionId: 'sq-m', reason: 'no findings on disk' },
    ];

    const session = makeSession([VALID_MERGE]);
    const result = await runSynthMerge({
      runRoot,
      plan,
      sectionOutcomes: outcomes,
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    const report = readFileSync(result.reportPath, 'utf8');

    expect(report).toContain('## Ok?');
    expect(report).toContain('## Quarantined?');
    expect(report).toContain('[section unavailable: retries exhausted]');
    expect(report).toContain('## Stuck?');
    expect(report).toContain('[section unavailable: too thin]');
    expect(report).toContain('## Missing?');
    expect(report).toContain('[section unavailable: no findings on disk]');

    expect(result.stubbedSubQuestions).toEqual(['sq-q', 'sq-s', 'sq-m']);
  });

  test('(d) merge stuck → deterministic wrapper, usedFallback=true', async () => {
    const plan = makePlan([{ id: 'sq-a', question: 'A?' }]);
    writeSource(runRoot, { id: 'src1', url: 'https://example.com/1', title: 'S1' });
    const section = okOutcome({
      runRoot,
      subQuestionId: 'sq-a',
      heading: 'A',
      markdown: '## A\n\nbody {{SRC:src1}}.',
      sourceIds: ['src1'],
    });

    const session = makeSession([`{"status":"${STUCK_STATUS}","reason":"can't wrap"}`]);
    const result = await runSynthMerge({
      runRoot,
      plan,
      sectionOutcomes: [section],
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    expect(result.usedFallback).toBe(true);

    const report = readFileSync(result.reportPath, 'utf8');

    // Deterministic wrapper title starts with "Research:".
    expect(report).toMatch(/^# Research:/m);
    expect(report).toContain('## Conclusion');
  });

  test('(e) merge retries exhausted → deterministic wrapper', async () => {
    const plan = makePlan([{ id: 'sq-a', question: 'A?' }]);
    writeSource(runRoot, { id: 'src1', url: 'https://example.com/1', title: 'S1' });
    const section = okOutcome({
      runRoot,
      subQuestionId: 'sq-a',
      heading: 'A',
      markdown: '## A\n\nbody {{SRC:src1}}.',
      sourceIds: ['src1'],
    });

    // Three malformed replies → fallback fires.
    const session = makeSession(['not-json', 'still-not', 'nope']);
    const result = await runSynthMerge({
      runRoot,
      plan,
      sectionOutcomes: [section],
      session,
      model: 'local/test',
      thinkingLevel: null,
      maxRetries: 3,
    });

    expect(result.usedFallback).toBe(true);
  });

  test('(f) tiny summary lands on report provenance sidecar', async () => {
    const plan = makePlan([{ id: 'sq-a', question: 'A?' }]);
    writeSource(runRoot, { id: 'src1', url: 'https://example.com/1', title: 'S1' });
    const section = okOutcome({
      runRoot,
      subQuestionId: 'sq-a',
      heading: 'A',
      markdown: '## A\n\nbody {{SRC:src1}}.',
      sourceIds: ['src1'],
    });

    const session = makeSession([VALID_MERGE]);
    const result = await runSynthMerge({
      runRoot,
      plan,
      sectionOutcomes: [section],
      session,
      model: 'local/test',
      thinkingLevel: null,
      tinyAdapter: enabledTiny('demo report'),
      tinyCtx: {
        cwd: sandbox,
        model: undefined,
        modelRegistry: { find: () => undefined, authStorage: {} },
      },
    });

    const prov = readProvenance(result.reportPath);

    expect(prov?.summary).toBe('demo report');
  });

  test('(g) runs against the canonical report path', async () => {
    const plan = makePlan([{ id: 'sq-a', question: 'A?' }]);
    writeSource(runRoot, { id: 'src1', url: 'https://example.com/1', title: 'S1' });
    const section = okOutcome({
      runRoot,
      subQuestionId: 'sq-a',
      heading: 'A',
      markdown: '## A\n\nbody {{SRC:src1}}.',
      sourceIds: ['src1'],
    });

    const session = makeSession([VALID_MERGE]);
    const result = await runSynthMerge({
      runRoot,
      plan,
      sectionOutcomes: [section],
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    expect(result.reportPath).toBe(paths(runRoot).report);
  });

  test('(h) strips inlined provenance frontmatter from the section snapshot', async () => {
    // Real-world regression from the Phase 6b qwen3 smoke: the
    // section writer calls `writeSidecar` which inlines a YAML
    // `---…---` provenance block at the top of the snapshot. If
    // merge loads the snapshot as-is, the body becomes
    //   `## <question>`
    //   `---\nmodel: …\n---`
    //   `## <question>   (from inside the snapshot)`
    //   `<actual section body with [^n] markers>`
    // and the structural check's `every-section-cites-a-source`
    // check fires on the first (empty, frontmatter-only) slice.
    // The fix: strip the inlined frontmatter in `loadSectionBody`
    // before composing the report.
    const plan = makePlan([{ id: 'sq-a', question: 'A?' }]);
    writeSource(runRoot, { id: 'src1', url: 'https://example.com/1', title: 'S1' });

    // Simulate what `runSectionSynth` + `writeSidecar` actually
    // produces on disk: provenance block, then the section body.
    const snapshotBody = [
      '---',
      'model: "local/test"',
      'thinkingLevel: null',
      'timestamp: "2026-01-01T00:00:00.000Z"',
      'promptHash: "abc"',
      '---',
      '## A',
      '',
      'Body claim {{SRC:src1}}.',
    ].join('\n');

    const section: SectionOutcome = {
      kind: 'ok',
      subQuestionId: 'sq-a',
      sectionPath: join(runRoot, 'snapshots', 'sections', 'sq-a.md'),
      markdown: snapshotBody,
      sourceIds: ['src1'],
      truncated: false,
    };

    const session = makeSession([VALID_MERGE]);
    const result = await runSynthMerge({
      runRoot,
      plan,
      sectionOutcomes: [section],
      session,
      model: 'local/test',
      thinkingLevel: null,
    });

    const report = readFileSync(result.reportPath, 'utf8');

    // The snapshot's inlined promptHash must NOT appear anywhere
    // in the report — the report has its own provenance
    // frontmatter written by merge, but the snapshot's `abc` hash
    // is specific to the section and must be dropped.
    expect(report).not.toContain('promptHash: "abc"');

    // Strip the report's own leading frontmatter and assert there
    // is no OTHER `---` block between the heading and the body
    // (the smoke-observed bug manifested as a stray YAML block
    // between `## A` and the section prose).
    const afterReportFrontmatter = report.replace(/^---\n[\s\S]*?\n---\n/, '');

    expect(afterReportFrontmatter).not.toContain('---\nmodel:');

    // The section heading appears exactly once (no duplicate
    // caused by merge re-prepending `## A?` over the snapshot's
    // own `## A`).
    const headingMatches = (report.match(/^## A\??$/gm) ?? []).length;

    expect(headingMatches).toBe(1);
    // Body with the footnote marker is present.
    expect(report).toContain('Body claim [^1]');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatStub.
// ──────────────────────────────────────────────────────────────────────

describe('formatStub', () => {
  test('collapses newlines in the reason', () => {
    const sq = { id: 'sq-x', question: 'Q?', status: 'pending' as const };
    const body = formatStub(sq, 'line one\nline two');

    expect(body).toContain('line one line two');
    expect(body).not.toContain('\n    line two');
  });

  test('falls back to "unknown" on empty reason', () => {
    const sq = { id: 'sq-x', question: 'Q?', status: 'pending' as const };
    const body = formatStub(sq, '   ');

    expect(body).toContain('[section unavailable: unknown]');
  });
});
