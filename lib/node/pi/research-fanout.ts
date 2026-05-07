/**
 * Parallel subagent dispatcher for research-core.
 *
 * `fanout` takes a list of tasks (each an `{id, prompt}` pair aimed
 * at the same agent) and runs them in parallel against a single
 * run directory, returning an aggregate `FanoutResult` that buckets
 * each task as `completed`, `failed`, or `aborted`. This is the
 * primitive deep-research uses to drive one subagent per
 * sub-question and autoresearch uses to run independent experiments
 * side-by-side.
 *
 * Three reliability properties drive the design:
 *
 *   1. **k-of-N partial failure tolerance.** One stalled, errored,
 *      or crashed child MUST NOT take down the others. Every task
 *      is wrapped in try/catch and its outcome — success or
 *      failure — is isolated to its own slot in the result
 *      buckets.
 *
 *   2. **Per-handle watchdog.** Each task runs under
 *      `research-watchdog.watch` with the fanout's configured
 *      `staleThresholdMs` / `pollIntervalMs`, so a silently-hung
 *      child is aborted rather than burning the parent's wall
 *      clock. Stall events are journaled at `warn` level so a
 *      later reader can see why a task ended up in the `aborted`
 *      bucket.
 *
 *   3. **Resumable via `fanout.json`.** Every state transition
 *      (spawn, complete, fail, abort) is persisted atomically to
 *      `<runRoot>/fanout.json`. On re-entry, tasks already in a
 *      terminal state are kept verbatim and ONLY the missing tasks
 *      are re-spawned. This is what lets a user kill the parent
 *      session mid-run, restart, and have deep-research pick up
 *      from where it left off without burning duplicate compute.
 *
 * **Transport abstraction.** The module does not import from
 * `@earendil-works/pi-coding-agent` directly. Instead callers inject
 * a `FanoutSpawner` that, given a task and a mode, returns a
 * `FanoutHandleLike`. The real extension wires this to pi's
 * `subagent({run_in_background: true})` for `mode="background"` or
 * an in-session spawn for `mode="sync"`. Tests provide a
 * hand-rolled mock spawner that scripts the handle's status +
 * result. This mirrors the injection pattern already used by
 * `research-tiny.ts` for `runOneShotAgent` and is why the module
 * can live in `lib/node/pi/` under the root tsconfig.
 *
 * **Wall clock.** `spec.wallClockSec` is enforced by an internal
 * `AbortController` fired at the deadline. The controller's signal
 * is threaded into each watchdog; when it fires, any in-flight
 * watchdog classifies as `aborted-by-parent`, we abort the
 * underlying handle, and mark the task as aborted with a
 * deadline-hit reason. Tasks not yet spawned are marked aborted
 * without spawning.
 *
 * No pi imports.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { watch, type WatchdogHandleLike } from './research-watchdog.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

/** Input pair handed to each spawned subagent. */
export interface FanoutTask {
  /** Stable identifier. Used as the handle id + persistence key. */
  id: string;
  /** Full user-turn prompt driving the child agent. */
  prompt: string;
}

/**
 * Execution mode for the fanout.
 *
 *   - `background`: spawn each task with `run_in_background: true`
 *     and drive them concurrently.
 *   - `sync`: the caller is running inside a context where
 *     `run_in_background` is unavailable (print mode, hook context,
 *     test harness). Tasks run through the same spawner interface
 *     but the spawner is expected to execute them inline. The
 *     fanout still respects `maxConcurrent` — sync with
 *     `maxConcurrent: 1` is the natural "run them one after
 *     another" shape.
 */
export type FanoutMode = 'background' | 'sync';

/** High-level configuration handed to {@link fanout}. */
export interface FanoutSpec {
  /** Agent name forwarded to the spawner (e.g. `research-subagent`). */
  agentName: string;
  /** Ordered list of tasks to dispatch. */
  tasks: readonly FanoutTask[];
  /** Background vs sync dispatch. */
  mode: FanoutMode;
  /** Max parallel in-flight tasks. Defaults to `tasks.length`. */
  maxConcurrent?: number;
  /** Hard wall-clock cap for the entire fanout. */
  wallClockSec: number;
}

