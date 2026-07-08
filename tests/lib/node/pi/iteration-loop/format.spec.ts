/**
 * Tests for lib/node/pi/iteration-loop/format.ts.
 *
 * Pure formatters - the specs pin the exact `check list` and
 * `check run` response bodies (issue preview cap, snapshot fallback,
 * best-so-far line, cost rounding, and each stop-reason branch).
 */

import { describe, expect, test } from 'vitest';

import { formatListing, formatRunResultText } from '../../../../../lib/node/pi/iteration-loop/format.ts';
import type { BestSoFar, Verdict } from '../../../../../lib/node/pi/iteration-loop/schema.ts';

const emptyVerdict: Verdict = { approved: true, score: 1, issues: [] };

describe('formatListing', () => {
  test('reports the empty state when there are no tasks and no archive', () => {
    expect(formatListing([], [])).toBe('No active or draft tasks under .pi/checks/.');
  });

  test('lists tasks and pluralizes a multi-entry archive', () => {
    const out = formatListing(
      [
        { task: 'default', state: 'active', path: '/p/.pi/checks/default.json' },
        { task: 'logo', state: 'draft', path: '/p/.pi/checks/logo.draft.json' },
      ],
      [
        { timestamp: '2026-01-01', task: 'old', dir: '/p/.pi/checks/archive/old' },
        { timestamp: '', task: 'older', dir: '/p/.pi/checks/archive/older' },
      ],
    );
    expect(out).toBe(
      [
        'Tasks (2):',
        '  [active] default  - /p/.pi/checks/default.json',
        '  [draft] logo  - /p/.pi/checks/logo.draft.json',
        '',
        'Archive (2 entries):',
        '  2026-01-01  old  - /p/.pi/checks/archive/old',
        '  (no-ts)  older  - /p/.pi/checks/archive/older',
      ].join('\n'),
    );
  });

  test('uses the singular "entry" for one archived task and truncates past 10', () => {
    const single = formatListing([], [{ timestamp: 't', task: 'a', dir: 'd' }]);
    expect(single).toContain('Archive (1 entry):');

    const many = formatListing(
      [],
      Array.from({ length: 12 }, (_, i) => ({ timestamp: `t${i}`, task: `task${i}`, dir: `d${i}` })),
    );
    expect(many).toContain('Archive (12 entries):');
    expect(many.trimEnd().endsWith('  … 2 more')).toBe(true);
  });
});

describe('formatRunResultText', () => {
  test('renders the active-loop next-step body with no stop reason', () => {
    expect(
      formatRunResultText({
        summary: 'Iteration 1: score 0.50',
        verdict: { approved: false, score: 0.5, issues: [] },
        snapshot: { path: '/snap/iter-001.svg', hash: 'abc' },
        artifact: 'out.svg',
        bestSoFar: null,
        costUsd: 0.0123,
        stopReason: null,
        task: 'default',
      }),
    ).toBe(
      [
        'Iteration 1: score 0.50',
        'Snapshot: /snap/iter-001.svg',
        'Cost so far: $0.0123',
        'Next step: edit out.svg, then call `check run task=default` again.',
      ].join('\n'),
    );
  });

  test('previews at most three issues and counts the remainder', () => {
    const verdict: Verdict = {
      approved: false,
      score: 0.2,
      issues: [
        { severity: 'blocker', description: 'a', location: 'L1' },
        { severity: 'major', description: 'b' },
        { severity: 'minor', description: 'c' },
        { severity: 'minor', description: 'd' },
      ],
    };
    const out = formatRunResultText({
      summary: 's',
      verdict,
      snapshot: null,
      artifact: 'out.svg',
      bestSoFar: null,
      costUsd: 0,
      stopReason: null,
      task: 'default',
    });
    expect(out).toContain('Issues:');
    expect(out).toContain('  [blocker] a (L1)');
    expect(out).toContain('  [major] b');
    expect(out).toContain('  … 1 more');
    expect(out).toContain('Snapshot: (artifact "out.svg" not found on disk - fixpoint detection disabled)');
  });

  test('renders best-so-far and the passed close hint', () => {
    const bestSoFar: BestSoFar = {
      iteration: 2,
      score: 0.9,
      approved: true,
      snapshotPath: '/snap/iter-002.svg',
      artifactHash: 'h',
    };
    const out = formatRunResultText({
      summary: 's',
      verdict: emptyVerdict,
      snapshot: { path: '/snap/iter-002.svg', hash: 'h' },
      artifact: 'out.svg',
      bestSoFar,
      costUsd: 0.1,
      stopReason: 'passed',
      task: 'default',
    });
    expect(out).toContain('Best so far: iter 2 (score 0.90) → /snap/iter-002.svg');
    expect(out).toContain('Stop reason: passed');
    expect(out).toContain('Loop passed - call `check close task=default reason=passed` to archive it.');
  });

  test('renders the non-passing termination hint for a budget stop', () => {
    const out = formatRunResultText({
      summary: 's',
      verdict: emptyVerdict,
      snapshot: null,
      artifact: 'out.svg',
      bestSoFar: null,
      costUsd: 0,
      stopReason: 'budget-iter',
      task: 'default',
    });
    expect(out).toContain('Stop reason: budget-iter');
    expect(out).toContain(
      'Loop terminated without passing. Either `check close task=default reason=budget-iter` to archive the best-so-far, or edit the artifact / spec and re-declare.',
    );
  });
});
