/**
 * Tests for the deep-research Phase-6b refinement runner.
 *
 * Covers the mapping logic (structural failures → sub-question
 * refinement targets), the nudge formatters, and the end-to-end
 * disk state produced by `refineReport` — a re-synthesized
 * section replaces its snapshot, the merge rewrites `report.md`,
 * and untouched sections keep their previous bodies.
 *
 * All sessions are mocked; no network, no real LLM.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildSectionNudge,
  buildStructuralMergeNudge,
  buildSubjectiveNudge,
  mapStructuralFailuresToTargets,
  refineReport,
} from '../../../../lib/node/pi/deep-research-refine.ts';
import { type StructuralFailure } from '../../../../lib/node/pi/deep-research-structural-check.ts';
import { type Verdict } from '../../../../lib/node/pi/iteration-loop-schema.ts';
import { type DeepResearchPlan } from '../../../../lib/node/pi/research-plan.ts';
import { type ResearchSessionLike } from '../../../../lib/node/pi/research-structured.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures.
// ──────────────────────────────────────────────────────────────────────

function makePlan(subQuestions: { id: string; question: string }[]): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: 'demo',
    question: 'demo question?',
    status: 'planning',
    budget: { maxSubagents: 6, maxFetches: 40, maxCostUsd: 3, wallClockSec: 1800 },
    subQuestions: subQuestions.map((sq) => ({ id: sq.id, question: sq.question, status: 'pending' })),
  };
}

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

function writeExistingSection(runRoot: string, sqId: string, heading: string, body: string): void {
  const dir = join(runRoot, 'snapshots', 'sections');
  mkdirSync(dir, { recursive: true });
  const full = `## ${heading}\n\n${body}\n`;
  writeFileSync(join(dir, `${sqId}.md`), full);
}

// ──────────────────────────────────────────────────────────────────────
// Pure: mapStructuralFailuresToTargets
// ──────────────────────────────────────────────────────────────────────

describe('mapStructuralFailuresToTargets', () => {
  const plan = makePlan([
    { id: 'sq-1', question: 'What did X do?' },
    { id: 'sq-2', question: 'When did Y happen?' },
  ]);

  test('maps a single section failure to exactly one target', () => {
    const failures: StructuralFailure[] = [
      {
        id: 'every-section-cites-a-source',
        message: 'section "What did X do?" has no [^n] footnote marker',
        location: 'What did X do?',
      },
    ];

    const targets = mapStructuralFailuresToTargets(failures, plan);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.subQuestionId).toBe('sq-1');
    expect(targets[0]?.failures).toHaveLength(1);
  });

  test('merges multiple failures on the same section into one target', () => {
    const failures: StructuralFailure[] = [
      {
        id: 'every-section-cites-a-source',
        message: 'no footnote marker',
        location: 'What did X do?',
      },
      {
        id: 'footnote-markers-resolve',
        message: '[^3] has no entry',
        location: 'What did X do?',
      },
    ];

    const targets = mapStructuralFailuresToTargets(failures, plan);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.subQuestionId).toBe('sq-1');
    expect(targets[0]?.failures).toHaveLength(2);
  });

  test('emits one target per affected sub-question', () => {
    const failures: StructuralFailure[] = [
      { id: 'every-section-cites-a-source', message: '...', location: 'What did X do?' },
      { id: 'every-section-cites-a-source', message: '...', location: 'When did Y happen?' },
    ];

    const targets = mapStructuralFailuresToTargets(failures, plan);

    expect(new Set(targets.map((t) => t.subQuestionId))).toEqual(new Set(['sq-1', 'sq-2']));
  });

  test('skips failures with no location (global / body-wide)', () => {
    const failures: StructuralFailure[] = [
      { id: 'footnote-markers-resolve', message: 'no footnotes block at all' }, // no location
    ];

    expect(mapStructuralFailuresToTargets(failures, plan)).toEqual([]);
  });

  test('skips failures whose location does not match a sub-question', () => {
    const failures: StructuralFailure[] = [
      { id: 'every-section-cites-a-source', message: '...', location: 'Not a real heading' },
    ];

    expect(mapStructuralFailuresToTargets(failures, plan)).toEqual([]);
  });

  test('skips non-refinable failure ids (bare URLs, duplicate footnotes)', () => {
    const failures: StructuralFailure[] = [
      { id: 'no-bare-urls-in-body', message: 'bare URL', location: 'https://x.test' },
      { id: 'no-duplicate-footnote-ids', message: 'dup [^1]', location: '[^1]:' },
      { id: 'no-unresolved-placeholders', message: '{{SRC:?}}', location: '{{SRC:?}}' },
    ];

    expect(mapStructuralFailuresToTargets(failures, plan)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pure: nudge formatters
// ──────────────────────────────────────────────────────────────────────

describe('buildSectionNudge', () => {
  test('includes each failure id and message in the bullet list', () => {
    const nudge = buildSectionNudge([
      { id: 'every-section-cites-a-source', message: 'no markers', location: 'Heading?' },
      { id: 'footnote-markers-resolve', message: '[^2] undefined', location: 'Heading?' },
    ]);

    expect(nudge).toContain('[every-section-cites-a-source]');
    expect(nudge).toContain('no markers');
    expect(nudge).toContain('[footnote-markers-resolve]');
    expect(nudge).toContain('[^2] undefined');
    expect(nudge).toContain('{{SRC:<id>}}');
  });
});

describe('buildStructuralMergeNudge', () => {
  test('returns an empty string on no failures', () => {
    expect(buildStructuralMergeNudge([])).toBe('');
  });

  test('includes failures and warns not to introduce new citations', () => {
    const n = buildStructuralMergeNudge([
      { id: 'no-bare-urls-in-body', message: 'bare url detected', location: 'https://x.test' },
    ]);

    expect(n).toContain('no-bare-urls-in-body');
    expect(n).toContain('bare url detected');
    expect(n).toContain('Do NOT introduce new footnote markers');
  });
});

describe('buildSubjectiveNudge', () => {
  test('includes the verdict summary and itemized issues', () => {
    const verdict: Verdict = {
      approved: false,
      score: 0.4,
      summary: 'tone uneven',
      issues: [
        { severity: 'major', description: 'intro repeats the conclusion' },
        { severity: 'minor', description: 'ordering is off' },
      ],
    };

    const n = buildSubjectiveNudge(verdict);

    expect(n).toContain('tone uneven');
    expect(n).toContain('[major] intro repeats the conclusion');
    expect(n).toContain('[minor] ordering is off');
  });

  test('tolerates missing summary / issues', () => {
    const n = buildSubjectiveNudge({ approved: false, score: 0, issues: [], summary: '' });

    expect(n).toContain('(no summary)');
    expect(n).toContain('No itemized issues were provided.');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Integration: refineReport
// ──────────────────────────────────────────────────────────────────────

let sandbox: string;
let runRoot: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-refine-'));
  runRoot = join(sandbox, 'research', 'demo');
  mkdirSync(runRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function sectionReply(body: string): string {
  return JSON.stringify({ markdown: body });
}

function mergeReply(title: string, intro: string, conclusion: string): string {
  return JSON.stringify({ title, introduction: intro, conclusion });
}

describe('refineReport — structural stage, per-section path', () => {
  test('re-runs section synth for the named sub-question and preserves the untouched one', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'What did X do?' },
      { id: 'sq-2', question: 'When did Y happen?' },
    ]);
    writeSource(runRoot, { id: 'a1', url: 'https://example.com/a', title: 'A1' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);
    // sq-2's existing snapshot is fine; synth won't be re-run for it.
    writeExistingSection(runRoot, 'sq-2', 'When did Y happen?', 'Preserved body [^99] text.');

    const session = makeSession([
      sectionReply('## What did X do?\n\nRefreshed section {{SRC:a1}}.'),
      mergeReply('Title', 'Intro.', 'Conclusion.'),
    ]);

    const result = await refineReport({
      runRoot,
      plan,
      stage: 'structural',
      structural: [
        {
          id: 'every-section-cites-a-source',
          message: 'section "What did X do?" has no [^n] marker',
          location: 'What did X do?',
        },
      ],
      iteration: 2,
      session,
      model: 'test/model',
      thinkingLevel: null,
    });

    expect(result.mergeOnly).toBe(false);
    expect(result.refinedSections).toEqual(['sq-1']);

    // Report exists and cites the refreshed section's source.
    const report = readFileSync(result.merge.reportPath, 'utf8');

    expect(report).toContain('Refreshed section');
    expect(report).toMatch(/\[\^1\]/);

    // The untouched section's preserved body is still in the report.
    expect(report).toContain('Preserved body');

    // Two prompts: one section re-synth, one merge. Section prompt
    // carries the nudge.
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[0]).toContain('previous draft of this section failed the structural check');
    expect(session.prompts[0]).toContain('every-section-cites-a-source');
  });

  test('handles multiple failing sections with one synth call each', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'Q1?' },
      { id: 'sq-2', question: 'Q2?' },
    ]);
    writeSource(runRoot, { id: 'a1', url: 'https://example.com/a', title: 'A1' });
    writeSource(runRoot, { id: 'b1', url: 'https://example.com/b', title: 'B1' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);
    writeFinding(runRoot, 'sq-2', [{ label: 'S1', url: 'https://example.com/b' }]);

    const session = makeSession([
      sectionReply('## Q1?\n\nNew A {{SRC:a1}}.'),
      sectionReply('## Q2?\n\nNew B {{SRC:b1}}.'),
      mergeReply('T', 'I.', 'C.'),
    ]);

    const result = await refineReport({
      runRoot,
      plan,
      stage: 'structural',
      structural: [
        { id: 'every-section-cites-a-source', message: 'missing', location: 'Q1?' },
        { id: 'every-section-cites-a-source', message: 'missing', location: 'Q2?' },
      ],
      iteration: 1,
      session,
      model: 'test/model',
      thinkingLevel: null,
    });

    expect(result.refinedSections.sort()).toEqual(['sq-1', 'sq-2']);
    expect(session.prompts).toHaveLength(3); // two synths + one merge
  });
});

describe('refineReport — structural stage, merge-only path', () => {
  test('skips section synth when no failure pins to a section', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q1?' }]);
    writeSource(runRoot, { id: 'a1', url: 'https://example.com/a', title: 'A1' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);
    writeExistingSection(runRoot, 'sq-1', 'Q1?', 'Existing body {{SRC:a1}}.');

    const session = makeSession([mergeReply('Title', 'Intro.', 'Conclusion.')]);

    const result = await refineReport({
      runRoot,
      plan,
      stage: 'structural',
      structural: [{ id: 'no-bare-urls-in-body', message: 'bare url', location: 'https://x.test' }],
      iteration: 2,
      session,
      model: 'test/model',
      thinkingLevel: null,
    });

    expect(result.mergeOnly).toBe(true);
    expect(result.refinedSections).toEqual([]);
    expect(session.prompts).toHaveLength(1); // merge only
    // Structural merge nudge reaches the merge prompt.
    expect(session.prompts[0]).toContain('previous draft of the report failed the structural check');
    expect(session.prompts[0]).toContain('no-bare-urls-in-body');
  });
});

describe('refineReport — subjective stage', () => {
  test('runs merge only with the critic nudge threaded into the prompt', async () => {
    const plan = makePlan([{ id: 'sq-1', question: 'Q1?' }]);
    writeSource(runRoot, { id: 'a1', url: 'https://example.com/a', title: 'A1' });
    writeFinding(runRoot, 'sq-1', [{ label: 'S1', url: 'https://example.com/a' }]);
    writeExistingSection(runRoot, 'sq-1', 'Q1?', 'Existing body {{SRC:a1}}.');

    const session = makeSession([mergeReply('Title', 'Better intro.', 'Better conclusion.')]);

    const result = await refineReport({
      runRoot,
      plan,
      stage: 'subjective',
      critic: {
        approved: false,
        score: 0.3,
        summary: 'the intro is weak',
        issues: [{ severity: 'major', description: 'repeats the abstract' }],
      },
      iteration: 3,
      session,
      model: 'test/model',
      thinkingLevel: null,
    });

    expect(result.mergeOnly).toBe(true);
    expect(result.refinedSections).toEqual([]);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain('subjective critic');
    expect(session.prompts[0]).toContain('the intro is weak');
    expect(session.prompts[0]).toContain('repeats the abstract');

    const report = readFileSync(result.merge.reportPath, 'utf8');

    expect(report).toContain('Better intro.');
    expect(report).toContain('Existing body'); // section preserved
  });
});
