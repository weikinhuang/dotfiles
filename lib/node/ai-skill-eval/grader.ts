// Deterministic grading for ai-skill-eval: parses each run's reply, aggregates
// TRIGGER detection across N runs into a trigger_rate, and scores each
// expectation against a keyword-match heuristic applied to the majority run.
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { type ExpectationResult, type GradeConfig, type GradeRecord, type ParsedReply } from './types.ts';

export const DEFAULT_TRIGGER_THRESHOLD = 0.5;

/**
 * Parse the model's reply into its three structured fields. Lines that are
 * not one of the TRIGGER / REASON / NEXT_STEP labels get appended to the
 * currently-open field so multi-line values survive.
 */
export function parseReply(text: string): ParsedReply {
  const acc: Record<'TRIGGER' | 'REASON' | 'NEXT_STEP', string[]> = {
    TRIGGER: [],
    REASON: [],
    NEXT_STEP: [],
  };
  let current: 'TRIGGER' | 'REASON' | 'NEXT_STEP' | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(TRIGGER|REASON|NEXT_STEP):\s*(.*)$/.exec(line);
    if (m) {
      current = m[1] as 'TRIGGER' | 'REASON' | 'NEXT_STEP';
      acc[current].push(m[2] ?? '');
      continue;
    }
    if (current && line) acc[current].push(line);
  }
  return {
    trigger: acc.TRIGGER.join(' ').trim(),
    reason: acc.REASON.join(' ').trim(),
    next_step: acc.NEXT_STEP.join(' ').trim(),
  };
}

/** True when a parsed TRIGGER field began with "yes" (case-insensitive). */
export function isTrigger(run: ParsedReply): boolean {
  return run.trigger.toLowerCase().startsWith('yes');
}

/**
 * Round a trigger-rate ratio to 2 decimal places so the JSON grade + markdown
 * report show a stable, terse value (e.g. 2/3 -> 0.67 instead of 0.6666...).
 */
export function roundTriggerRate(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pick the index of the run whose TRIGGER vote matched the majority. When the
 * vote is tied we return 0 (the first run) so expectation grading stays
 * deterministic regardless of run ordering.
 */
export function pickMajorityRunIndex(perRun: readonly ParsedReply[]): number {
  if (perRun.length === 0) return 0;
  const triggers = perRun.filter(isTrigger).length;
  const n = perRun.length;
  if (triggers * 2 > n) {
    const idx = perRun.findIndex(isTrigger);
    return idx >= 0 ? idx : 0;
  }
  if (triggers * 2 < n) {
    const idx = perRun.findIndex((r) => !isTrigger(r));
    return idx >= 0 ? idx : 0;
  }
  return 0;
}

/**
 * Pull a small set of lower-cased, deduplicated keywords out of an expectation
 * string. Order of precedence: backtick-quoted terms, path-like tokens,
 * file-name-with-extension tokens, then a small curated command vocabulary
 * (shellcheck / bats / ./dev/*.sh / ...).
 */
export function keywordsFor(expectation: string): string[] {
  const quoted = [...expectation.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  const paths = [...expectation.matchAll(/[\w./-]+(?:\/[\w./-]+)+/g)].map((m) => m[0]);
  const files = [...expectation.matchAll(/\b[\w-]+\.(?:sh|bash|ts|bats|json|md|tsx|mjs|cjs|yml|yaml)\b/g)].map(
    (m) => m[0],
  );
  const cmds = [
    ...expectation
      .toLowerCase()
      .matchAll(
        /\b(shellcheck|shfmt|vitest|bats|npm test|yarn test|pnpm test|\.\/dev\/[a-z-]+\.sh|jq|yamllint|tsc)\b/g,
      ),
  ].map((m) => m[0]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...quoted, ...paths, ...files, ...cmds]) {
    const k = raw.toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out.slice(0, 4);
}

export interface DeterministicGradeInput {
  skill: string;
  evalId: string;
  /** Which prompt variant produced `resultFiles` - threaded into the grade record so the report can split configs. */
  config: GradeConfig;
  shouldTrigger: boolean;
  expectations: string[];
  /** Per-run result file paths, in run order (run 1 first). */
  resultFiles: readonly string[];
  gradeFile: string;
  /** Pass threshold for `trigger_rate`; defaults to {@link DEFAULT_TRIGGER_THRESHOLD}. */
  triggerThreshold?: number;
}

function gradeExpectations(
  expectations: readonly string[],
  winner: ParsedReply,
): { results: ExpectationResult[]; passCount: number } {
  const body = `${winner.reason} ${winner.next_step}`.toLowerCase();
  const results: ExpectationResult[] = expectations.map((exp) => {
    const kws = keywordsFor(exp);
    if (kws.length === 0) {
      return { text: exp, passed: false, note: 'no-specific-keywords' };
    }
    const hits = kws.filter((k) => body.includes(k));
    const threshold = Math.max(1, Math.floor(kws.length / 2) + (kws.length >= 3 ? 1 : 0));
    const passed = hits.length >= threshold;
    return {
      text: exp,
      passed,
      note: `matched ${hits.length}/${kws.length} keywords: [${hits.join(', ')}]`,
    };
  });
  return { results, passCount: results.filter((e) => e.passed).length };
}

/**
 * Grade a single eval across its N run files and write the aggregated JSON
 * grade record to disk. `trigger_pass` is computed from the trigger-rate
 * against `triggerThreshold` (inclusive for `should_trigger=true`, strict for
 * `should_trigger=false`). Expectations are scored once against the majority
 * run's reply (or the first run on a tie).
 *
 * Returns the in-memory record for callers that want to chain a critic.
 */
export function gradeDeterministic(input: DeterministicGradeInput): GradeRecord {
  const { skill, evalId, config, shouldTrigger, expectations, resultFiles, gradeFile } = input;
  const threshold = input.triggerThreshold ?? DEFAULT_TRIGGER_THRESHOLD;
  if (resultFiles.length === 0) {
    throw new Error(`gradeDeterministic: no result files for ${skill}/${evalId} (${config})`);
  }
  const perRunTexts: string[] = resultFiles.map((f) => readFileSync(f, 'utf8'));
  const perRun: ParsedReply[] = perRunTexts.map((t) => parseReply(t));
  const runs = perRun.length;
  const triggers = perRun.filter(isTrigger).length;
  const timeoutRuns = perRunTexts.filter((t) => t.includes('DRIVER_TIMEOUT')).length;
  const triggerRate = roundTriggerRate(triggers / runs);
  const triggerPass = shouldTrigger ? triggerRate >= threshold : triggerRate < threshold;

  const winnerIdx = pickMajorityRunIndex(perRun);
  const winner = perRun[winnerIdx] ?? { trigger: '', reason: '', next_step: '' };
  const { results: expResults, passCount } = gradeExpectations(expectations, winner);

  const grade: GradeRecord = {
    skill,
    eval_id: evalId,
    config,
    should_trigger: shouldTrigger,
    runs,
    triggers,
    trigger_rate: triggerRate,
    trigger_pass: triggerPass,
    per_run: perRun,
    expectations: expResults,
    expectation_pass: passCount,
    expectation_total: expectations.length,
    grader: 'deterministic',
  };
  if (timeoutRuns > 0) {
    grade.flaws = [`DRIVER_TIMEOUT on ${timeoutRuns}/${runs} run(s)`];
  }
  mkdirSync(dirname(gradeFile), { recursive: true });
  writeFileSync(gradeFile, JSON.stringify(grade, null, 2));
  return grade;
}