/**
 * Aggregated outcome of a fanout run. Buckets are populated in the
 * same order tasks appear in `spec.tasks` (so the caller can rely on
 * positional stability for status widgets and resume logs).
 *
 *   - `completed`: child returned a non-empty final assistant text.
 *   - `failed`: child threw, erorred, or returned an unusable
 *     result. `reason` is the stringified cause.
 *   - `aborted`: watchdog stalled, deadline fired, or caller's
 *     `AbortSignal` tripped. `reason` carries the stall / abort
 *     explanation.
 */
export interface FanoutResult {
  completed: { id: string; output: string }[];
  failed: { id: string; reason: string }[];
  aborted: { id: string; reason: string }[];
}

/**
 * Final outcome of a single handle, as returned by the spawner's
 * `wait()` method. `aborted` distinguishes a polite external abort
 * from a plain failure — when the flag is set, the fanout buckets
 * the task as `aborted` rather than `failed`.
 */
export type FanoutHandleResult = { ok: true; output: string } | { ok: false; reason: string; aborted?: boolean };

/**
 * Structural shape of a spawned handle. Extends the watchdog's
 * handle interface with `wait()` so the fanout can retrieve the
 * child's final answer once the watchdog observes completion.
 */
export interface FanoutHandleLike extends WatchdogHandleLike {
  wait(): Promise<FanoutHandleResult>;
}

/** Arguments passed to a {@link FanoutSpawner}. */
export interface FanoutSpawnArgs {
  agentName: string;
  mode: FanoutMode;
  task: FanoutTask;
  /**
   * Merged abort signal (caller's `signal` OR the fanout's internal
   * wall-clock deadline). Spawners that propagate cancellation
   * forward this to the underlying subagent infra.
   */
  signal?: AbortSignal;
}

/** Transport adapter supplied by the caller / extension wiring. */
export type FanoutSpawner = (args: FanoutSpawnArgs) => Promise<FanoutHandleLike>;

/** Dependency bag — mirrors the wiring style in research-tiny.ts. */
export interface FanoutDeps {
  /** Spawner bridging to the real subagent runtime (or a mock). */
  spawn: FanoutSpawner;
  /** Optional journal path; stall + resume lines land there. */
  journalPath?: string;
  /** Watchdog stall threshold forwarded per-task. */
  staleThresholdMs?: number;
  /** Watchdog poll interval forwarded per-task. */
  pollIntervalMs?: number;
  /** Clock source for ISO timestamps in persisted state. */
  now?: () => Date;
  /** Clock source for elapsed-ms math (watchdog + deadline). */
  clock?: () => number;
  /** Sleep override (tests use a virtual clock). */
  sleep?: (ms: number) => Promise<void>;
  /** Parent abort signal — fires wall-clock-early termination too. */
  signal?: AbortSignal;
}

// ──────────────────────────────────────────────────────────────────────
// Persistence shape
// ──────────────────────────────────────────────────────────────────────

/** Terminal states never re-spawn on resume. */
export type FanoutTaskState = 'pending' | 'spawned' | 'completed' | 'failed' | 'aborted';

const TERMINAL_STATES: readonly FanoutTaskState[] = ['completed', 'failed', 'aborted'];

/** One entry per task in `fanout.json`. */
export interface PersistedTask {
  id: string;
  prompt: string;
  state: FanoutTaskState;
  output?: string;
  reason?: string;
  spawnedAt?: string;
  finishedAt?: string;
}

/**
 * On-disk shape of `fanout.json`. `version: 1` pins the format so a
 * future shape change can trip a tolerant upgrade path rather than
 * silently loading stale state.
 */
export interface PersistedFanout {
  version: 1;
  mode: FanoutMode;
  agentName: string;
  tasks: PersistedTask[];
}

function isFanoutTaskState(v: unknown): v is FanoutTaskState {
  return v === 'pending' || v === 'spawned' || v === 'completed' || v === 'failed' || v === 'aborted';
}

