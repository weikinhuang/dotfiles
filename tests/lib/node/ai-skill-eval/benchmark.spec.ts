// Tests for lib/node/ai-skill-eval/benchmark.ts.
//
// Fixtures build a miniature workspace on disk with the exact file shape
// `ai-skill-eval run` would leave behind: grade JSONs under
// `<workspace>/<skill>/<config>/grades/`, run-file metrics sidecars under
// `<workspace>/<skill>/<config>/results/<eval>/run-N.txt.meta.json`. Then
// we exercise the benchmark builder + renderer end-to-end.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildBenchmark,
  loadSkillArtifacts,
  renderBenchmarkMarkdown,
  stats,
  writeBenchmark,
  type RunMetrics,
} from '../../../../lib/node/ai-skill-eval/benchmark.ts';
import { type GradeConfig, type GradeRecord } from '../../../../lib/node/ai-skill-eval/types.ts';

interface Fixture {
  dir: string;
  skill: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ai-skill-eval-benchmark-'));
  return { dir, skill: 'sample' };
}

function seedGrade(
  workspace: string,
  skill: string,
  config: GradeConfig,
  evalId: string,
  overrides: Partial<GradeRecord> = {},
  iteration = 1,
): GradeRecord {
  const grade: GradeRecord = {
    skill,
    eval_id: evalId,
    config,
    should_trigger: true,
    runs: 3,
    triggers: 3,
    trigger_rate: 1.0,
    trigger_pass: true,
    per_run: [],
    expectations: [
      { text: 'e1', passed: true, note: 'ok' },
      { text: 'e2', passed: true, note: 'ok' },
    ],
    expectation_pass: 2,
    expectation_total: 2,
    grader: 'deterministic',
    ...overrides,
  };
  const gradesDir = join(workspace, skill, `iteration-${iteration}`, config, 'grades');
  mkdirSync(gradesDir, { recursive: true });
  writeFileSync(join(gradesDir, `${evalId}.json`), JSON.stringify(grade, null, 2));
  return grade;
}

