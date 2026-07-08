/**
 * Schedule model + "next fire" computation for the scheduled-prompts
 * extension.
 *
 * A `Schedule` couples a prompt to fire with a trigger describing WHEN
 * to fire it. Trigger kinds:
 *   - `cron`     recurring, 5-field cron expression (local time)
 *   - `interval` recurring, fixed millisecond cadence anchored on
 *                `createdAt` so the phase is stable across re-arms
 *   - `once`     a single fire at an absolute epoch-ms instant
 *   - `after`    activity-anchored: a random `[minMs, maxMs]` after the
 *                last conversation activity, repeating during silence
 *                with an exponential backoff that resets when the user
 *                speaks (see `applyActivity` / `recordRun`)
 *
 * Optional `jitterMs` shifts the computed fire time FORWARD by a random
 * `[0, jitterMs)` amount so multiple sessions / users don't stampede at
 * the exact same instant. Jitter only ever delays, never advances, so a
 * cron schedule never fires before its nominal minute.
 *
 * `nextFireAt` is the authoritative cached fire instant. The extension
 * computes it once (at creation, on enable, and after each fire) and
 * persists it, so re-arming on `/reload` does not re-roll jitter or
 * drift the cadence. `reconcileSchedule` recomputes it only when it is
 * missing or a recurring schedule has fallen into the past (a fire
 * missed while pi was closed is skipped rather than fired late).
 *
 * RNG is injected so jitter is deterministic under test.
 *
 * Pure module - no pi imports - so it is directly unit-testable.
 */

import { cronNext, parseCron } from './cron.ts';

export type ScheduleScope = 'global' | 'project' | 'session';

export const SCHEDULE_SCOPES: readonly ScheduleScope[] = ['global', 'project', 'session'];

export type Trigger =
  | { kind: 'cron'; expr: string }
  | { kind: 'interval'; ms: number }
  | { kind: 'once'; at: number }
  /**
   * Activity-anchored: fire a random `[minMs, maxMs]` after the last
   * conversation activity, repeating during silence (with backoff) and
   * resetting when the user speaks. The roleplay "feels alive" beat.
   */
  | { kind: 'after'; minMs: number; maxMs: number };

/** How a multi-prompt schedule chooses which prompt to fire. */
export type PromptPick = 'random' | 'roundRobin';

export interface Schedule {
  id: string;
  name?: string;
  /** Primary prompt; also the representative shown in listings. */
  prompt: string;
  /**
   * Optional pool of alternative prompts. When non-empty, each fire
   * picks one of these (see `promptPick`) instead of `prompt`, so a
   * recurring nudge can vary its content.
   */
  prompts?: string[];
  promptPick?: PromptPick;
  /** Round-robin cursor into `prompts` (advanced per fire). */
  promptCursor?: number;
  trigger: Trigger;
  jitterMs?: number;
  scope: ScheduleScope;
  enabled: boolean;
  /** Recompute `nextFireAt` from "now" on each interactive user input. */
  resetOnActivity?: boolean;
  /** Only fire while the agent is idle; defer (don't interrupt) if busy. */
  whenIdle?: boolean;
  /** Retire the schedule once `runCount` reaches this many fires. */
  maxRuns?: number;
  /** Probability in [0, 1] that a due fire actually fires. */
  chance?: number;
  /**
   * Consecutive fires since the last interactive user input. Drives the
   * `after` backoff; reset to 0 whenever the user speaks.
   */
  unansweredRuns?: number;
  createdAt: number;
  lastRunAt?: number;
  runCount: number;
  /** Cached next fire instant (epoch ms). Undefined when not armed. */
  nextFireAt?: number;
}

/** Each unanswered `after` fire widens the window by this factor... */
export const AFTER_BACKOFF_FACTOR = 2;
/** ...up to this cap, so the character backs off but never goes silent forever. */
export const AFTER_BACKOFF_MAX_SCALE = 8;

/**
 * Fire schedules whose cached target lands within this window of the
 * wake-up, to absorb timer slop (the timer always wakes a hair after the
 * target, so the cached instant is slightly in the past at wake time).
 */
export const FIRE_SLOP_MS = 1_000;

/** Random number source, injectable for deterministic tests. */
export type Rng = () => number;

function jitterFor(schedule: Schedule, rng: Rng): number {
  const j = schedule.jitterMs;
  if (!j || j <= 0) return 0;
  return Math.floor(rng() * j);
}

