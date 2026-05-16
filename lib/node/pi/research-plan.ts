/**
 * Plan schema + I/O for the research toolkit.
 *
 * Each `/research` or `/lab` run persists a single `plan.json`
 * capturing the current state of the pipeline: which sub-questions /
 * experiments exist, which have been assigned to subagents, which
 * have completed, the budget envelope, and an overall status
 * tracking which phase the run is in. Consumers read/write this
 * file repeatedly over the lifetime of a run, so the schema is
 * deliberately explicit and the writer is atomic.
 *
 * The schema is a discriminated union on `kind` with two variants:
 *
 *   1. `kind: "deep-research"` - the deep-research extension's plan.
 *      Tracks a flat list of sub-questions, each produced by the
 *      planner and handed off to a fanout subagent.
 *   2. `kind: "autoresearch"` - the autoresearch extension's plan.
 *      Tracks a list of experiments, each with a hypothesis, a
 *      working directory, and a metrics schema the experiment's
 *      `metrics.json` is validated against.
 *
 * The two share a budget shape and a `stuck` terminal status (for
 * the escape-hatch path - see `research-stuck.ts`). `status` uses
 * variant-specific enum strings so a misrouted read ("I loaded an
 * autoresearch plan while expecting deep-research") is caught at
 * the `kind` discriminator rather than producing a silently-
 * validating-but-wrong plan.
 *
 * Plain-TS validators (mirroring `iteration-loop-schema.ts`) rather
 * than TypeBox - the plan text cites that module as the precedent,
 * and `typebox` is not a dep of the root tsconfig. `upgrade()`
 * returns a typed error describing exactly which field failed so
 * callers can surface actionable diagnostics to the journal.
 *
 * No pi imports.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Shared building blocks.
// ──────────────────────────────────────────────────────────────────────

/**
 * Budget envelope the planner hands off to the dispatcher. Values
 * are hard caps - the dispatcher aborts on overrun, logs to the
 * journal, and (typically) quarantines the in-flight artifact.
 *
 *   - `maxSubagents`: per-run parallel subagent cap.
 *   - `maxFetches`: per-run `fetch_web` call cap.
 *   - `maxCostUsd`: cumulative cost cap across all LLM calls.
 *   - `wallClockSec`: wall-clock cap for the whole run.
 */
export interface PlanBudget {
  maxSubagents: number;
  maxFetches: number;
  maxCostUsd: number;
  wallClockSec: number;
}

/** Status values a single sub-question cycles through. */
export const SUBQUESTION_STATUSES = [
  'pending',
  'assigned',
  'in-progress',
  'complete',
  'failed',
  'quarantined',
] as const;
export type SubQuestionStatus = (typeof SUBQUESTION_STATUSES)[number];

/** Status values a single experiment cycles through. */
export const EXPERIMENT_STATUSES = ['pending', 'running', 'complete', 'failed', 'quarantined'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** Per-sub-question state carried in a deep-research plan. */
export interface SubQuestion {
  id: string;
  question: string;
  status: SubQuestionStatus;
  assignedAgent?: string;
  findingsPath?: string;
}

/** Per-experiment state carried in an autoresearch plan. */
export interface Experiment {
  id: string;
  hypothesis: string;
  status: ExperimentStatus;
  dir: string;
  /**
   * Opaque schema object the experiment's `metrics.json` is
   * validated against. Kept as `unknown` because consumers define
   * the schema shape (JSON Schema, TypeBox Schema, hand-rolled).
   * Research-core's `autoresearch-metrics-schema` helper (sibling
   * plan) is the validator; this module only persists it.
   */
  metricsSchema: unknown;
}

/** Deep-research top-level status. */
export const DEEP_RESEARCH_STATUSES = [
  'planning',
  'fanout',
  'synth',
  'structural-review',
  'subjective-review',
  'done',
  'stuck',
] as const;
export type DeepResearchStatus = (typeof DEEP_RESEARCH_STATUSES)[number];

/** Autoresearch top-level status. */
export const AUTORESEARCH_STATUSES = ['planning', 'experiment', 'reviewing', 'checkpoint', 'done', 'stuck'] as const;
export type AutoresearchStatus = (typeof AUTORESEARCH_STATUSES)[number];

// ──────────────────────────────────────────────────────────────────────
// Plan variants + union.
// ──────────────────────────────────────────────────────────────────────

export interface DeepResearchPlan {
  kind: 'deep-research';
  question: string;
  slug: string;
  subQuestions: SubQuestion[];
  budget: PlanBudget;
  status: DeepResearchStatus;
}

export interface AutoresearchPlan {
  kind: 'autoresearch';
  topic: string;
  slug: string;
  experiments: Experiment[];
  budget: PlanBudget;
  status: AutoresearchStatus;
}

export type Plan = DeepResearchPlan | AutoresearchPlan;

// ──────────────────────────────────────────────────────────────────────
// Validators.
// ──────────────────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isBudget(v: unknown): v is PlanBudget {
  if (!isRecord(v)) return false;
  return (
    isFiniteNonNegativeNumber(v.maxSubagents) &&
    isFiniteNonNegativeNumber(v.maxFetches) &&
    isFiniteNonNegativeNumber(v.maxCostUsd) &&
    isFiniteNonNegativeNumber(v.wallClockSec)
  );
}

