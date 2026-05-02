/**
 * Subagent handle watchdog.
 *
 * `research-fanout` spawns background subagents via
 * `subagent({run_in_background: true})`; the parent session drives
 * all of them in parallel and needs to detect the "child is stuck —
 * producing no output for too long" failure mode before it burns a
 * fanout's wall-clock budget on a silently-hung helper. That's the
 * job of this module.
 *
 * `watch(opts)` polls a handle's `status()` on a configurable
 * interval. Each status report carries a `lastProgressAt` timestamp
 * — the caller (or the shim that wraps `subagent_send`) is
 * responsible for bumping it whenever the child emits a new
 * assistant/tool message. When `now - lastProgressAt` exceeds
 * `staleThresholdMs`, we:
 *
 *   1. Invoke `onStall(reason)` exactly once with a human-readable
 *      reason string.
 *   2. If `abortOnStall` is true (default), call `handle.abort(reason)`
 *      and stop polling.
 *   3. Journal the stall via `research-journal.appendJournal` when
 *      `journalPath` is provided, level `warn`, so the run's audit
 *      trail records the decision.
 *
 * If the child completes or reports its own error during polling,
 * we stop cleanly without triggering a stall. If the parent's
 * `signal` aborts, we stop polling and classify as `aborted`
 * without touching the handle (the parent already decided what to
 * do with it).
 *
 * Deliberately minimal dependencies — the pi types we need
 * (subagent handle, abort signal) are expressed as structural
 * interfaces so tests can pass a hand-rolled mock handle that
 * script-drives a sequence of status reports without a live
 * `subagent_send` bridge.
 *
 * The module imports `research-journal` for optional stall logging
 * and `research-stuck`-style thinking in reason messages (but not
 * the module — the reason is a plain string).
 */

import { appendJournal } from './research-journal.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/**
 * One poll of a running handle. The shim wrapping `subagent_send
 * action: status` produces this shape.
 *
 *   - `done` means the child has finished — any path to termination
 *     (completed, aborted, errored). After `done: true`, the
 *     watchdog stops.
 *   - `lastProgressAt` is the epoch-ms timestamp of the most recent
 *     observed progress event (new assistant text, new tool call
 *     result). Callers that only have "output so far" can fall back
 *     to "current time if output changed, previous timestamp
 *     otherwise" — either is valid as long as it's monotone
 *     per-handle.
 *   - `progressHint` is a short human summary surfaced in stall
 *     reason messages (e.g. `"last turn: tool=fetch_url"`).
 *   - `error` is set when the child self-reported an error; the
 *     watchdog treats it as a terminal state like `done`.
 */
export interface WatchdogStatus {
  done: boolean;
  lastProgressAt: number;
  progressHint?: string;
  error?: string;
}

/**
 * Structural shape of the `subagent_send`-backed handle the
 * watchdog drives. `status()` returns the latest snapshot; `abort`
 * cancels the child.
 */
export interface WatchdogHandleLike {
  /** Human-readable identifier for journal entries / stall reasons. */
  readonly id: string;
  /** Read the current status. Must not mutate the child. */
  status(): Promise<WatchdogStatus>;
  /** Cancel the child. Watchdog invokes this on stall when opted in. */
  abort(reason?: string): Promise<void>;
}

export interface WatchdogOpts {
  handle: WatchdogHandleLike;
  /**
   * Milliseconds of no-progress after which the handle is declared
   * stalled. Default 5 minutes — matches the spec. Set lower in
   * tests.
   */
  staleThresholdMs?: number;
  /**
   * Polling interval. Default 10 seconds — matches the spec.
   * Tests set this small, often combined with an injected `sleep`.
   */
  pollIntervalMs?: number;
  /**
   * Whether to call `handle.abort(reason)` on stall. Default true.
   * `false` turns the watchdog into a pure observer — useful when a
   * parent controller wants to decide abort policy itself.
   */
  abortOnStall?: boolean;
  /** Fires exactly once on first stall detection. */
  onStall?: (reason: string) => void;
  /**
   * Optional journal path. When provided, stall detection logs one
   * `warn` entry before (optionally) aborting.
   */
  journalPath?: string;
  /** Injected clock source. Default `Date.now`. */
  now?: () => number;
  /** Injected sleep. Default `setTimeout`-backed. */
  sleep?: (ms: number) => Promise<void>;
  /** Parent's abort signal — stop polling immediately if fired. */
  signal?: AbortSignal;
}

