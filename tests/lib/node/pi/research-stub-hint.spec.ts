/**
 * Tests for lib/node/pi/research-stub-hint.ts.
 *
 * Each test builds a throwaway run-root under $TMPDIR with a
 * hand-rolled `plan.json` + `report.md`, runs `formatStubHint`,
 * and inspects the returned string (or `null` when there are no
 * stubs).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type StubbedSection } from '../../../../lib/node/pi/research-resume.ts';
import {
  formatStubHint,
  formatStubbedReviewSummary,
  resolveStubbedSectionIds,
} from '../../../../lib/node/pi/research-stub-hint.ts';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'research-stub-hint-spec-'));
}

function writePlan(runRoot: string, subQuestions: readonly { id: string; question: string }[]): void {
  mkdirSync(runRoot, { recursive: true });
  const plan = {
    kind: 'deep-research',
    version: 1,
    question: 'stub question',
    slug: 'stub-slug',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'planning',
    budget: { maxSubagents: subQuestions.length, maxFetches: 20, maxCostUsd: 5, wallClockSec: 600 },
    subQuestions: subQuestions.map(({ id, question }) => ({ id, question, status: 'pending' })),
  };
  writeFileSync(join(runRoot, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

function writeReport(runRoot: string, body: string): void {
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, 'report.md'), body, 'utf8');
}

/** Narrow the return value and throw when `null`. Keeps conditionals out of tests. */
function expectHint(r: string | null, label = 'formatStubHint'): string {
  if (r === null) throw new Error(`expected ${label} to return a non-null hint`);
  return r;
}

describe('formatStubHint', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns null when report.md is absent', () => {
    expect(formatStubHint(tmp)).toBeNull();
  });

  test('returns null when report has no [section unavailable] stubs', () => {
    writePlan(tmp, [{ id: 'sq-1', question: 'What changed?' }]);
    writeReport(tmp, ['# Report', '', '## What changed?', '', 'Real prose [^1].', ''].join('\n'));

    expect(formatStubHint(tmp)).toBeNull();
  });

  test('resolves each stubbed heading to its sq-N id via exact-string match', () => {
    writePlan(tmp, [
      { id: 'sq-1', question: 'What is A?' },
      { id: 'sq-2', question: 'What is B?' },
      { id: 'sq-3', question: 'What is C?' },
    ]);
    writeReport(
      tmp,
      [
        '# Report',
        '',
        '## What is A?',
        '',
        'Real prose [^1].',
        '',
        '## What is B?',
        '',
        '[section unavailable: no findings on disk]',
        '',
        '## What is C?',
        '',
        '[section unavailable: synth emitted empty body]',
        '',
      ].join('\n'),
    );
    const hint = expectHint(formatStubHint(tmp));

    // Counts + per-heading bullets appear.
    expect(hint).toContain('2 sub-question section(s) are stubbed');
    expect(hint).toContain('• What is B? - no findings on disk');
    expect(hint).toContain('• What is C? - synth emitted empty body');
    // Real --sq=<ids> command path - no placeholder.
    expect(hint).toContain(`--sq=sq-2,sq-3`);
    expect(hint).toContain(`--run-root ${tmp}`);
    expect(hint).toContain('--from=fanout');
    expect(hint).not.toContain('<id1>');
  });

  test('preserves stubbed-heading order (report order, not plan order) in the resolved id list', () => {
    writePlan(tmp, [
      { id: 'sq-1', question: 'Q1' },
      { id: 'sq-2', question: 'Q2' },
      { id: 'sq-3', question: 'Q3' },
    ]);
    writeReport(
      tmp,
      ['# Report', '', '## Q3', '', '[section unavailable: x]', '', '## Q1', '', '[section unavailable: y]', ''].join(
        '\n',
      ),
    );
    const hint = expectHint(formatStubHint(tmp));

    // Report order drives the `--sq` argument so the notify
    // matches what the user sees in the stubbed-section bullet
    // list above it.
    expect(hint).toContain('--sq=sq-3,sq-1');
  });

  test('matches case-insensitively when exact match fails', () => {
    writePlan(tmp, [{ id: 'sq-1', question: 'What is Rust?' }]);
    writeReport(tmp, ['# Report', '', '## what IS rust?', '', '[section unavailable: re-fetch]', ''].join('\n'));
    const hint = expectHint(formatStubHint(tmp));

    expect(hint).toContain('--sq=sq-1');
    expect(hint).not.toContain('<id1>');
  });

  test('falls back to <id1>,<id2> placeholder when a heading cannot be matched', () => {
    writePlan(tmp, [{ id: 'sq-1', question: 'Original question text' }]);
    writeReport(
      tmp,
      [
        '# Report',
        '',
        '## Different heading that does not appear in plan.json',
        '',
        '[section unavailable: x]',
        '',
      ].join('\n'),
    );
    const hint = expectHint(formatStubHint(tmp));

    expect(hint).toContain('--sq=<id1>,<id2>');
    expect(hint).toContain('could not resolve every heading');
    expect(hint).toContain(join(tmp, 'plan.json'));
  });

  test('duplicate plan entries with identical text: exact-match picks the first (no ambiguity flag)', () => {
    // Two plan entries share identical text. Exact-match picks
    // the first plan occurrence deterministically; we do NOT
    // promote this to an ambiguity fallback because the report
    // heading maps to a concrete plan entry by its position in
    // the file, and sq-1 is the conventional first.
    writePlan(tmp, [
      { id: 'sq-1', question: 'Shared question' },
      { id: 'sq-2', question: 'Shared question' },
    ]);
    writeReport(tmp, ['# Report', '', '## Shared question', '', '[section unavailable: x]', ''].join('\n'));
    const hint = expectHint(formatStubHint(tmp));

    expect(hint).toContain('--sq=sq-1');
    expect(hint).not.toContain('<id1>');
  });

  test('normalized-ambiguity fallback: two plan entries differ only by case, heading matches neither exactly', () => {
    writePlan(tmp, [
      { id: 'sq-1', question: 'Shared Question' }, // capital S, Q
      { id: 'sq-2', question: 'shared question' }, // lowercase
    ]);
    writeReport(
      tmp,
      // Neither exact-matches the heading below; after
      // normalization both map to the same bucket → ambiguous.
      ['# Report', '', '## SHARED QUESTION', '', '[section unavailable: x]', ''].join('\n'),
    );
    const hint = expectHint(formatStubHint(tmp));

    expect(hint).toContain('<id1>,<id2>');
    expect(hint).not.toContain('--sq=sq-1,');
    expect(hint).not.toContain('--sq=sq-2,');
  });

  test('falls back to placeholder when plan.json is absent', () => {
    // Only report.md, no plan.json.
    writeReport(tmp, ['# Report', '', '## Some heading', '', '[section unavailable: x]', ''].join('\n'));
    const hint = expectHint(formatStubHint(tmp));

    expect(hint).toContain('<id1>,<id2>');
  });

  test('falls back to placeholder when plan.json is malformed', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'plan.json'), '{ not valid json', 'utf8');
    writeReport(tmp, ['# Report', '', '## Some heading', '', '[section unavailable: x]', ''].join('\n'));
    const hint = expectHint(formatStubHint(tmp));

    expect(hint).toContain('<id1>,<id2>');
  });

  test('mixed resolvable + unresolvable headings falls back to placeholder (all-or-nothing)', () => {
    writePlan(tmp, [{ id: 'sq-1', question: 'Q1' }]);
    writeReport(
      tmp,
      [
        '# Report',
        '',
        '## Q1',
        '',
        '[section unavailable: x]',
        '',
        '## Unknown heading',
        '',
        '[section unavailable: y]',
        '',
      ].join('\n'),
    );
    const hint = expectHint(formatStubHint(tmp));

    // Real id for Q1 would be `sq-1`, but because one heading
    // can't be resolved the hint keeps the command as a template
    // the user completes. Mixing `sq-1,<id2>` would be confusing.
    expect(hint).toContain('<id1>,<id2>');
    expect(hint).not.toContain('--sq=sq-1,');
  });
});