function isSubQuestionStatus(v: unknown): v is SubQuestionStatus {
  return typeof v === 'string' && (SUBQUESTION_STATUSES as readonly string[]).includes(v);
}

function isExperimentStatus(v: unknown): v is ExperimentStatus {
  return typeof v === 'string' && (EXPERIMENT_STATUSES as readonly string[]).includes(v);
}

function isSubQuestion(v: unknown): v is SubQuestion {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.question)) return false;
  if (!isSubQuestionStatus(v.status)) return false;
  if (v.assignedAgent !== undefined && typeof v.assignedAgent !== 'string') return false;
  if (v.findingsPath !== undefined && typeof v.findingsPath !== 'string') return false;
  return true;
}

function isExperiment(v: unknown): v is Experiment {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.hypothesis)) return false;
  if (!isExperimentStatus(v.status)) return false;
  if (!isNonEmptyString(v.dir)) return false;
  if (!('metricsSchema' in v)) return false;
  return true;
}

function isDeepResearchStatus(v: unknown): v is DeepResearchStatus {
  return typeof v === 'string' && (DEEP_RESEARCH_STATUSES as readonly string[]).includes(v);
}

function isAutoresearchStatus(v: unknown): v is AutoresearchStatus {
  return typeof v === 'string' && (AUTORESEARCH_STATUSES as readonly string[]).includes(v);
}

function isDeepResearchPlan(v: Record<string, unknown>): boolean {
  if (!isNonEmptyString(v.question)) return false;
  if (!isNonEmptyString(v.slug)) return false;
  if (!isDeepResearchStatus(v.status)) return false;
  if (!isBudget(v.budget)) return false;
  if (!Array.isArray(v.subQuestions)) return false;
  for (const sq of v.subQuestions) {
    if (!isSubQuestion(sq)) return false;
  }

  return true;
}

function isAutoresearchPlan(v: Record<string, unknown>): boolean {
  if (!isNonEmptyString(v.topic)) return false;
  if (!isNonEmptyString(v.slug)) return false;
  if (!isAutoresearchStatus(v.status)) return false;
  if (!isBudget(v.budget)) return false;
  if (!Array.isArray(v.experiments)) return false;
  for (const exp of v.experiments) {
    if (!isExperiment(exp)) return false;
  }

  return true;
}

/**
 * Full discriminated-union shape check. Returns true iff `v`
 * matches one of the two variants end-to-end. Uses `.kind` as the
 * discriminator so malformed inputs are localized quickly.
 */
