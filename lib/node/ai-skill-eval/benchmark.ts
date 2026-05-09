// Aggregated benchmark output for ai-skill-eval (R3.2).
//
// Port of the statistical shape in skill-creator's `aggregate_benchmark.py`
// plus the `benchmark.json` schema in
// `~/.claude/skills/skill-creator/references/schemas.md`. A "benchmark" reads
// an existing workspace produced by `ai-skill-eval run` (optionally with
// `--baseline`) and emits two files per skill:
//
//   `<workspace>/<skill>/benchmark.json`
//   `<workspace>/<skill>/benchmark.md`
//
// Shape (matching skill-creator's schema so a future cross-harness viewer
// could consume the output):
//
//   - `metadata`: skill name, timestamp, evals_run[], runs_per_configuration.
//   - `runs[]`: one entry per (eval, config) pair. `run_number` is always 1
//     because our grader aggregates the per-query runs into a single
//     expectation grade; `result.pass_rate` is the eval-level
//     `expectation_pass / expectation_total`, and `result.time_seconds` /
//     `result.tokens` are per-eval means across the physical per-query runs.
//   - `run_summary[config]`: sample-stddev stats over the samples the config
//     produced (`pass_rate` across evals, `time_seconds` / `tokens` across
//     all physical runs). Sample stddev mirrors Python's
//     `statistics.stdev(data)` (divide by n-1); for fewer than 2 samples we
//     return `0` instead of raising.
//   - `run_summary.delta`: first config minus second (typically `with_skill`
//     minus `without_skill`). Strings so the schema stays sparse when a
//     metric is `null` in either half.
//   - `notes[]`: heuristic callouts (flaws surfaced during grading, configs
//     that had zero samples, …).
//
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadIterationGrades } from './grade-loader.ts';
import { listRunMetaFiles } from './run-files.ts';
import { type GradeConfig, type GradeRecord } from './types.ts';
import { iterationPath } from './workspace.ts';

const CONFIGS: readonly GradeConfig[] = ['with_skill', 'without_skill'];

/** Per-run metrics sidecar shape written by cli.ts after each driver call. */
export interface RunMetrics {
  exit_code: number;
  duration_sec: number;
  bytes: number;
  timed_out: boolean;
  tokens: number | null;
  tool_calls: number | null;
}

export interface MetricStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

/**
 * Per-config statistical block. Missing data (no runs, no token captures)
 * surfaces as `null` so downstream renderers can show an em-dash instead of
 * a fake zero.
 */
export interface ConfigStats {
  pass_rate: MetricStats | null;
  time_seconds: MetricStats | null;
  tokens: MetricStats | null;
  tool_calls: MetricStats | null;
}

export interface BenchmarkRun {
  eval_id: string;
  eval_name: string;
  configuration: GradeConfig;
  run_number: number;
  result: {
    pass_rate: number;
    passed: number;
    failed: number;
    total: number;
    time_seconds: number | null;
    tokens: number | null;
    tool_calls: number | null;
    errors: number;
  };
  expectations: { text: string; passed: boolean; evidence?: string }[];
  notes: string[];
}

export interface BenchmarkDelta {
  pass_rate: string | null;
  time_seconds: string | null;
  tokens: string | null;
}

