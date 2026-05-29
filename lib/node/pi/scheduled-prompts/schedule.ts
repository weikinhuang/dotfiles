/**
 * Schedule model + "next fire" computation for the scheduled-prompts
 * extension.
 *
 * A `Schedule` couples a prompt to fire with a trigger describing WHEN
 * to fire it. Three trigger kinds:
 *   - `cron`     recurring, 5-field cron expression (local time)
 *   - `interval` recurring, fixed millisecond cadence anchored on
 *                `createdAt` so the phase is stable across re-arms
 *   - `once`     a single fire at an absolute epoch-ms instant
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

export type Trigger = { kind: 'cron'; expr: string } | { kind: 'interval'; ms: number } | { kind: 'once'; at: number };

export interface Schedule {
  id: string;
  name?: string;
  prompt: string;
  trigger: Trigger;
  jitterMs?: number;
  scope: ScheduleScope;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  runCount: number;
  /** Cached next fire instant (epoch ms). Undefined when not armed. */
  nextFireAt?: number;
}

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
  };
  const next = computeNextFire(ran, new Date(firedAt), rng);
  return { ...ran, nextFireAt: next ?? undefined };
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
  }
}
