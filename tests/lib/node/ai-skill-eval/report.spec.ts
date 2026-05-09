// Tests for lib/node/ai-skill-eval/report.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  hasFailures,
  loadGrades,
  renderJson,
  renderMarkdown,
  summarize,
} from '../../../../lib/node/ai-skill-eval/report.ts';
import { type GradeRecord } from '../../../../lib/node/ai-skill-eval/types.ts';

function grade(partial: Partial<GradeRecord>): GradeRecord {
  return {
    skill: 'sample',
    eval_id: 'positive-1',
    should_trigger: true,
    got_trigger: 'yes',
    trigger_pass: true,
    reason: 'r',
    next_step: 's',
    expectations: [{ text: 'e', passed: true, note: 'matched' }],
    expectation_pass: 1,
    expectation_total: 1,
    grader: 'deterministic',
    ...partial,
  };
}

describe('summarize', () => {
  test('counts trigger_pass and sums expectation columns', () => {
    const grades = [
      grade({ trigger_pass: true, expectation_pass: 2, expectation_total: 3 }),
      grade({ trigger_pass: false, expectation_pass: 0, expectation_total: 2 }),
    ];

    expect(summarize(grades)).toEqual({
      total_evals: 2,
      trigger_correct: 1,
      expectation_pass: 2,
      expectation_total: 5,
    });
  });

  test('returns zeroes for an empty grade list', () => {
    expect(summarize([])).toEqual({
      total_evals: 0,
      trigger_correct: 0,
      expectation_pass: 0,
      expectation_total: 0,
    });
  });
});

describe('hasFailures', () => {
  test('true when there are no evals', () => {
    expect(hasFailures({ total_evals: 0, trigger_correct: 0, expectation_pass: 0, expectation_total: 0 })).toBe(true);
  });

  test('true when any TRIGGER was mis-detected', () => {
    expect(hasFailures({ total_evals: 3, trigger_correct: 2, expectation_pass: 5, expectation_total: 6 })).toBe(true);
  });

  test('false when every TRIGGER matched expectation', () => {
    expect(hasFailures({ total_evals: 3, trigger_correct: 3, expectation_pass: 4, expectation_total: 9 })).toBe(false);
  });
});

describe('renderJson', () => {
  test('embeds summary + evals in a stable JSON shape', () => {
    const out = renderJson([grade({})]);
    const parsed = JSON.parse(out) as { summary: { total_evals: number }; evals: GradeRecord[] };

    expect(parsed.summary.total_evals).toBe(1);
    expect(parsed.evals).toHaveLength(1);
  });
});

describe('renderMarkdown', () => {
  test('includes header, summary bullets, and the per-eval table', () => {
    const out = renderMarkdown([grade({})]);

    expect(out).toContain('# ai-skill-eval report');
    expect(out).toContain('Correct TRIGGER detection: **1/1**');
    expect(out).toContain('| sample | positive-1 |');
  });

  test('renders critic flaws when the grade carries them', () => {
    const out = renderMarkdown([grade({ flaws: ['critic-flaw-1'] })]);

    expect(out).toContain('Critic flaws:');
    expect(out).toContain('critic-flaw-1');
  });

  test('marks trigger_pass=false with the wrong glyph', () => {
    const out = renderMarkdown([grade({ trigger_pass: false })]);

    expect(out).toContain('❌ wrong');
  });
});

describe('loadGrades', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ai-skill-eval-report-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test('returns an empty list when the workspace has no skill subdirectories', () => {
    expect(loadGrades(ws, [])).toEqual([]);
  });

  test('loads grade.json files across skill subdirectories in sorted order', () => {
    const dirA = join(ws, 'alpha', 'grades');
    const dirB = join(ws, 'beta', 'grades');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, 'a.json'), JSON.stringify(grade({ skill: 'alpha' })));
    writeFileSync(join(dirB, 'b.json'), JSON.stringify(grade({ skill: 'beta' })));

    const loaded = loadGrades(ws, []);

    expect(loaded.map((g) => g.skill)).toEqual(['alpha', 'beta']);
  });

  test('respects the "wanted" filter', () => {
    const dir = join(ws, 'alpha', 'grades');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), JSON.stringify(grade({ skill: 'alpha' })));

    expect(loadGrades(ws, ['beta'])).toHaveLength(0);
  });

  test('ignores malformed grade files', () => {
    const dir = join(ws, 'alpha', 'grades');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), 'not json');

    expect(loadGrades(ws, [])).toEqual([]);
  });

  test('throws when the workspace does not exist', () => {
    expect(() => loadGrades('/tmp/does-not-exist-ai-skill-eval', [])).toThrow('does not exist');
  });
});