function seedRuns(
  workspace: string,
  skill: string,
  config: GradeConfig,
  evalId: string,
  runs: readonly RunMetrics[],
  iteration = 1,
): void {
  const dir = join(workspace, skill, `iteration-${iteration}`, config, 'results', evalId);
  mkdirSync(dir, { recursive: true });
  runs.forEach((meta, i) => {
    const runFile = join(dir, `run-${i + 1}.txt`);
    writeFileSync(runFile, 'TRIGGER: yes\nREASON: r\nNEXT_STEP: s\n');
    writeFileSync(`${runFile}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  });
}

describe('stats', () => {
  test('returns null on empty input', () => {
    expect(stats([])).toBeNull();
  });

  test('single sample: stddev is 0 and min/max equal the mean', () => {
    expect(stats([5])).toEqual({ mean: 5, stddev: 0, min: 5, max: 5 });
  });

  test('multiple samples: uses sample (n-1) stddev, rounds to 4 decimals', () => {
    const r = stats([1, 2, 3, 4, 5]);

    // mean = 3; variance (sample) = sum((x-3)^2)/(n-1) = 10/4 = 2.5; stddev ≈ 1.5811
    expect(r).toEqual({ mean: 3, stddev: 1.5811, min: 1, max: 5 });
  });

  test('pass-rate percentages: retains fractional precision', () => {
    const r = stats([1.0, 1.0, 0.5]);

    // mean = 0.8333..., stddev(n-1) = sqrt(((1-0.833)^2*2 + (0.5-0.833)^2)/2) ≈ 0.2887
    expect(r?.mean).toBeCloseTo(0.8333, 3);
    expect(r?.min).toBe(0.5);
    expect(r?.max).toBe(1);
  });
});

describe('loadSkillArtifacts', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('collects grades + meta sidecars for every config subtree', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1');
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 2.5, bytes: 100, timed_out: false, tokens: 200, tool_calls: null },
      { exit_code: 0, duration_sec: 3.0, bytes: 120, timed_out: false, tokens: 250, tool_calls: null },
    ]);
    seedGrade(fx.dir, fx.skill, 'without_skill', 'e1', { expectation_pass: 1 });
    seedRuns(fx.dir, fx.skill, 'without_skill', 'e1', [
      { exit_code: 0, duration_sec: 1.0, bytes: 50, timed_out: false, tokens: 100, tool_calls: null },
    ]);

    const { grades, metas } = loadSkillArtifacts(fx.dir, fx.skill, 1);

    expect(grades).toHaveLength(2);
    expect(metas.get('with_skill:e1')).toHaveLength(2);
    expect(metas.get('without_skill:e1')).toHaveLength(1);
  });

  test('missing skill directory returns empty sets (no throw)', () => {
    const { grades, metas } = loadSkillArtifacts(fx.dir, 'nonexistent', 1);

    expect(grades).toHaveLength(0);
    expect(metas.size).toBe(0);
  });
});

describe('buildBenchmark', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('produces one run entry per (eval, config) pair with pass_rate from expectations', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1', { expectation_pass: 2, expectation_total: 2 });
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e2', { expectation_pass: 1, expectation_total: 2 });
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 2, bytes: 100, timed_out: false, tokens: 200, tool_calls: null },
    ]);
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e2', [
      { exit_code: 0, duration_sec: 4, bytes: 100, timed_out: false, tokens: 400, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1, { timestamp: '2026-01-01T00:00:00Z' });

    expect(doc.metadata.skill_name).toBe('sample');
    expect(doc.metadata.evals_run).toEqual(['e1', 'e2']);
    expect(doc.metadata.configurations).toEqual(['with_skill']);
    expect(doc.runs).toHaveLength(2);

    const byId = Object.fromEntries(doc.runs.map((r) => [r.eval_id, r]));

    expect(byId.e1?.result.pass_rate).toBe(1);
    expect(byId.e2?.result.pass_rate).toBe(0.5);
    expect(byId.e1?.configuration).toBe('with_skill');
  });

  test('delta block present when both configs have data and signs point from first - second', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1', { expectation_pass: 2, expectation_total: 2 });
    seedGrade(fx.dir, fx.skill, 'without_skill', 'e1', { expectation_pass: 1, expectation_total: 2 });
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 3, bytes: 100, timed_out: false, tokens: 300, tool_calls: null },
    ]);
    seedRuns(fx.dir, fx.skill, 'without_skill', 'e1', [
      { exit_code: 0, duration_sec: 2, bytes: 100, timed_out: false, tokens: 150, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1, { timestamp: '2026-01-01T00:00:00Z' });

    expect(doc.metadata.configurations).toEqual(['with_skill', 'without_skill']);
    expect(doc.run_summary.delta).toEqual({
      pass_rate: '+50%',
      time_seconds: '+1s',
      tokens: '+150',
    });
  });

  test('negative deltas keep the sign', () => {
    // without_skill is "better" on time_seconds (faster); with - without is negative.
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1');
    seedGrade(fx.dir, fx.skill, 'without_skill', 'e1');
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 10, bytes: 100, timed_out: false, tokens: 1000, tool_calls: null },
    ]);
    seedRuns(fx.dir, fx.skill, 'without_skill', 'e1', [
      { exit_code: 0, duration_sec: 15, bytes: 100, timed_out: false, tokens: 1200, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1);

    expect(doc.run_summary.delta?.time_seconds).toBe('-5s');
    expect(doc.run_summary.delta?.tokens).toBe('-200');
  });

  test('tokens == null across all runs keeps the tokens stats block null', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1');
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 2, bytes: 100, timed_out: false, tokens: null, tool_calls: null },
      { exit_code: 0, duration_sec: 3, bytes: 100, timed_out: false, tokens: null, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1);

    expect(doc.run_summary.with_skill.tokens).toBeNull();
    expect(doc.run_summary.with_skill.time_seconds).not.toBeNull();
  });

  test('notes surface DRIVER_TIMEOUT flaws from the grades', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1', {
      flaws: ['DRIVER_TIMEOUT on 1/3 run(s)'],
    });
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 2, bytes: 100, timed_out: false, tokens: 100, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1);

    expect(doc.notes.some((n) => /timeouts/i.test(n))).toBe(true);
  });

  test('single configuration surfaces a note and no delta block', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1');
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 2, bytes: 100, timed_out: false, tokens: 100, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1);

    expect(doc.run_summary.delta).toBeUndefined();
    expect(doc.notes.some((n) => /baseline/i.test(n))).toBe(true);
  });
});

describe('renderBenchmarkMarkdown', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('two-config doc renders a four-column table with percent / seconds / token cells and a delta column', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1', { expectation_pass: 2, expectation_total: 2 });
    seedGrade(fx.dir, fx.skill, 'without_skill', 'e1', { expectation_pass: 1, expectation_total: 2 });
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 3.0, bytes: 100, timed_out: false, tokens: 300, tool_calls: null },
    ]);
    seedRuns(fx.dir, fx.skill, 'without_skill', 'e1', [
      { exit_code: 0, duration_sec: 2.0, bytes: 100, timed_out: false, tokens: 150, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1, { timestamp: '2026-01-01T00:00:00Z' });
    const md = renderBenchmarkMarkdown(doc);

    expect(md).toContain('# Benchmark - sample');
    expect(md).toContain('| Metric | with_skill | without_skill | Δ |');
    // Pass-rate row rendered in X% ± Y% form.
    expect(md).toContain('| pass_rate | 100% ± 0% | 50% ± 0% | +50% |');
    // time_seconds uses Xs ± Ys.
    expect(md).toContain('| time_seconds | 3.00s ± 0.00s | 2.00s ± 0.00s | +1s |');
    // tokens bare counts.
    expect(md).toContain('| tokens | 300 ± 0 | 150 ± 0 | +150 |');
    // tool_calls not captured yet; em-dashes all the way across.
    expect(md).toContain('| tool_calls | - | - | - |');
  });

  test('single-config doc omits the delta column', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1');
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 2, bytes: 100, timed_out: false, tokens: 200, tool_calls: null },
    ]);

    const doc = buildBenchmark(fx.dir, fx.skill, 1);
    const md = renderBenchmarkMarkdown(doc);

    expect(md).toContain('| Metric | with_skill |');
    expect(md).not.toContain('| Metric | with_skill | without_skill |');
    expect(md).not.toContain(' | Δ |');
  });

  test('no configurations at all renders the "run first" hint', () => {
    const doc = buildBenchmark(fx.dir, fx.skill, 1);
    const md = renderBenchmarkMarkdown(doc);

    expect(md).toContain('No configurations found');
  });
});

describe('writeBenchmark', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('writes benchmark.json + benchmark.md and returns the doc', () => {
    seedGrade(fx.dir, fx.skill, 'with_skill', 'e1');
    seedRuns(fx.dir, fx.skill, 'with_skill', 'e1', [
      { exit_code: 0, duration_sec: 2, bytes: 100, timed_out: false, tokens: 200, tool_calls: null },
    ]);

    const doc = writeBenchmark(fx.dir, fx.skill, 1, { timestamp: '2026-01-01T00:00:00Z' });

    const jsonText = readFileSync(join(fx.dir, fx.skill, 'iteration-1', 'benchmark.json'), 'utf8');

    expect(JSON.parse(jsonText).metadata.skill_name).toBe('sample');
    expect(JSON.parse(jsonText).metadata.iteration).toBe(1);
    expect(readFileSync(join(fx.dir, fx.skill, 'iteration-1', 'benchmark.md'), 'utf8')).toContain(
      '# Benchmark - sample (iteration-1)',
    );
    expect(doc.metadata.skill_name).toBe('sample');
  });
});