describe('resolveStubbedSectionIds', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('empty stubbed list returns ok=true with ids=[]', () => {
    writePlan(tmp, [{ id: 'sq-1', question: 'Q1' }]);
    const resolved = resolveStubbedSectionIds(tmp, []);

    expect(resolved).toEqual({ ok: true, ids: [] });
  });

  test('resolves each heading in report order when exact matches exist', () => {
    writePlan(tmp, [
      { id: 'sq-1', question: 'Q1' },
      { id: 'sq-2', question: 'Q2' },
    ]);
    const stubbed: StubbedSection[] = [
      { heading: 'Q2', reason: 'x' },
      { heading: 'Q1', reason: 'y' },
    ];

    expect(resolveStubbedSectionIds(tmp, stubbed)).toEqual({ ok: true, ids: ['sq-2', 'sq-1'] });
  });

  test('ok=false when at least one heading cannot be resolved', () => {
    writePlan(tmp, [{ id: 'sq-1', question: 'Q1' }]);
    const stubbed: StubbedSection[] = [
      { heading: 'Q1', reason: '' },
      { heading: 'Unknown', reason: '' },
    ];
    const resolved = resolveStubbedSectionIds(tmp, stubbed);

    expect(resolved.ok).toBe(false);
  });

  test('missing plan.json → ok=false', () => {
    const resolved = resolveStubbedSectionIds(tmp, [{ heading: 'Q1', reason: '' }]);

    expect(resolved.ok).toBe(false);
  });
});

describe('formatStubbedReviewSummary', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('renders "review skipped" line, per-heading bullets, and a resolved --sq= command', () => {
    writePlan(tmp, [
      { id: 'sq-1', question: 'Q1' },
      { id: 'sq-2', question: 'Q2' },
    ]);
    const stubbed: StubbedSection[] = [
      { heading: 'Q1', reason: 'no findings on disk' },
      { heading: 'Q2', reason: 'fanout task aborted' },
    ];
    const summary = formatStubbedReviewSummary(tmp, stubbed);

    expect(summary).toContain('review skipped');
    expect(summary).toContain('2 sub-question section(s)');
    expect(summary).toContain('Refinement cannot recover missing findings');
    expect(summary).toContain('\u2022 Q1 - no findings on disk');
    expect(summary).toContain('\u2022 Q2 - fanout task aborted');
    expect(summary).toContain(`--run-root ${tmp}`);
    expect(summary).toContain('--from=fanout');
    expect(summary).toContain('--sq=sq-1,sq-2');
    expect(summary).not.toContain('<id1>');
  });

  test('falls back to <id1>,<id2> placeholder when a heading cannot be resolved', () => {
    writePlan(tmp, [{ id: 'sq-1', question: 'Completely different text' }]);
    const stubbed: StubbedSection[] = [{ heading: 'Unknown heading', reason: 'x' }];
    const summary = formatStubbedReviewSummary(tmp, stubbed);

    expect(summary).toContain('<id1>,<id2>');
    expect(summary).toContain('could not resolve every heading');
    expect(summary).toContain(join(tmp, 'plan.json'));
  });
});
