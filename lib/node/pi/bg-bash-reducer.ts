/**
 * Pure state types + reducer for the bg-bash extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The bg-bash extension runs user-initiated bash commands in the
 * background and exposes a single multi-action tool (`bg_bash`) the
 * LLM uses across turns to check on, steer, and collect output from
 * those commands.
 *
 * What lives in state (this module):
 *   - a registry of `JobSummary` metadata records: id, label, command,
 *     cwd, pid, status, exit code, timestamps, byte counts, log file
 *     path, and a short tail preview of stdout/stderr
 *   - a monotonically increasing `nextId`
 *
 * What does NOT live in state:
 *   - the live `ChildProcess` handle
 *   - the full stdout/stderr ring buffers
 *   - any wait-promise bookkeeping
 *
 * That "live" data stays in the extension runtime and dies with the pi
 * process. The summary *snapshot* here is mirrored to the session
 * branch as BOTH `toolResult.details` AND a `customType: 'bg-bash-state'`
 * custom entry (same pattern as todo / scratchpad), so the LLM still
 * has a consistent view after `/compact`, `/fork`, `/tree`.
 *
 * Because jobs are tied to the pi session lifetime (design choice A),
 * rehydrating from the branch intentionally DOES NOT reattach to live
 * child processes. On `session_start` in a fresh runtime, any job that
 * was previously `running` or `signaled` is marked `terminated` so the
 * LLM doesn't think it can still wait on / signal / read logs from it.
 */

import {
  type ActionError,
  type ActionResult as GenericActionResult,
  type ActionSuccess as GenericActionSuccess,
  type BranchEntry as GenericBranchEntry,
  findLatestStateInBranch,
  stateFromEntryGeneric,
} from './branch-state.ts';
import { truncate } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Stable identifiers
// ──────────────────────────────────────────────────────────────────────

export const BG_BASH_TOOL_NAME = 'bg_bash';
export const BG_BASH_CUSTOM_TYPE = 'bg-bash-state';

/** Re-export so callers (and tests) have a single import path. */
export type BranchEntry = GenericBranchEntry;

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/**
 * Lifecycle for a job:
 *
 *   - `running`    — spawned, process still alive
 *   - `exited`     — process exited on its own (see `exitCode`)
 *   - `signaled`   — process killed by a signal (see `signal`)
 *   - `error`      — spawn failed, or an internal error was recorded
 *   - `terminated` — state was rehydrated from the branch in a new
 *                    runtime; the original process is gone and not
 *                    reattachable. Distinct from `signaled` so the LLM
 *                    can tell "I killed it" from "pi restarted".
 */
export type JobStatus = 'running' | 'exited' | 'signaled' | 'error' | 'terminated';

/** Metadata snapshot for one job. Safe to mirror into the session. */
export interface JobSummary {
  /** Short opaque id (e.g. 8-hex). Unique per session. */
  id: string;
  /** Optional human label provided at start-time. */
  label?: string;
  /** The command string exactly as passed to the shell. */
  command: string;
  /** Resolved working directory at spawn time. */
  cwd: string;
  /** PID of the shell process (not the command tree). Undefined if spawn failed. */
  pid?: number;
  status: JobStatus;
  /** Exit code for `exited` jobs. */
  exitCode?: number;
  /** Signal name for `signaled` jobs (e.g. "SIGTERM"). */
  signal?: string;
  /** Human-readable error message for `error` jobs. */
  error?: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. Present once status is terminal. */
  endedAt?: number;
  /** Running total of bytes observed on each stream. Not clamped by the ring buffer. */
  stdoutBytes: number;
  stderrBytes: number;
  /** Last <=200 bytes of stdout, for a compact LLM preview. */
  stdoutTail: string;
  /** Last <=200 bytes of stderr, for a compact LLM preview. */
  stderrTail: string;
  /** Absolute path of the on-disk log file (stdout + stderr interleaved). */
  logFile?: string;
}

export interface BgBashState {
  jobs: JobSummary[];
  nextId: number;
}

export function emptyState(): BgBashState {
  return { jobs: [], nextId: 1 };
}

export function cloneSummary(s: JobSummary): JobSummary {
  return { ...s };
}

export function cloneState(s: BgBashState): BgBashState {
  return { jobs: s.jobs.map(cloneSummary), nextId: s.nextId };
}

// ──────────────────────────────────────────────────────────────────────
// Shape validation
// ──────────────────────────────────────────────────────────────────────

const STATUSES: ReadonlySet<JobStatus> = new Set(['running', 'exited', 'signaled', 'error', 'terminated']);

