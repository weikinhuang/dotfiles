/**
 * Pure types + runtime shape validators for the iteration-loop
 * extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * ## What lives where
 *
 * The iteration-loop state is split across two stores:
 *
 *   1. **On disk** - the check spec (`CheckSpec`) and artifact
 *      snapshots. Spec is user-facing (drafted by the model, accepted
 *      by the user) and needs to survive pi restarts.
 *   2. **In the session branch** - the per-session iteration state
 *      (`IterationState`): iteration count, verdict history,
 *      best-so-far pointer, edits-since-last-check counter. Mirrored
 *      into tool results + a custom entry so `/fork` and `/compact`
 *      handle it correctly (see `iteration-loop-reducer.ts`).
 *
 * This module defines the TS types for both, plus runtime `is*`
 * validators that let the reducer / storage layers accept snapshots
 * loaded from untrusted sources (session files, user-edited JSON on
 * disk) without crashing.
 *
 * Validators are intentionally lenient in one direction: unknown
 * fields are ignored. A future schema version can add fields without
 * breaking state reconstruction from an older session. They are
 * strict in the other direction: required fields with wrong types
 * cause the validator to return false, the reducer then falls back
 * to `emptyState()`, and the extension surfaces a fresh start rather
 * than operating on half-corrupt state.
 */

// Type aliases + factory helpers for the iteration-loop check kinds,
// verdict payloads, and persisted state. Runtime shape validators
// (`is*Shape` predicates + `isStopReason`/`isCheckKind`/`isBashPassOn`)
// live in `./guards.ts` so the type surface stays import-free.

// ──────────────────────────────────────────────────────────────────────
// Check spec - what the user declared and accepted.
// ──────────────────────────────────────────────────────────────────────

/** Discriminator for the check kind. `diff` is v1.5 - not in v1. */
export type CheckKind = 'bash' | 'critic';

/**
 * How a bash check decides pass/fail.
 *
 * - `exit-zero` (default) - exit code 0 ⇒ pass. Anything else ⇒ fail.
 * - `regex:<pattern>` - pass iff stdout (not stderr) matches `pattern`
 *   (JS regex, no flags). Exit code is ignored.
 * - `jq:<expr>` - pass iff `jq -e <expr>` applied to stdout returns a
 *   truthy value. Exit code is ignored. Requires `jq` on PATH; if
 *   missing, the check fails with a clear diagnostic.
 */
export type BashPassOn = 'exit-zero' | `regex:${string}` | `jq:${string}`;

export interface BashCheckSpec {
  /** Shell command. Runs through `/bin/bash -c`. */
  cmd: string;
  /** Pass predicate. Default `exit-zero`. */
  passOn?: BashPassOn;
  /** Extra env vars, merged on top of the agent's env. */
  env?: Record<string, string>;
  /** Working directory (default: agent cwd). */
  workdir?: string;
  /** Hard timeout (ms). Default 60_000. */
  timeoutMs?: number;
}

export interface CriticCheckSpec {
  /**
   * Subagent type to dispatch. Default `critic`. Override to use a
   * specialized judge (e.g. `code-critic`).
   */
  agent?: string;
  /**
   * Human-readable rubric. Interpolated into the critic's task
   * template by `iteration-loop-check-critic.ts`.
   */
  rubric: string;
  /**
   * Optional `provider/id` override threaded to the subagent's
   * `modelOverride`. Leave unset to inherit from the parent.
   */
  modelOverride?: string;
}

export interface BudgetSpec {
  /** Hard cap on iterations. Default 5. */
  maxIter?: number;
  /** Soft cap on cumulative USD cost. Default 0.10. */
  maxCostUsd?: number;
  /** Wall-clock cap (seconds). Default 600. */
  wallClockSeconds?: number;
}

/**
 * The full on-disk spec. Written as `.pi/checks/<task>.draft.json` by
 * `check declare`, renamed to `.pi/checks/<task>.json` by
 * `check accept`.
 */
