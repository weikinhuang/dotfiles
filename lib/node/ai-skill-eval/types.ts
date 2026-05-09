// Shared types for ai-skill-eval.
// SPDX-License-Identifier: MIT

export interface SkillEntry {
  name: string;
  skillMd: string;
  evalsJson: string | null;
}

export interface EvalSpec {
  id: string;
  should_trigger: boolean;
  prompt: string;
  expectations: string[];
  /** Per-eval override; falls back to EvalsFile.runs_per_query, then CLI, then 3. */
  runs_per_query?: number;
}

export interface EvalsFile {
  skill_name?: string;
  /** File-level default; individual evals can still override via `EvalSpec.runs_per_query`. */
  runs_per_query?: number;
  evals: EvalSpec[];
}

export interface ParsedReply {
  trigger: string;
  reason: string;
  next_step: string;
}

export interface ExpectationResult {
  text: string;
  passed: boolean;
  note: string;
}

/**
 * Per-eval, per-config grade record (R1a shape).
 *
 * Aggregates N driver runs of the same prompt into a single record:
 *   - `runs` is the total number of runs actually executed
 *   - `triggers` counts runs whose TRIGGER field started with "yes"
 *   - `trigger_rate` = `triggers / runs`, rounded to 2 decimals
 *   - `trigger_pass` compares `trigger_rate` against the CLI
 *     `--trigger-threshold`: `>= T` for `should_trigger=true`, `< T` for
 *     `should_trigger=false`
 *   - `per_run` preserves each run's parsed TRIGGER/REASON/NEXT_STEP
 *
 * Expectation grading runs once against the majority-trigger run's reply
 * (first run on a tie); the critic, when present, replaces those fields.
 */
/** R2: which prompt variant produced this grade. `with_skill` is the default; `without_skill` is the baseline variant emitted by `--baseline`. */
export type GradeConfig = 'with_skill' | 'without_skill';

export interface GradeRecord {
  skill: string;
  eval_id: string;
  /** R2 baseline comparison: which prompt variant this grade came from. */
  config: GradeConfig;
  should_trigger: boolean;
  runs: number;
  triggers: number;
  trigger_rate: number;
  trigger_pass: boolean;
  per_run: ParsedReply[];
  expectations: ExpectationResult[];
  expectation_pass: number;
  expectation_total: number;
  grader: 'deterministic' | 'critic';
  flaws?: string[];
}

export type DriverKind = 'pi' | 'claude' | 'codex';