function isTerminal(state: FanoutTaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

function toPersistedTask(raw: unknown): PersistedTask | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.prompt !== 'string') return null;
  if (!isFanoutTaskState(raw.state)) return null;
  const out: PersistedTask = { id: raw.id, prompt: raw.prompt, state: raw.state };
  if (typeof raw.output === 'string') out.output = raw.output;
  if (typeof raw.reason === 'string') out.reason = raw.reason;
  if (typeof raw.spawnedAt === 'string') out.spawnedAt = raw.spawnedAt;
  if (typeof raw.finishedAt === 'string') out.finishedAt = raw.finishedAt;
  return out;
}

function loadPersisted(path: string): PersistedFanout | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (parsed.mode !== 'background' && parsed.mode !== 'sync') return null;
    if (typeof parsed.agentName !== 'string') return null;
    if (!Array.isArray(parsed.tasks)) return null;
    const tasks: PersistedTask[] = [];
    for (const entry of parsed.tasks) {
      const pt = toPersistedTask(entry);
      if (pt) tasks.push(pt);
    }
    return { version: 1, mode: parsed.mode, agentName: parsed.agentName, tasks };
  } catch {
    return null;
  }
}

function persist(path: string, state: PersistedFanout): void {
  atomicWriteFile(path, JSON.stringify(state, null, 2) + '\n');
}

// ──────────────────────────────────────────────────────────────────────
// Merged abort signal
// ──────────────────────────────────────────────────────────────────────

/**
 * Produce an `AbortController` whose signal fires when EITHER the
 * caller's `signal` fires OR `timeoutMs` elapses. We do not rely on
 * `AbortSignal.any` / `AbortSignal.timeout` because the module
 * supports Node versions where the former may be missing; the
 * hand-rolled merge stays deterministic under `vitest`'s fake timer
 * mode and lets the `sleep` injection drive the deadline in tests.
 *
 * Returns both the controller (so the fanout can fire it manually on
 * normal completion, avoiding a leaked timer) and the configured
 * timer handle so the caller can `clearTimeout` on cleanup.
 */
