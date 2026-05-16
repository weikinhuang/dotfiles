// Tests for lib/node/ai-skill-eval/report.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  groupByConfig,
  hasFailures,
  loadGrades,
  renderCrossIterationMarkdown,
  renderJson,
  renderMarkdown,
  summarize,
} from '../../../../lib/node/ai-skill-eval/report.ts';
import { type GradeRecord } from '../../../../lib/node/ai-skill-eval/types.ts';

function grade(partial: Partial<GradeRecord>): GradeRecord {
  return {
    skill: 'sample',
    eval_id: 'positive-1',
    config: 'with_skill',
    should_trigger: true,
    runs: 3,
    triggers: 2,
    trigger_rate: 0.67,
    trigger_pass: true,
    per_run: [
      { trigger: 'yes', reason: 'r1', next_step: 's1' },
      { trigger: 'yes', reason: 'r2', next_step: 's2' },
      { trigger: 'no', reason: 'r3', next_step: 's3' },
    ],
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
    const parsed = JSON.parse(out) as {
      summary: { total_evals: number };
      summary_by_config: { with_skill: { total_evals: number } };
      evals: GradeRecord[];
    };

    expect(parsed.summary.total_evals).toBe(1);
    expect(parsed.summary_by_config.with_skill.total_evals).toBe(1);
    expect(parsed.evals).toHaveLength(1);
    expect(parsed.evals[0]?.trigger_rate).toBe(0.67);
    expect(parsed.evals[0]?.runs).toBe(3);
    expect(parsed.evals[0]?.triggers).toBe(2);
    expect(parsed.evals[0]?.config).toBe('with_skill');
  });

  test('summary_by_config carries a without_skill block when baseline grades exist', () => {
    const out = renderJson([grade({ config: 'with_skill' }), grade({ config: 'without_skill' })]);
    const parsed = JSON.parse(out) as {
      summary_by_config: Record<string, { total_evals: number }>;
    };

    expect(parsed.summary_by_config.with_skill?.total_evals).toBe(1);
    expect(parsed.summary_by_config.without_skill?.total_evals).toBe(1);
  });
});