/**
 * Compute the next fire instant (epoch ms) strictly after `after`, or
 * `null` when the schedule will never fire again (a `once` that already
 * ran, or an unparseable cron expression). Jitter is applied here, so
 * callers that want a stable target should compute once and cache.
 */
export function computeNextFire(schedule: Schedule, after: Date, rng: Rng = Math.random): number | null {
  // A retired schedule (hit its run cap) never fires again.
  if (schedule.maxRuns !== undefined && schedule.runCount >= schedule.maxRuns) return null;
  const { trigger } = schedule;
  if (trigger.kind === 'once') {
    if (schedule.runCount > 0) return null;
    return trigger.at + jitterFor(schedule, rng);
  }
  if (trigger.kind === 'interval') {
    if (trigger.ms <= 0) return null;
    const elapsed = after.getTime() - schedule.createdAt;
    const intervals = elapsed < 0 ? 0 : Math.floor(elapsed / trigger.ms) + 1;
    const base = schedule.createdAt + intervals * trigger.ms;
    return base + jitterFor(schedule, rng);
  }
  if (trigger.kind === 'after') {
    if (trigger.minMs < 0 || trigger.maxMs < trigger.minMs || trigger.maxMs <= 0) return null;
    const scale = Math.min(AFTER_BACKOFF_FACTOR ** (schedule.unansweredRuns ?? 0), AFTER_BACKOFF_MAX_SCALE);
    const min = trigger.minMs * scale;
    const max = trigger.maxMs * scale;
    const delay = min + Math.floor(rng() * (max - min + 1));
    return after.getTime() + delay;
  }
  const fields = parseCron(trigger.expr);
  if (fields === null) return null;
  return cronNext(fields, after).getTime() + jitterFor(schedule, rng);
}

/**
 * Return a copy of `schedule` with `nextFireAt` brought up to date for
 * the current instant `now` (epoch ms):
 *   - disabled        -> `nextFireAt` cleared
 *   - `once`          -> keep the cached target (fires even if overdue)
 *   - recurring       -> keep a future cached target; recompute from
 *                        `now` when missing or in the past (skip the
 *                        missed fire rather than fire it late)
 */
export function reconcileSchedule(schedule: Schedule, now: number, rng: Rng = Math.random): Schedule {
  if (!schedule.enabled) {
    return schedule.nextFireAt === undefined ? schedule : { ...schedule, nextFireAt: undefined };
  }
  if (schedule.nextFireAt !== undefined) {
    if (schedule.trigger.kind === 'once') return schedule;
    if (schedule.nextFireAt >= now) return schedule;
  }
  const next = computeNextFire(schedule, new Date(now), rng);
  return { ...schedule, nextFireAt: next ?? undefined };
}

/**
 * Mark a schedule as fired at `firedAt` (epoch ms): bump
 * `lastRunAt`/`runCount` and recompute `nextFireAt` for the following
 * occurrence (`undefined` for a spent `once`).
 */
export function recordRun(schedule: Schedule, firedAt: number, rng: Rng = Math.random): Schedule {
  const ran: Schedule = {
    ...schedule,
    lastRunAt: firedAt,
    runCount: schedule.runCount + 1,
    // `after` backs off across consecutive unanswered fires; other kinds
    // ignore the counter.
    unansweredRuns: schedule.trigger.kind === 'after' ? (schedule.unansweredRuns ?? 0) + 1 : schedule.unansweredRuns,
  };
  const next = computeNextFire(ran, new Date(firedAt), rng);
  return { ...ran, nextFireAt: next ?? undefined };
}

/**
 * Recompute `nextFireAt` anchored at `at` (epoch ms) for an activity
 * event. `resetBackoff` (true for interactive user input, false for an
 * agent turn ending) zeroes the `after` backoff so the next beat returns
 * to the base window. Disabled schedules are returned unchanged.
 */
export function applyActivity(
  schedule: Schedule,
  at: number,
  rng: Rng = Math.random,
  opts: { resetBackoff: boolean } = { resetBackoff: true },
): Schedule {
  if (!schedule.enabled) return schedule;
  const base = opts.resetBackoff ? { ...schedule, unansweredRuns: 0 } : schedule;
  const next = computeNextFire(base, new Date(at), rng);
  return { ...base, nextFireAt: next ?? undefined };
}