export interface CheckSpec {
  /** Task name; `default` in v1 (single-task only). */
  task: string;
  /** Discriminator for `spec`. */
  kind: CheckKind;
  /**
   * Path (relative to cwd) of the artifact being iterated on. v1 is
   * exact-path only; v1.5 adds glob support.
   */
  artifact: string;
  /** Budget caps. Fields fall back to defaults when omitted. */
  budget?: BudgetSpec;
  /** Kind-specific spec. Tagged via `kind`. */
  spec: BashCheckSpec | CriticCheckSpec;
  /** ISO8601 timestamp the draft was written. */
  createdAt: string;
  /** ISO8601 timestamp the draft was accepted. Unset on the draft. */
  acceptedAt?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Verdict - what a single `check run` produced.
// ──────────────────────────────────────────────────────────────────────

export type IssueSeverity = 'blocker' | 'major' | 'minor';

export interface Issue {
  severity: IssueSeverity;
  description: string;
  /**
   * Optional free-form pointer: line number, element name, region.
   * Model-authored; don't depend on its shape.
   */
  location?: string;
}

export interface Verdict {
  /**
   * Did the check pass? For `bash`: predicate matched. For `critic`:
   * rubric fully satisfied. Stop-reason `passed` requires this true.
   */
  approved: boolean;
  /**
   * Scalar quality score in [0, 1]. Bash checks return 0 or 1;
   * critic/diff return a graded value used for best-so-far selection
   * and budget-exhaustion fallback.
   */
  score: number;
  /** Structured issues (empty when approved). */
  issues: Issue[];
  /**
   * Optional short summary for the status block. Extension fills this
   * in when the check kind doesn't provide one.
   */
  summary?: string;
  /**
   * Optional raw observation payload (stdout/stderr/exit for bash,
   * raw critic text for critic). Kept for debugging; truncated when
   * large. Not guaranteed to be set.
   */
  raw?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Stop reasons - what terminated the loop (or null while active).
// ──────────────────────────────────────────────────────────────────────

export type StopReason =
  | 'passed' //           verdict.approved === true
  | 'budget-iter' //      hit maxIter with no pass
  | 'budget-cost' //      hit maxCostUsd with no pass
  | 'wall-clock' //       hit wallClockSeconds with no pass
  | 'fixpoint' //         two consecutive iterations produced the same artifact bytes
  | 'user-closed'; //     explicit `check close`

// ──────────────────────────────────────────────────────────────────────
// Iteration state - lives in the session branch (see reducer).
// ──────────────────────────────────────────────────────────────────────

export interface BestSoFar {
  iteration: number;
  score: number;
  /** Whether this iteration's verdict was approved. Needed so the
   *  selector can refuse to clobber an approved best with a
   *  non-approved higher-scored candidate. */
  approved: boolean;
  /** Absolute path to the snapshot on disk. */
  snapshotPath: string;
  /** SHA-256 of the snapshotted bytes (hex). Used for fixpoint check. */
  artifactHash: string;
}

export interface HistoryEntry {
  iteration: number;
  score: number;
  approved: boolean;
  summary: string;
  /** Non-null only on the terminating iteration. */
  stopReason: StopReason | null;
  /** ISO8601. */
  ranAt: string;
}

export interface IterationState {
  /** Task name; must match the spec's task. */
  task: string;
  /**
   * Number of `check run` calls completed. Zero until the first run.
   * The *next* iteration's index is `iteration + 1`.
   */
  iteration: number;
  /** Count of write/edit operations against the artifact since the last successful `check run`. */
  editsSinceLastCheck: number;
  /**
   * Assistant-turn number (1-indexed) of the last `check run`. Null
   * until the first run. Used by guardrails to detect "you claimed
   * done without running the check *this turn*".
   */
  lastCheckTurn: number | null;
  /** The most recent verdict. Null until the first run. */
  lastVerdict: Verdict | null;
  /** Running best across all iterations. */
  bestSoFar: BestSoFar | null;
  /** Cumulative USD cost attributable to this loop's critic calls. */
  costUsd: number;
  /** Append-only history. One entry per completed iteration. */
  history: HistoryEntry[];
  /**
   * Non-null ⇒ loop terminated (for any reason). The extension
   * refuses `check run` when this is set; the user must `check close`
   * + `check declare` a new task to keep going.
   */
  stopReason: StopReason | null;
  /** ISO8601 of the first `check accept`. */
  startedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Factory helpers - canonical empty state, budget defaults.
// ──────────────────────────────────────────────────────────────────────

export const DEFAULT_BUDGET: Required<BudgetSpec> = {
  maxIter: 5,
  maxCostUsd: 0.1,
  wallClockSeconds: 600,
};

export function resolveBudget(spec: CheckSpec): Required<BudgetSpec> {
  const b = spec.budget ?? {};
  return {
    maxIter: b.maxIter ?? DEFAULT_BUDGET.maxIter,
    maxCostUsd: b.maxCostUsd ?? DEFAULT_BUDGET.maxCostUsd,
    wallClockSeconds: b.wallClockSeconds ?? DEFAULT_BUDGET.wallClockSeconds,
  };
}

export function emptyIterationState(task: string, startedAt: string): IterationState {
  return {
    task,
    iteration: 0,
    editsSinceLastCheck: 0,
    lastCheckTurn: null,
    lastVerdict: null,
    bestSoFar: null,
    costUsd: 0,
    history: [],
    stopReason: null,
    startedAt,
  };
}

export function cloneIterationState(s: IterationState): IterationState {
  return {
    task: s.task,
    iteration: s.iteration,
    editsSinceLastCheck: s.editsSinceLastCheck,
    lastCheckTurn: s.lastCheckTurn,
    lastVerdict: s.lastVerdict
      ? {
          approved: s.lastVerdict.approved,
          score: s.lastVerdict.score,
          issues: s.lastVerdict.issues.map((i) => ({ ...i })),
          summary: s.lastVerdict.summary,
          raw: s.lastVerdict.raw,
        }
      : null,
    bestSoFar: s.bestSoFar ? { ...s.bestSoFar } : null,
    costUsd: s.costUsd,
    history: s.history.map((h) => ({ ...h })),
    stopReason: s.stopReason,
    startedAt: s.startedAt,
  };
}