describe('renderMarkdown', () => {
  test('includes header, summary bullets, and the per-eval table', () => {
    const out = renderMarkdown([grade({})]);

    expect(out).toContain('# ai-skill-eval report');
    expect(out).toContain('Correct TRIGGER detection: **1/1**');
    expect(out).toContain('| sample | positive-1 |');
  });

  test('per-eval table has a trigger-rate column showing N/M', () => {
    const out = renderMarkdown([grade({})]);

    expect(out).toContain('| Skill | Eval | Expected | Trigger rate | Trigger | Expectations |');
    expect(out).toMatch(/\| sample \| positive-1 \| yes \| 2\/3 \|/);
  });

  test('detail section shows trigger rate + each per-run reply', () => {
    const out = renderMarkdown([grade({})]);

    expect(out).toContain('Trigger rate:** 2/3 (0.67)');
    expect(out).toContain('Per-run replies:');
    expect(out).toContain('Run 1: `yes`');
    expect(out).toContain('Run 3: `no`');
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

  test('baseline run emits side-by-side with_skill vs without_skill table, Δ column, and the should_trigger=false footer note', () => {
    const withSkill = grade({
      config: 'with_skill',
      triggers: 3,
      runs: 3,
      trigger_rate: 1,
      trigger_pass: true,
    });
    const withoutSkill = grade({
      config: 'without_skill',
      triggers: 1,
      runs: 3,
      trigger_rate: 0.33,
      trigger_pass: false,
    });

    const out = renderMarkdown([withSkill, withoutSkill]);

    // Per-config summary blocks present.
    expect(out).toContain('## with_skill');
    expect(out).toContain('## without_skill (baseline)');
    // Side-by-side table header and Δ column.
    expect(out).toContain(
      '| Skill | Eval | Expected | with_skill rate | without_skill rate | Δ trigger rate | with_skill pass | without_skill pass |',
    );
    // Row shows both rates and a signed delta (1.00 - 0.33 ≈ +67%).
    expect(out).toMatch(/\| sample \| positive-1 \| yes \| 3\/3 \(1\.00\) \| 1\/3 \(0\.33\) \| \+67% \| ✅ \| ❌ \|/);
    // Detail sections are tagged with their config.
    expect(out).toContain('### sample / positive-1 [with_skill]');
    expect(out).toContain('### sample / positive-1 [without_skill]');
    // Footer calls out the should_trigger=false asymmetry.
    expect(out).toMatch(/should_trigger=false.+baseline/);
    expect(out).toMatch(/NOT evidence that the skill helped/);
  });

  test('baseline-less report omits the config-specific blocks and footer', () => {
    const out = renderMarkdown([grade({})]);

    expect(out).not.toContain('## with_skill');
    expect(out).not.toContain('## without_skill');
    expect(out).not.toContain('NOT evidence that the skill helped');
  });
});

describe('groupByConfig', () => {
  test('buckets grades into with_skill / without_skill arrays', () => {
    const w = grade({ config: 'with_skill' });
    const b = grade({ config: 'without_skill', eval_id: 'positive-2' });
    const groups = groupByConfig([w, b, w]);

    expect(groups.with_skill).toHaveLength(2);
    expect(groups.without_skill).toHaveLength(1);
    expect(groups.without_skill[0]?.eval_id).toBe('positive-2');
  });

  test('defaults grades with an unexpected config value to the with_skill bucket', () => {
    const mystery = { ...grade({}), config: 'legacy' as 'with_skill' };
    const groups = groupByConfig([mystery]);

    expect(groups.with_skill).toHaveLength(1);
    expect(groups.without_skill).toHaveLength(0);
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
    const dirA = join(ws, 'alpha', 'iteration-1', 'with_skill', 'grades');
    const dirB = join(ws, 'beta', 'iteration-1', 'with_skill', 'grades');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, 'a.json'), JSON.stringify(grade({ skill: 'alpha' })));
    writeFileSync(join(dirB, 'b.json'), JSON.stringify(grade({ skill: 'beta' })));

    const loaded = loadGrades(ws, []);

    expect(loaded.map((g) => g.skill)).toEqual(['alpha', 'beta']);
  });

  test('loads with_skill and without_skill grades and tags each with its config', () => {
    const withDir = join(ws, 'sample', 'iteration-1', 'with_skill', 'grades');
    const withoutDir = join(ws, 'sample', 'iteration-1', 'without_skill', 'grades');
    mkdirSync(withDir, { recursive: true });
    mkdirSync(withoutDir, { recursive: true });
    writeFileSync(join(withDir, 'positive-1.json'), JSON.stringify(grade({ config: 'with_skill' })));
    // Older grade files missing `config` should be stamped by the loader.
    const baselineRaw = { ...grade({ trigger_pass: false }) } as Record<string, unknown>;
    delete baselineRaw.config;
    writeFileSync(join(withoutDir, 'positive-1.json'), JSON.stringify(baselineRaw));

    const loaded = loadGrades(ws, []);
    const configs = loaded.map((g) => g.config).sort();

    expect(configs).toEqual(['with_skill', 'without_skill']);
    expect(loaded.every((g) => g.skill === 'sample')).toBe(true);
  });

  test('respects the "wanted" filter', () => {
    const dir = join(ws, 'alpha', 'iteration-1', 'with_skill', 'grades');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), JSON.stringify(grade({ skill: 'alpha' })));

    expect(loadGrades(ws, ['beta'])).toHaveLength(0);
  });

  test('ignores malformed grade files', () => {
    const dir = join(ws, 'alpha', 'iteration-1', 'with_skill', 'grades');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), 'not json');

    expect(loadGrades(ws, [])).toEqual([]);
  });

  test('picks the latest iteration by default', () => {
    const iter1 = join(ws, 'sample', 'iteration-1', 'with_skill', 'grades');
    const iter2 = join(ws, 'sample', 'iteration-2', 'with_skill', 'grades');
    mkdirSync(iter1, { recursive: true });
    mkdirSync(iter2, { recursive: true });
    writeFileSync(join(iter1, 'positive-1.json'), JSON.stringify(grade({ eval_id: 'iter1' })));
    writeFileSync(join(iter2, 'positive-1.json'), JSON.stringify(grade({ eval_id: 'iter2' })));

    expect(loadGrades(ws, [])[0]?.eval_id).toBe('iter2');
  });

  test('explicit iteration overrides the default latest', () => {
    const iter1 = join(ws, 'sample', 'iteration-1', 'with_skill', 'grades');
    const iter2 = join(ws, 'sample', 'iteration-2', 'with_skill', 'grades');
    mkdirSync(iter1, { recursive: true });
    mkdirSync(iter2, { recursive: true });
    writeFileSync(join(iter1, 'positive-1.json'), JSON.stringify(grade({ eval_id: 'iter1' })));
    writeFileSync(join(iter2, 'positive-1.json'), JSON.stringify(grade({ eval_id: 'iter2' })));

    expect(loadGrades(ws, [], 1)[0]?.eval_id).toBe('iter1');
  });

  test('silently skips skills missing the requested iteration', () => {
    const dir = join(ws, 'sample', 'iteration-2', 'with_skill', 'grades');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'positive-1.json'), JSON.stringify(grade({})));

    expect(loadGrades(ws, [], 99)).toEqual([]);
  });

  test('throws when the workspace does not exist', () => {
    expect(() => loadGrades('/tmp/does-not-exist-ai-skill-eval', [])).toThrow('does not exist');
  });
});

describe('renderCrossIterationMarkdown', () => {
  test('emits a delta table pairing primary vs baseline rows by (skill, eval_id, config)', () => {
    const primary = [grade({ eval_id: 'e1', trigger_rate: 1, expectation_pass: 2, expectation_total: 2 })];
    const compared = [grade({ eval_id: 'e1', trigger_rate: 0.5, expectation_pass: 1, expectation_total: 2 })];

    const out = renderCrossIterationMarkdown(primary, compared, 1);

    expect(out).toContain('Cross-iteration Δ (baseline: iteration-1)');
    expect(out).toContain('| sample | e1 | with_skill | 2/3 | 2/3 | +50% | 2/2 | 1/2 | +50% |');
  });

  test('shows em-dash placeholders when a row exists only on one side', () => {
    const primary = [grade({ eval_id: 'only-in-primary' })];
    const compared = [grade({ eval_id: 'only-in-baseline' })];

    const out = renderCrossIterationMarkdown(primary, compared, 1);

    expect(out).toContain('only-in-primary');
    expect(out).toContain('only-in-baseline');
    // Baseline-only row: primary side filled with em-dashes.
    expect(out).toMatch(/\| sample \| only-in-baseline \|.*\| - \|/);
  });
});