function isJobSummaryShape(value: unknown): value is JobSummary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (v.label !== undefined && typeof v.label !== 'string') return false;
  if (typeof v.command !== 'string') return false;
  if (typeof v.cwd !== 'string') return false;
  if (v.pid !== undefined && (typeof v.pid !== 'number' || !Number.isFinite(v.pid))) return false;
  if (typeof v.status !== 'string' || !STATUSES.has(v.status as JobStatus)) return false;
  if (v.exitCode !== undefined && (typeof v.exitCode !== 'number' || !Number.isFinite(v.exitCode))) return false;
  if (v.signal !== undefined && typeof v.signal !== 'string') return false;
  if (v.error !== undefined && typeof v.error !== 'string') return false;
  if (typeof v.startedAt !== 'number' || !Number.isFinite(v.startedAt)) return false;
  if (v.endedAt !== undefined && (typeof v.endedAt !== 'number' || !Number.isFinite(v.endedAt))) return false;
  if (typeof v.stdoutBytes !== 'number' || !Number.isFinite(v.stdoutBytes)) return false;
  if (typeof v.stderrBytes !== 'number' || !Number.isFinite(v.stderrBytes)) return false;
  if (typeof v.stdoutTail !== 'string') return false;
  if (typeof v.stderrTail !== 'string') return false;
  if (v.logFile !== undefined && typeof v.logFile !== 'string') return false;
  return true;
}

export function isBgBashStateShape(value: unknown): value is BgBashState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.nextId !== 'number' || !Number.isFinite(v.nextId)) return false;
  if (!Array.isArray(v.jobs)) return false;
  for (const raw of v.jobs) {
    if (!isJobSummaryShape(raw)) return false;
  }
  return true;
}

/**
 * Rehydrate a state snapshot into a "post-reload" form: any job that
 * was previously in a live status gets rewritten to `terminated`. The
 * snapshot coming off the branch can't know whether the pi process
 * that owned the child is still running; the extension calls this from
 * `session_start` to make the visible state honest.
 */
export function markLiveJobsTerminated(state: BgBashState, now: number): BgBashState {
  return {
    nextId: state.nextId,
    jobs: state.jobs.map((j) =>
      j.status === 'running' || j.status === 'signaled'
        ? {
            ...j,
            status: 'terminated',
            endedAt: j.endedAt ?? now,
            error: j.error ?? 'pi session ended before the job finished',
          }
        : cloneSummary(j),
    ),
  };
}

/**
 * Drop every job the current runtime can no longer interact with.
 *
 * A replayed snapshot can be in any of these states:
 *
 *   - `running`    — unreachable ghost. The child process belonged to
 *                    the previous runtime (we don't reattach on
 *                    rehydrate), so the LLM can't `wait` / `signal` /
 *                    `stdin` against it. Drop.
 *   - `terminated` — legacy best-effort finalization that
 *                    `markLiveJobsTerminated` produced. Purely
 *                    informational with no exit code or signal name;
 *                    nothing the LLM can act on. Drop.
 *   - `signaled`   — terminal. Its 'exit' listener recorded the
 *                    signal name (and usually exitCode too). Keep as
 *                    history so the LLM can see that a previous turn
 *                    killed this job.
 *   - `exited`     — terminal with a clean exit code. Keep.
 *   - `error`      — terminal with a recorded error message. Keep.
 *
 * `nextId` is preserved so newly-started jobs can't collide with ids
 * from the dropped ghosts.
 */