export function isPlan(v: unknown): v is Plan {
  if (!isRecord(v)) return false;
  if (v.kind === 'deep-research') return isDeepResearchPlan(v);
  if (v.kind === 'autoresearch') return isAutoresearchPlan(v);

  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Tolerant upgrade.
// ──────────────────────────────────────────────────────────────────────

export class PlanValidationError extends Error {
  /**
   * Structural path to the offending field, e.g.
   * `subQuestions[2].status`. Callers journal this verbatim so a
   * later reader can jump straight to the problem.
   */
  public readonly path: string;

  constructor(path: string, message: string) {
    super(`plan validation failed at ${path}: ${message}`);
    this.name = 'PlanValidationError';
    this.path = path;
  }
}

function upgradeSubQuestion(raw: unknown, path: string): SubQuestion {
  if (!isRecord(raw)) throw new PlanValidationError(path, 'must be an object');
  if (!isNonEmptyString(raw.id)) throw new PlanValidationError(`${path}.id`, 'must be a non-empty string');
  if (!isNonEmptyString(raw.question)) throw new PlanValidationError(`${path}.question`, 'must be a non-empty string');
  if (!isSubQuestionStatus(raw.status)) {
    throw new PlanValidationError(`${path}.status`, `expected one of ${SUBQUESTION_STATUSES.join('|')}`);
  }
  if (raw.assignedAgent !== undefined && typeof raw.assignedAgent !== 'string') {
    throw new PlanValidationError(`${path}.assignedAgent`, 'must be a string when set');
  }
  if (raw.findingsPath !== undefined && typeof raw.findingsPath !== 'string') {
    throw new PlanValidationError(`${path}.findingsPath`, 'must be a string when set');
  }
  const out: SubQuestion = { id: raw.id, question: raw.question, status: raw.status };
  if (typeof raw.assignedAgent === 'string') out.assignedAgent = raw.assignedAgent;
  if (typeof raw.findingsPath === 'string') out.findingsPath = raw.findingsPath;

  return out;
}

function upgradeExperiment(raw: unknown, path: string): Experiment {
  if (!isRecord(raw)) throw new PlanValidationError(path, 'must be an object');
  if (!isNonEmptyString(raw.id)) throw new PlanValidationError(`${path}.id`, 'must be a non-empty string');
  if (!isNonEmptyString(raw.hypothesis))
    throw new PlanValidationError(`${path}.hypothesis`, 'must be a non-empty string');
  if (!isExperimentStatus(raw.status)) {
    throw new PlanValidationError(`${path}.status`, `expected one of ${EXPERIMENT_STATUSES.join('|')}`);
  }
  if (!isNonEmptyString(raw.dir)) throw new PlanValidationError(`${path}.dir`, 'must be a non-empty string');
  if (!('metricsSchema' in raw)) {
    throw new PlanValidationError(`${path}.metricsSchema`, 'must be present (null allowed)');
  }

  return {
    id: raw.id,
    hypothesis: raw.hypothesis,
    status: raw.status,
    dir: raw.dir,
    metricsSchema: raw.metricsSchema,
  };
}

function upgradeDeepResearch(raw: Record<string, unknown>): DeepResearchPlan {
  if (!isNonEmptyString(raw.question)) throw new PlanValidationError('$.question', 'must be a non-empty string');
  if (!isNonEmptyString(raw.slug)) throw new PlanValidationError('$.slug', 'must be a non-empty string');
  if (!isDeepResearchStatus(raw.status)) {
    throw new PlanValidationError('$.status', `expected one of ${DEEP_RESEARCH_STATUSES.join('|')}`);
  }
  if (!isBudget(raw.budget)) throw new PlanValidationError('$.budget', 'must be a PlanBudget object');
  if (!Array.isArray(raw.subQuestions)) throw new PlanValidationError('$.subQuestions', 'must be an array');
  const subQuestions: SubQuestion[] = raw.subQuestions.map((sq, i) => upgradeSubQuestion(sq, `$.subQuestions[${i}]`));

  return {
    kind: 'deep-research',
    question: raw.question,
    slug: raw.slug,
    subQuestions,
    budget: raw.budget,
    status: raw.status,
  };
}

function upgradeAutoresearch(raw: Record<string, unknown>): AutoresearchPlan {
  if (!isNonEmptyString(raw.topic)) throw new PlanValidationError('$.topic', 'must be a non-empty string');
  if (!isNonEmptyString(raw.slug)) throw new PlanValidationError('$.slug', 'must be a non-empty string');
  if (!isAutoresearchStatus(raw.status)) {
    throw new PlanValidationError('$.status', `expected one of ${AUTORESEARCH_STATUSES.join('|')}`);
  }
  if (!isBudget(raw.budget)) throw new PlanValidationError('$.budget', 'must be a PlanBudget object');
  if (!Array.isArray(raw.experiments)) throw new PlanValidationError('$.experiments', 'must be an array');
  const experiments: Experiment[] = raw.experiments.map((e, i) => upgradeExperiment(e, `$.experiments[${i}]`));

  return {
    kind: 'autoresearch',
    topic: raw.topic,
    slug: raw.slug,
    experiments,
    budget: raw.budget,
    status: raw.status,
  };
}

/**
 * Parse an untrusted (model-authored, user-edited, or legacy) plan
 * payload into a valid `Plan`, or throw `PlanValidationError` with
 * the first structural problem localized. "Tolerant" here means:
 * unknown fields are ignored rather than rejected, and array order
 * is preserved rather than normalized. It does NOT mean we invent
 * missing fields - a plan without a `budget` fails to upgrade.
 *
 * Use this at every boundary where the plan may have been produced
 * outside our own writer (reading `plan.json` from disk, parsing a
 * planner subagent's output, merging a user's manual edit). Writers
 * should not call this - they produce known-good values.
 */
export function upgrade(raw: unknown): Plan {
  if (!isRecord(raw)) {
    throw new PlanValidationError('$', 'plan must be a JSON object');
  }
  if (raw.kind === 'deep-research') {
    return upgradeDeepResearch(raw);
  }
  if (raw.kind === 'autoresearch') {
    return upgradeAutoresearch(raw);
  }
  throw new PlanValidationError(
    '$.kind',
    `expected "deep-research" or "autoresearch", got ${JSON.stringify(raw.kind)}`,
  );
}

// ──────────────────────────────────────────────────────────────────────
// I/O.
// ──────────────────────────────────────────────────────────────────────

/**
 * Read the plan at `path` and return a validated `Plan`. Throws
 * `PlanValidationError` for any structural problem and a plain
 * `Error` for missing-file / unreadable-JSON cases.
 */
export function readPlan(path: string): Plan {
  if (!existsSync(path)) throw new Error(`readPlan: plan file does not exist: ${path}`);
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`readPlan: ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return upgrade(parsed);
}

/**
 * Write `plan` atomically to `path` as pretty-printed JSON with a
 * trailing newline. Runs the plan through `upgrade()` first, which
 * both validates it and produces a normalized copy (discarding any
 * unknown fields the in-memory `plan` may have carried). A malformed
 * plan throws `PlanValidationError` with a `$.path` pointer and does
 * NOT touch disk. Using `upgrade` rather than `isPlan` here avoids
 * maintaining two parallel validators that could drift; callers
 * who want a bool-only predicate still have `isPlan` exported.
 */
export function writePlan(path: string, plan: Plan): void {
  const normalized = upgrade(plan);
  atomicWriteFile(path, JSON.stringify(normalized, null, 2) + '\n');
}