/** How the watchdog finished. */
export type WatchdogOutcome =
  | { kind: 'completed'; lastStatus: WatchdogStatus }
  | { kind: 'errored'; lastStatus: WatchdogStatus }
  | { kind: 'stalled'; lastStatus: WatchdogStatus; aborted: boolean; reason: string }
  | { kind: 'aborted-by-parent'; lastStatus: WatchdogStatus | null };

// ──────────────────────────────────────────────────────────────────────
// Main loop
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_STALE_MS = 300_000;
const DEFAULT_POLL_MS = 10_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface BuildStallReasonArgs {
  id: string;
  elapsedMs: number;
  staleThresholdMs: number;
  hint: string | undefined;
}

function buildStallReason(args: BuildStallReasonArgs): string {
  const seconds = Math.round(args.elapsedMs / 1000);
  const thresholdSec = Math.round(args.staleThresholdMs / 1000);
  const base = `handle ${args.id} produced no progress for ${seconds}s (threshold ${thresholdSec}s)`;
  return args.hint ? `${base}; last hint: ${args.hint}` : base;
}

/**
 * Drive the poll-until-done / poll-until-stalled loop.
 *
 * The loop wakes every `pollIntervalMs`, calls `status()`, and
 * applies three checks in order:
 *
 *   1. Parent signal aborted? Return `aborted-by-parent`.
 *   2. Status is terminal? (`done` or `error` set.) Return
 *      `completed` / `errored`.
 *   3. No progress for `staleThresholdMs`? Fire `onStall`, optionally
 *      abort, return `stalled`.
 *
 * None of the callbacks throw-propagates — a misbehaving callback
 * (e.g. `onStall` throws, or the journal write fails) does not
 * prevent the watchdog from terminating cleanly. We swallow such
 * errors rather than leaking them into the fanout orchestrator,
 * which has its own failure handling for the child's result.
 */
export async function watch(opts: WatchdogOpts): Promise<WatchdogOutcome> {
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const abortOnStall = opts.abortOnStall ?? true;
  const now = opts.now ?? ((): number => Date.now());
  const sleep = opts.sleep ?? defaultSleep;

  let lastStatus: WatchdogStatus | null = null;
  let stallFired = false;

  // Poll immediately once so a fast-completing child returns
  // without an initial sleep. Subsequent iterations sleep first.
  let firstIteration = true;
  while (true) {
    if (opts.signal?.aborted) {
      return { kind: 'aborted-by-parent', lastStatus };
    }

    if (!firstIteration) {
      await sleep(pollIntervalMs);
      if (opts.signal?.aborted) {
        return { kind: 'aborted-by-parent', lastStatus };
      }
    }
    firstIteration = false;

    let status: WatchdogStatus;
    try {
      status = await opts.handle.status();
    } catch (e) {
      // A failing status call is itself a signal — classify as
      // errored so the caller can decide what to do. We don't
      // retry here; retry belongs in the status-shim.
      const msg = e instanceof Error ? e.message : String(e);
      const synthStatus: WatchdogStatus = {
        done: true,
        lastProgressAt: now(),
        error: `status poll failed: ${msg}`,
      };
      lastStatus = synthStatus;
      return { kind: 'errored', lastStatus: synthStatus };
    }
    lastStatus = status;

    if (status.error) {
      return { kind: 'errored', lastStatus: status };
    }
    if (status.done) {
      return { kind: 'completed', lastStatus: status };
    }

    const elapsed = now() - status.lastProgressAt;
    if (elapsed >= staleThresholdMs && !stallFired) {
      stallFired = true;
      const reason = buildStallReason({
        id: opts.handle.id,
        elapsedMs: elapsed,
        staleThresholdMs,
        hint: status.progressHint,
      });

      try {
        opts.onStall?.(reason);
      } catch {
        /* swallow — see module header */
      }

      if (opts.journalPath) {
        try {
          appendJournal(opts.journalPath, {
            level: 'warn',
            heading: `watchdog stall: ${opts.handle.id}`,
            body: reason,
          });
        } catch {
          /* swallow — journal failures never abort the watchdog */
        }
      }

      let aborted = false;
      if (abortOnStall) {
        try {
          await opts.handle.abort(reason);
          aborted = true;
        } catch {
          /* swallow — the child may already be dead */
        }
      }
      return { kind: 'stalled', lastStatus: status, aborted, reason };
    }
  }
}