export interface BenchmarkDocument {
  metadata: {
    skill_name: string;
    /** Which iteration-N subdir this benchmark was aggregated over. */
    iteration: number;
    timestamp: string;
    evals_run: string[];
    runs_per_configuration: number;
    configurations: GradeConfig[];
  };
  runs: BenchmarkRun[];
  run_summary: Record<GradeConfig, ConfigStats> & { delta?: BenchmarkDelta };
  notes: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Small primitives (defined first so downstream helpers can reference them
// without tripping eslint's no-use-before-define).
// ──────────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * First-minus-second difference formatted for the schema. `null` when either
 * side is missing the metric (e.g. tokens unavailable on the claude driver).
 * `kind` controls the unit suffix: pass_rate is rendered as a
 * percentage-point string, time_seconds in seconds, tokens as a raw count.
 */
function signedDelta(
  a: number | undefined,
  b: number | undefined,
  kind: 'percent' | 'seconds' | 'tokens',
): string | null {
  if (a == null || b == null) return null;
  const d = a - b;
  const sign = d >= 0 ? '+' : '';
  if (kind === 'percent') return `${sign}${Math.round(d * 100)}%`;
  if (kind === 'seconds') return `${sign}${round4(d)}s`;
  return `${sign}${Math.round(d)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Stats primitives
// ──────────────────────────────────────────────────────────────────────

/**
 * Mean / stddev / min / max of `values`. Returns `null` when the list is
 * empty; returns stddev `0` for single-sample lists (Python's
 * `statistics.stdev` would raise). Sample stddev (divide by n-1) matches
 * skill-creator's aggregator; values are rounded to 4 decimals so the JSON
 * stays terse and diff-friendly.
 */
export function stats(values: readonly number[]): MetricStats | null {
  if (values.length === 0) return null;
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  let stddev = 0;
  if (n >= 2) {
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    stddev = Math.sqrt(variance);
  }
  const min = values.reduce((m, v) => (v < m ? v : m), values[0] ?? 0);
  const max = values.reduce((m, v) => (v > m ? v : m), values[0] ?? 0);
  return {
    mean: round4(mean),
    stddev: round4(stddev),
    min: round4(min),
    max: round4(max),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Workspace loading
// ──────────────────────────────────────────────────────────────────────

/**
 * Load every grade record under
 * `<workspace>/<skill>/iteration-<N>/<config>/grades/*.json` and the
 * matching per-run `<resultFile>.meta.json` sidecars for that skill +
 * iteration. Only grade records for `skill` are returned; the meta-file map
 * is keyed by `<config>:<eval_id>` and holds the per-run metrics arrays in
 * run order.
 */
export function loadSkillArtifacts(
  workspace: string,
  skill: string,
  iteration: number,
): {
  grades: GradeRecord[];
  metas: Map<string, RunMetrics[]>;
} {
  const skillDir = iterationPath(workspace, skill, iteration);
  const metas = new Map<string, RunMetrics[]>();
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return { grades: [], metas };
  }
  // Grade records: delegate to the shared per-iteration loader so
  // report + benchmark stay in lockstep on parsing + backfill rules.
  const grades = loadIterationGrades(skillDir);
  for (const config of CONFIGS) {
    const resultsDir = join(skillDir, config, 'results');
    if (!existsSync(resultsDir)) continue;
    for (const evalId of readdirSync(resultsDir).sort()) {
      const evalDir = join(resultsDir, evalId);
      let st;
      try {
        st = statSync(evalDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const runMetas: RunMetrics[] = [];
      for (const metaPath of listRunMetaFiles(evalDir)) {
        try {
          runMetas.push(JSON.parse(readFileSync(metaPath, 'utf8')) as RunMetrics);
        } catch {
          // Skip malformed sidecars; the stats fall back to null.
        }
      }
      if (runMetas.length > 0) metas.set(`${config}:${evalId}`, runMetas);
    }
  }
  return { grades, metas };
}

// ──────────────────────────────────────────────────────────────────────
// Config-level helpers (used by buildBenchmark, defined above it).
// ──────────────────────────────────────────────────────────────────────

function buildConfigStats(bucket: { passRates: number[]; times: number[]; tokens: number[] }): ConfigStats {
  return {
    pass_rate: stats(bucket.passRates),
    time_seconds: stats(bucket.times),
    tokens: stats(bucket.tokens),
    tool_calls: null,
  };
}

function buildDelta(a: ConfigStats, b: ConfigStats): BenchmarkDelta {
  return {
    pass_rate: signedDelta(a.pass_rate?.mean, b.pass_rate?.mean, 'percent'),
    time_seconds: signedDelta(a.time_seconds?.mean, b.time_seconds?.mean, 'seconds'),
    tokens: signedDelta(a.tokens?.mean, b.tokens?.mean, 'tokens'),
  };
}

function buildNotes(grades: readonly GradeRecord[], configurations: readonly GradeConfig[]): string[] {
  const notes: string[] = [];
  const flaws = grades.flatMap((g) => (Array.isArray(g.flaws) ? g.flaws : []));
  const timeouts = flaws.filter((f) => /TIMEOUT/i.test(f)).length;
  if (timeouts > 0) notes.push(`Driver timeouts on ${timeouts} grade(s) \u2014 benchmark stats may be compressed`);
  if (configurations.length < 2) {
    notes.push(
      'Only one configuration present; delta block is omitted. Run with `--baseline` to populate without_skill stats.',
    );
  }
  return notes;
}

// ──────────────────────────────────────────────────────────────────────
// Document builder
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the {@link BenchmarkDocument} for one skill + iteration. Stats are
 * computed from the grade records (eval-level pass_rate) and the per-run
 * metrics sidecars (time_seconds, tokens) loaded from
 * `<workspace>/<skill>/iteration-<N>/`.
 */
export function buildBenchmark(
  workspace: string,
  skill: string,
  iteration: number,
  opts: { timestamp?: string } = {},
): BenchmarkDocument {
  const { grades, metas } = loadSkillArtifacts(workspace, skill, iteration);

  // Per-config collections: eval-level pass rates + flattened per-run
  // time/tokens samples.
  const perConfig: Record<GradeConfig, { passRates: number[]; times: number[]; tokens: number[] }> = {
    with_skill: { passRates: [], times: [], tokens: [] },
    without_skill: { passRates: [], times: [], tokens: [] },
  };
  const runs: BenchmarkRun[] = [];
  const evalIds = new Set<string>();
  let maxRunsPerConfig = 0;

  for (const g of grades) {
    evalIds.add(g.eval_id);
    const config = g.config ?? 'with_skill';
    const runMetas = metas.get(`${config}:${g.eval_id}`) ?? [];
    maxRunsPerConfig = Math.max(maxRunsPerConfig, runMetas.length || g.runs || 0);

    const passed = g.expectation_pass ?? 0;
    const total = g.expectation_total ?? 0;
    const pr = total > 0 ? passed / total : 0;
    perConfig[config].passRates.push(pr);
    for (const rm of runMetas) {
      if (Number.isFinite(rm.duration_sec)) perConfig[config].times.push(rm.duration_sec);
      if (rm.tokens != null && Number.isFinite(rm.tokens)) perConfig[config].tokens.push(rm.tokens);
    }

    const timeSamples = runMetas.map((rm) => rm.duration_sec).filter((n) => Number.isFinite(n));
    const tokenSamples = runMetas.map((rm) => rm.tokens).filter((n): n is number => n != null && Number.isFinite(n));
    runs.push({
      eval_id: g.eval_id,
      eval_name: g.eval_id,
      configuration: config,
      run_number: 1,
      result: {
        pass_rate: round4(pr),
        passed,
        failed: total - passed,
        total,
        time_seconds: timeSamples.length > 0 ? round4(avg(timeSamples)) : null,
        tokens: tokenSamples.length > 0 ? round4(avg(tokenSamples)) : null,
        tool_calls: null,
        errors: runMetas.filter((rm) => rm.exit_code !== 0 || rm.timed_out).length,
      },
      expectations: (g.expectations ?? []).map((e) => ({
        text: e.text,
        passed: e.passed,
        evidence: e.note,
      })),
      notes: Array.isArray(g.flaws) ? [...g.flaws] : [],
    });
  }

  const summary: Record<GradeConfig, ConfigStats> & { delta?: BenchmarkDelta } = {
    with_skill: buildConfigStats(perConfig.with_skill),
    without_skill: buildConfigStats(perConfig.without_skill),
  };
  const configurations: GradeConfig[] = [];
  if (perConfig.with_skill.passRates.length > 0) configurations.push('with_skill');
  if (perConfig.without_skill.passRates.length > 0) configurations.push('without_skill');
  if (configurations.length >= 2) {
    summary.delta = buildDelta(summary[configurations[0]], summary[configurations[1]]);
  }

  const notes = buildNotes(grades, configurations);

  return {
    metadata: {
      skill_name: skill,
      iteration,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      evals_run: [...evalIds].sort(),
      runs_per_configuration: maxRunsPerConfig,
      configurations,
    },
    runs,
    run_summary: summary,
    notes,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────

function formatStatsCell(s: MetricStats | null, kind: 'percent' | 'seconds' | 'tokens' | 'tool_calls'): string {
  if (s == null) return '\u2014';
  if (kind === 'percent') {
    const meanPct = Math.round(s.mean * 100);
    const sdPct = Math.round(s.stddev * 100);
    return `${meanPct}% ± ${sdPct}%`;
  }
  if (kind === 'seconds') return `${s.mean.toFixed(2)}s ± ${s.stddev.toFixed(2)}s`;
  if (kind === 'tokens') return `${Math.round(s.mean)} ± ${Math.round(s.stddev)}`;
  return '\u2014';
}

function renderRow(
  doc: BenchmarkDocument,
  label: string,
  key: keyof ConfigStats,
  kind: 'percent' | 'seconds' | 'tokens' | 'tool_calls',
): string {
  const cells: string[] = [label];
  const configs = doc.metadata.configurations;
  for (const cfg of configs) cells.push(formatStatsCell(doc.run_summary[cfg][key], kind));
  if (configs.length >= 2) {
    const delta = doc.run_summary.delta;
    const value =
      key === 'pass_rate'
        ? delta?.pass_rate
        : key === 'time_seconds'
          ? delta?.time_seconds
          : key === 'tokens'
            ? delta?.tokens
            : null;
    cells.push(key === 'tool_calls' || value == null ? '\u2014' : value);
  }
  return `| ${cells.join(' | ')} |`;
}

/**
 * Render a human-readable markdown table matching skill-creator's benchmark
 * report: `X% ± Y%` cells for pass-rate, `Xs ± Ys` for time, raw counts for
 * tokens, with a delta column on the right. Missing metrics are shown as a
 * dash instead of `NaN` / `null`.
 */
export function renderBenchmarkMarkdown(doc: BenchmarkDocument): string {
  const lines: string[] = [
    `# Benchmark \u2014 ${doc.metadata.skill_name} (iteration-${doc.metadata.iteration})`,
    '',
    `- Generated: \`${doc.metadata.timestamp}\``,
    `- Evals: ${doc.metadata.evals_run.length} (${doc.metadata.evals_run.join(', ') || '\u2014'})`,
    `- Runs per configuration: ${doc.metadata.runs_per_configuration}`,
    `- Configurations: ${doc.metadata.configurations.join(', ') || '\u2014'}`,
    '',
  ];

  const configs = doc.metadata.configurations;
  if (configs.length === 0) {
    lines.push('_No configurations found. Run `ai-skill-eval run` first._', '');
    return `${lines.join('\n')}\n`;
  }

  const headerCells: string[] = ['Metric', ...configs, ...(configs.length >= 2 ? ['Δ'] : [])];
  lines.push(`| ${headerCells.join(' | ')} |`, `|${headerCells.map(() => '---').join('|')}|`);

  lines.push(
    renderRow(doc, 'pass_rate', 'pass_rate', 'percent'),
    renderRow(doc, 'time_seconds', 'time_seconds', 'seconds'),
    renderRow(doc, 'tokens', 'tokens', 'tokens'),
    renderRow(doc, 'tool_calls', 'tool_calls', 'tool_calls'),
  );

  if (doc.notes.length > 0) {
    lines.push('', '## Notes', '');
    for (const n of doc.notes) lines.push(`- ${n}`);
  }

  return `${lines.join('\n')}\n`;
}

// ──────────────────────────────────────────────────────────────────────
// Workspace writer
// ──────────────────────────────────────────────────────────────────────

/**
 * Build, render, and persist benchmark artifacts for `skill` + `iteration`
 * under `<workspace>/<skill>/iteration-<N>/benchmark.{json,md}`. Returns the
 * constructed document so callers (notably the CLI) can inspect or print it.
 */
export function writeBenchmark(
  workspace: string,
  skill: string,
  iteration: number,
  opts: { timestamp?: string } = {},
): BenchmarkDocument {
  const doc = buildBenchmark(workspace, skill, iteration, opts);
  const iterDir = iterationPath(workspace, skill, iteration);
  writeFileSync(join(iterDir, 'benchmark.json'), `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(join(iterDir, 'benchmark.md'), renderBenchmarkMarkdown(doc));
  return doc;
}