function makeMergedAbort(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners: (() => void)[] = [];

  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason ?? new Error('parent aborted'));
    } else {
      const onParent = (): void => {
        if (!controller.signal.aborted) controller.abort(parent.reason ?? new Error('parent aborted'));
      };
      parent.addEventListener('abort', onParent, { once: true });
      listeners.push(() => parent.removeEventListener('abort', onParent));
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted)
        controller.abort(new Error(`fanout wall-clock exceeded (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    // Don't keep the process alive waiting on a fanout timer — the
    // deadline is advisory; the caller's normal flow always clears
    // it before the fanout resolves.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref!();
    }
  }

  return {
    controller,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      for (const l of listeners) l();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Main dispatcher
// ──────────────────────────────────────────────────────────────────────

// Defaults are provided by the underlying `research-watchdog`
// when the caller doesn't set them — nothing to re-declare here.

interface RunOneArgs {
  spec: FanoutSpec;
  deps: FanoutDeps;
  fanoutPath: string;
  persisted: PersistedFanout;
  mergedSignal: AbortSignal;
  taskRec: PersistedTask;
}

/**
 * Execute a single task end-to-end: spawn, watchdog, wait for
 * result, record outcome. All failure modes land as terminal
 * state transitions on `taskRec`; nothing bubbles out (the caller
 * awaits all of these concurrently via `Promise.allSettled`).
 */
async function runOne(args: RunOneArgs): Promise<void> {
  const { spec, deps, fanoutPath, persisted, mergedSignal, taskRec } = args;
  const nowFn = deps.now ?? ((): Date => new Date());
  const journalWrite = (heading: string, reason: string, level: 'warn' | 'error' = 'warn'): void => {
    if (!deps.journalPath) return;
    try {
      appendJournal(deps.journalPath, { level, heading, body: reason });
    } catch {
      /* swallow — journal failures never break the dispatcher */
    }
  };

  // Fast-fail: the fanout already hit its deadline / parent abort.
  if (mergedSignal.aborted) {
    taskRec.state = 'aborted';
    taskRec.reason = 'fanout aborted before task spawned';
    taskRec.finishedAt = nowFn().toISOString();
    persist(fanoutPath, persisted);
    return;
  }

  let handle: FanoutHandleLike;
  try {
    handle = await deps.spawn({
      agentName: spec.agentName,
      mode: spec.mode,
      task: { id: taskRec.id, prompt: taskRec.prompt },
      signal: mergedSignal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    taskRec.state = 'failed';
    taskRec.reason = `spawn failed: ${reason}`;
    taskRec.finishedAt = nowFn().toISOString();
    persist(fanoutPath, persisted);
    journalWrite(`fanout spawn failed: ${taskRec.id}`, reason, 'error');
    return;
  }

  taskRec.state = 'spawned';
  taskRec.spawnedAt = nowFn().toISOString();
  persist(fanoutPath, persisted);

  // Watchdog enforces stall + parent abort. We pass the mergedSignal
  // so both the fanout deadline and the user's Ctrl-C land here.
  const watchResult = await watch({
    handle,
    ...(deps.staleThresholdMs !== undefined ? { staleThresholdMs: deps.staleThresholdMs } : {}),
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.clock !== undefined ? { now: deps.clock } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    signal: mergedSignal,
    ...(deps.journalPath !== undefined ? { journalPath: deps.journalPath } : {}),
  });

  if (watchResult.kind === 'stalled') {
    taskRec.state = 'aborted';
    taskRec.reason = watchResult.reason;
    taskRec.finishedAt = nowFn().toISOString();
    persist(fanoutPath, persisted);
    return;
  }

  if (watchResult.kind === 'aborted-by-parent') {
    // Try to abort the handle defensively — the parent caller may
    // have bailed without giving the spawner a chance to react.
    try {
      await handle.abort('fanout aborted (parent signal or deadline)');
    } catch {
      /* swallow — child may already be dead */
    }
    taskRec.state = 'aborted';
    taskRec.reason = 'fanout aborted (parent signal or deadline)';
    taskRec.finishedAt = nowFn().toISOString();
    persist(fanoutPath, persisted);
    return;
  }

  if (watchResult.kind === 'errored') {
    taskRec.state = 'failed';
    taskRec.reason = watchResult.lastStatus.error ?? 'child errored';
    taskRec.finishedAt = nowFn().toISOString();
    persist(fanoutPath, persisted);
    journalWrite(`fanout child errored: ${taskRec.id}`, taskRec.reason, 'error');
    return;
  }

  // Watchdog observed normal completion. Ask the handle for its
  // final answer — this is the step that translates the child's
  // session state into a string we can hand back to the parent.
  let waitResult: FanoutHandleResult;
  try {
    waitResult = await handle.wait();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    taskRec.state = 'failed';
    taskRec.reason = `wait failed: ${reason}`;
    taskRec.finishedAt = nowFn().toISOString();
    persist(fanoutPath, persisted);
    journalWrite(`fanout wait failed: ${taskRec.id}`, reason, 'error');
    return;
  }

  if (waitResult.ok) {
    taskRec.state = 'completed';
    taskRec.output = waitResult.output;
    taskRec.finishedAt = nowFn().toISOString();
    persist(fanoutPath, persisted);
    return;
  }

  // Non-ok. Aborted is distinguished from plain failure by the
  // `aborted` flag — spawners that know a child was canceled
  // externally (user Ctrl-C, subagent_send abort) set it.
  if (waitResult.aborted) {
    taskRec.state = 'aborted';
    taskRec.reason = waitResult.reason || 'child aborted';
  } else {
    taskRec.state = 'failed';
    taskRec.reason = waitResult.reason || 'child failed';
  }
  taskRec.finishedAt = nowFn().toISOString();
  persist(fanoutPath, persisted);
}

/**
 * Drive the parallel dispatch. See the module header for the full
 * contract. High-level sequence:
 *
 *   1. Load (or initialize) `<runRoot>/fanout.json`.
 *   2. Merge each spec task against the persisted entry: terminal
 *      states are kept verbatim, everything else becomes `pending`.
 *   3. Compute a pending index list, respecting `maxConcurrent`
 *      in-flight tasks at any time.
 *   4. Arm the wall-clock deadline + parent-signal merger.
 *   5. Launch tasks; as each resolves, start the next pending one.
 *   6. Once the dispatch drains, tear down the deadline timer and
 *      aggregate the persisted task states into `FanoutResult`.
 *
 * The function is deliberately async-await rather than a for-loop
 * inside `Promise.allSettled`: we want bounded concurrency (not "all
 * at once") and we want new tasks to start the moment a slot frees,
 * not wait for a synchronous batch boundary.
 */
export async function fanout(spec: FanoutSpec, runRoot: string, deps: FanoutDeps): Promise<FanoutResult> {
  const fanoutPath = paths(runRoot).fanout;
  const nowFn = deps.now ?? ((): Date => new Date());

  // 1. Merge spec + persisted state.
  const prior = loadPersisted(fanoutPath);
  const priorById = new Map<string, PersistedTask>();
  if (prior) {
    for (const t of prior.tasks) priorById.set(t.id, t);
  }

  const tasks: PersistedTask[] = spec.tasks.map((t) => {
    const existing = priorById.get(t.id);
    if (existing && isTerminal(existing.state)) {
      // Preserve the prompt the terminal task was dispatched with —
      // if the caller changed the prompt between runs we trust the
      // on-disk result (the user explicitly opted into resume by
      // keeping the same run root).
      return existing;
    }
    return { id: t.id, prompt: t.prompt, state: 'pending' };
  });

  const persisted: PersistedFanout = {
    version: 1,
    mode: spec.mode,
    agentName: spec.agentName,
    tasks,
  };
  persist(fanoutPath, persisted);

  if (deps.journalPath && prior) {
    const resumed = tasks.filter((t) => isTerminal(t.state)).length;
    if (resumed > 0) {
      try {
        appendJournal(deps.journalPath, {
          level: 'step',
          heading: `fanout resume: ${resumed}/${tasks.length} tasks already terminal`,
        });
      } catch {
        /* swallow */
      }
    }
  }

  // 2. Build the pending queue.
  const pendingIdx: number[] = [];
  for (let i = 0; i < tasks.length; i++) {
    if (!isTerminal(tasks[i].state)) pendingIdx.push(i);
  }

  // 3. Arm the merged abort signal (parent OR wall-clock deadline).
  const wallClockMs = Math.max(0, spec.wallClockSec * 1000);
  const merged = makeMergedAbort(deps.signal, wallClockMs);

  // 4. Bounded concurrency scheduler. We track active promises in
  //    an array so `Promise.race` can wake us on the first resolve.
  const maxConcurrent = Math.max(1, spec.maxConcurrent ?? tasks.length);
  const active = new Set<Promise<void>>();
  let nextIdx = 0;

  const launch = (taskIdx: number): Promise<void> => {
    const p = runOne({
      spec,
      deps,
      fanoutPath,
      persisted,
      mergedSignal: merged.controller.signal,
      taskRec: tasks[taskIdx],
    }).finally(() => {
      active.delete(p);
    });
    active.add(p);
    return p;
  };

  try {
    while (nextIdx < pendingIdx.length || active.size > 0) {
      while (active.size < maxConcurrent && nextIdx < pendingIdx.length) {
        void launch(pendingIdx[nextIdx++]);
      }
      if (active.size > 0) {
        await Promise.race(active);
      }
    }
  } finally {
    merged.cleanup();
  }

  // 5. If the deadline fired while tasks were still pending, those
  //    are left in `pending` — classify them as aborted so the
  //    result buckets are complete.
  const finalizedAt = nowFn().toISOString();
  let changedPostDispatch = false;
  for (const t of tasks) {
    if (!isTerminal(t.state)) {
      t.state = 'aborted';
      t.reason = t.reason ?? 'fanout deadline reached before task started';
      t.finishedAt = t.finishedAt ?? finalizedAt;
      changedPostDispatch = true;
    }
  }
  if (changedPostDispatch) persist(fanoutPath, persisted);

  // 6. Aggregate buckets in spec-order.
  const result: FanoutResult = { completed: [], failed: [], aborted: [] };
  for (const t of tasks) {
    if (t.state === 'completed') {
      result.completed.push({ id: t.id, output: t.output ?? '' });
    } else if (t.state === 'failed') {
      result.failed.push({ id: t.id, reason: t.reason ?? 'unknown failure' });
    } else if (t.state === 'aborted') {
      result.aborted.push({ id: t.id, reason: t.reason ?? 'unknown abort' });
    }
  }
  return result;
}