/** The prompts a fire may choose from: the pool, or `[prompt]` if none. */
export function scheduleCandidates(schedule: Schedule): string[] {
  return schedule.prompts && schedule.prompts.length > 0 ? schedule.prompts : [schedule.prompt];
}

/**
 * Pick the prompt text for a fire and the cursor to persist afterward.
 * Single-prompt schedules return that prompt; multi-prompt schedules pick
 * round-robin (advancing the cursor) or at random (cursor unchanged).
 */
export function pickPrompt(schedule: Schedule, rng: Rng = Math.random): { text: string; cursor: number } {
  const candidates = scheduleCandidates(schedule);
  const cursor = schedule.promptCursor ?? 0;
  if (candidates.length === 1) return { text: candidates[0], cursor };
  if (schedule.promptPick === 'roundRobin') {
    const at = ((cursor % candidates.length) + candidates.length) % candidates.length;
    return { text: candidates[at], cursor: (at + 1) % candidates.length };
  }
  return { text: candidates[Math.floor(rng() * candidates.length)], cursor };
}

/**
 * Whether a schedule should only fire while the agent is idle. `after`
 * (idle nudge) defaults to idle-only; everything else fires regardless
 * unless explicitly set via `whenIdle`.
 */
export function wantsIdle(schedule: Schedule): boolean {
  return schedule.whenIdle ?? schedule.trigger.kind === 'after';
}

/**
 * Whether `schedule` is due to fire at `now` (epoch ms): enabled, armed,
 * and its cached `nextFireAt` at or before `now + slopMs`. Fires on the
 * cached target without reconciling forward, so a timer that wakes a hair
 * late still fires the occurrence it woke for.
 */
export function isDue(schedule: Schedule, now: number, slopMs: number = FIRE_SLOP_MS): boolean {
  if (!schedule.enabled || schedule.nextFireAt === undefined) return false;
  return schedule.nextFireAt <= now + slopMs;
}

/**
 * The fields a freshly-created schedule is shaped from - everything but
 * the derived lifecycle bookkeeping (`enabled`, `createdAt`, `runCount`,
 * `nextFireAt`), which {@link buildSchedule} fills in.
 */
export interface ScheduleInit {
  id: string;
  name?: string;
  prompt: string;
  prompts?: string[];
  promptPick?: PromptPick;
  trigger: Trigger;
  jitterMs?: number;
  scope: ScheduleScope;
  resetOnActivity?: boolean;
  whenIdle?: boolean;
  maxRuns?: number;
  chance?: number;
}

/**
 * Shape a new enabled `Schedule` from {@link ScheduleInit} at creation
 * time `now` (epoch ms) and compute its first `nextFireAt`. An `after`
 * trigger defaults `resetOnActivity`/`whenIdle` on (an idle nudge resets
 * on activity and never interrupts) unless the caller set them explicitly.
 */
export function buildSchedule(init: ScheduleInit, now: number, rng: Rng = Math.random): Schedule {
  const isAfter = init.trigger.kind === 'after';
  const schedule: Schedule = {
    id: init.id,
    name: init.name,
    prompt: init.prompt,
    prompts: init.prompts,
    promptPick: init.promptPick,
    trigger: init.trigger,
    jitterMs: init.jitterMs,
    scope: init.scope,
    enabled: true,
    resetOnActivity: init.resetOnActivity ?? (isAfter || undefined),
    whenIdle: init.whenIdle ?? (isAfter || undefined),
    maxRuns: init.maxRuns,
    chance: init.chance,
    createdAt: now,
    runCount: 0,
  };
  schedule.nextFireAt = computeNextFire(schedule, new Date(now), rng) ?? undefined;
  return schedule;
}

/** A short, URL-safe schedule id like `sp-k3x9a2`. */
export function makeScheduleId(rng: Rng = Math.random): string {
  const rand = Math.floor(rng() * 0x7fffffff)
    .toString(36)
    .padStart(6, '0');
  return `sp-${rand.slice(0, 6)}`;
}

function formatIntervalMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Human-readable one-line description of a trigger (for listings). */
export function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'cron':
      return `cron "${trigger.expr}"`;
    case 'interval':
      return `every ${formatIntervalMs(trigger.ms)}`;
    case 'once':
      return `once at ${new Date(trigger.at).toLocaleString()}`;
    case 'after':
      return `after ${formatIntervalMs(trigger.minMs)}-${formatIntervalMs(trigger.maxMs)} idle`;
  }
}
