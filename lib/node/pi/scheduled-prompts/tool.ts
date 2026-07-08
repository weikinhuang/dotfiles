/**
 * Pure trigger construction for the `schedule` LLM tool's structured
 * parameters (as opposed to `parse-command.ts`, which parses the
 * `/schedule` command string). The tool passes each trigger kind as its
 * own optional field (`cron`, `every`, `in`, `at`, `after`); exactly one
 * must be set. Time-relative kinds (`in`, `at`) resolve against an
 * injected `now` so the builder stays pure and testable.
 *
 * Pure module - no pi imports - so it is directly unit-testable.
 */

import { parseCron } from './cron.ts';
import { parseDuration, parseDurationRange } from './duration.ts';
import type { Trigger } from './schedule.ts';

/** The subset of the schedule-tool params that select a trigger. */
export interface TriggerParams {
  cron?: string;
  every?: string;
  in?: string;
  at?: string;
  after?: string;
}

/** A built trigger, or a human-readable validation error. */
export type TriggerResult = { trigger: Trigger } | { error: string };

/**
 * Build a {@link Trigger} from the tool's structured trigger params,
 * resolving `in` / `at` against `now` (epoch ms). Requires exactly one
 * of `cron` / `every` / `in` / `at` / `after`; returns an `error` for
 * none, more than one, or an unparseable value.
 */
export function buildTriggerFromParams(params: TriggerParams, now: number): TriggerResult {
  const provided = [params.cron, params.every, params.in, params.at, params.after].filter((v) => v !== undefined);
  if (provided.length === 0) return { error: 'a trigger is required (cron, every, in, at, or after)' };
  if (provided.length > 1) return { error: 'only one trigger may be set (cron, every, in, at, or after)' };
  if (params.cron !== undefined) {
    if (parseCron(params.cron) === null) return { error: `invalid cron expression: "${params.cron}"` };
    return { trigger: { kind: 'cron', expr: params.cron.trim() } };
  }
  if (params.every !== undefined) {
    const ms = parseDuration(params.every);
    if (ms === null) return { error: `invalid every duration: "${params.every}"` };
    return { trigger: { kind: 'interval', ms } };
  }
  if (params.after !== undefined) {
    const range = parseDurationRange(params.after);
    if (range === null) return { error: `invalid after range (expected min-max): "${params.after}"` };
    return { trigger: { kind: 'after', minMs: range.minMs, maxMs: range.maxMs } };
  }
  if (params.in !== undefined) {
    const ms = parseDuration(params.in);
    if (ms === null) return { error: `invalid in duration: "${params.in}"` };
    return { trigger: { kind: 'once', at: now + ms } };
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec((params.at ?? '').trim());
  if (!match) return { error: `invalid at time (expected HH:MM): "${params.at}"` };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { error: `invalid at time (expected HH:MM): "${params.at}"` };
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return { trigger: { kind: 'once', at: target.getTime() } };
}