export function pruneUnattachableJobs(state: BgBashState): BgBashState {
  return {
    nextId: state.nextId,
    jobs: state.jobs
      .filter((j) => j.status === 'exited' || j.status === 'signaled' || j.status === 'error')
      .map(cloneSummary),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Branch reduction (same shape as todo / scratchpad)
// ──────────────────────────────────────────────────────────────────────

export function stateFromEntry(entry: BranchEntry): BgBashState | null {
  return stateFromEntryGeneric(entry, BG_BASH_TOOL_NAME, BG_BASH_CUSTOM_TYPE, isBgBashStateShape, cloneState);
}

export function reduceBranch(branch: readonly BranchEntry[]): BgBashState {
  return (
    findLatestStateInBranch(branch, BG_BASH_TOOL_NAME, BG_BASH_CUSTOM_TYPE, isBgBashStateShape, cloneState) ??
    emptyState()
  );
}

// ──────────────────────────────────────────────────────────────────────
// Pure action helpers — (state, args) → result. The extension's
// `execute()` dispatches and then mirrors state to the branch.
//
// Mutations that depend on live child processes (spawn, kill, wait,
// stdin, log reads) are NOT covered here — those are side-effectful
// and live in the extension glue. Only registry bookkeeping that has
// a pure data transition lives in this module.
// ──────────────────────────────────────────────────────────────────────

export type ActionSuccess = GenericActionSuccess<BgBashState>;
export type { ActionError };
export type ActionResult = GenericActionResult<BgBashState>;

export function findJob(state: BgBashState, id: string): JobSummary | undefined {
  return state.jobs.find((j) => j.id === id);
}

/**
 * Upsert a summary by id. New entries are appended; existing ones are
 * overwritten in place (order preserved). Returns a new state — the
 * input is not mutated.
 */
export function upsertJob(state: BgBashState, summary: JobSummary): BgBashState {
  const next = cloneState(state);
  const idx = next.jobs.findIndex((j) => j.id === summary.id);
  if (idx === -1) next.jobs.push(cloneSummary(summary));
  else next.jobs[idx] = cloneSummary(summary);
  return next;
}

export function removeJob(state: BgBashState, id: string): ActionResult {
  const idx = state.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return { ok: false, error: `job ${id} not found` };
  const job = state.jobs[idx];
  if (job.status === 'running' || job.status === 'signaled') {
    return { ok: false, error: `job ${id} is still ${job.status}; signal it first` };
  }
  const next = cloneState(state);
  next.jobs.splice(idx, 1);
  return { ok: true, state: next, summary: `Removed ${id}` };
}

/**
 * Allocate a fresh short id. Short hex is plenty: collisions within one
 * session are astronomically unlikely at these sizes, and we re-roll
 * on the (impossible) collision case rather than pretending otherwise.
 */
export function allocateId(state: BgBashState, rand: () => number = Math.random): string {
  // Format: lowercase 8-hex. ~4 billion-space, plus a re-roll guard below.
  let id: string;
  let tries = 0;
  do {
    id = Math.floor(rand() * 0x1_0000_0000)
      .toString(16)
      .padStart(8, '0');
    tries++;
  } while (tries < 16 && state.jobs.some((j) => j.id === id));
  return id;
}

// ──────────────────────────────────────────────────────────────────────
// Pretty-print helpers used by both the tool response `content` and
// the prompt injection. Kept here so the renderer and the prompt agree
// on formatting.
// ──────────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<JobStatus, string> = {
  running: '●',
  exited: '✓',
  signaled: '✗',
  error: '✗',
  terminated: '◌',
};

export function statusIcon(status: JobStatus): string {
  return STATUS_ICON[status] ?? '?';
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

/**
 * One-line summary of a job suitable for the LLM. Same string used by
 * `list`, the prompt injection, and the tool's fallback content.
 */
export function formatJobLine(job: JobSummary, now: number): string {
  const ended = job.endedAt ?? now;
  const dur = formatDuration(ended - job.startedAt);
  const label = job.label ? ` ${job.label}` : '';
  const cmd = truncate(job.command.replace(/\s+/g, ' '), 80);
  const bytes = formatBytes(job.stdoutBytes + job.stderrBytes);
  const head = `[${job.id}]${label} ${statusIcon(job.status)} ${cmd}`;
  switch (job.status) {
    case 'running':
      return `${head} — running ${dur}, ${bytes}`;
    case 'exited':
      return `${head} — exited ${job.exitCode ?? '?'} after ${dur}, ${bytes}`;
    case 'signaled':
      return `${head} — ${job.signal ?? 'signal'} after ${dur}, ${bytes}`;
    case 'error':
      return `${head} — error: ${job.error ?? 'unknown'}`;
    case 'terminated':
      return `${head} — terminated (pi session ended), ran ${dur}, ${bytes}`;
  }
}

export function formatState(state: BgBashState, now: number): string {
  if (state.jobs.length === 0) return '(no background jobs)';
  return state.jobs.map((j) => formatJobLine(j, now)).join('\n');
}

/**
 * Split jobs into running / recent buckets. "Recent" is every terminal
 * job sorted newest-first, optionally capped.
 */
export function partitionJobs(
  state: BgBashState,
  opts: { recentCap?: number } = {},
): { running: JobSummary[]; recent: JobSummary[] } {
  const running: JobSummary[] = [];
  const recent: JobSummary[] = [];
  for (const j of state.jobs) {
    if (j.status === 'running' || j.status === 'signaled') running.push(j);
    else recent.push(j);
  }
  recent.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const cap = opts.recentCap;
  return {
    running,
    recent: cap !== undefined && cap >= 0 ? recent.slice(0, cap) : recent,
  };
}

/**
 * Returns true iff `state` has at least one job in a non-terminal
 * status. Used by the extension to decide whether to keep the registry
 * "busy" for shutdown wait.
 */
export function hasLiveJobs(state: BgBashState): boolean {
  return state.jobs.some((j) => j.status === 'running' || j.status === 'signaled');
}
