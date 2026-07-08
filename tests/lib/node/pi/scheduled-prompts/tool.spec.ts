/**
 * Tests for lib/node/pi/scheduled-prompts/tool.ts - the schedule tool's
 * structured-param trigger builder.
 */

import { describe, expect, test } from 'vitest';

import { type Trigger } from '../../../../../lib/node/pi/scheduled-prompts/schedule.ts';
import { buildTriggerFromParams } from '../../../../../lib/node/pi/scheduled-prompts/tool.ts';

const NOW = new Date(2026, 0, 1, 8, 0, 0).getTime();

function trigger(result: ReturnType<typeof buildTriggerFromParams>): Trigger {
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return result.trigger;
}

describe('buildTriggerFromParams', () => {
  test('requires exactly one trigger', () => {
    expect(buildTriggerFromParams({}, NOW)).toEqual({
      error: 'a trigger is required (cron, every, in, at, or after)',
    });
    expect(buildTriggerFromParams({ cron: '0 9 * * *', every: '30m' }, NOW)).toEqual({
      error: 'only one trigger may be set (cron, every, in, at, or after)',
    });
  });

  test('cron trims and validates', () => {
    expect(trigger(buildTriggerFromParams({ cron: ' 0 9 * * * ' }, NOW))).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(buildTriggerFromParams({ cron: 'nope' }, NOW)).toEqual({ error: 'invalid cron expression: "nope"' });
  });

  test('every parses a duration to interval ms', () => {
    expect(trigger(buildTriggerFromParams({ every: '30m' }, NOW))).toEqual({ kind: 'interval', ms: 30 * 60_000 });
    expect(buildTriggerFromParams({ every: 'soon' }, NOW)).toEqual({ error: 'invalid every duration: "soon"' });
  });

  test('after parses a range', () => {
    expect(trigger(buildTriggerFromParams({ after: '30s-5m' }, NOW))).toEqual({
      kind: 'after',
      minMs: 30_000,
      maxMs: 300_000,
    });
    expect(buildTriggerFromParams({ after: '5m-1m' }, NOW)).toEqual({
      error: 'invalid after range (expected min-max): "5m-1m"',
    });
  });

  test('in resolves relative to now', () => {
    expect(trigger(buildTriggerFromParams({ in: '10m' }, NOW))).toEqual({ kind: 'once', at: NOW + 10 * 60_000 });
    expect(buildTriggerFromParams({ in: 'later' }, NOW)).toEqual({ error: 'invalid in duration: "later"' });
  });

  test('at resolves to the next local HH:MM', () => {
    // 09:00 is later today.
    expect(trigger(buildTriggerFromParams({ at: '09:00' }, NOW))).toEqual({
      kind: 'once',
      at: new Date(2026, 0, 1, 9, 0, 0).getTime(),
    });
    // 07:00 already passed today -> rolls to tomorrow.
    expect(trigger(buildTriggerFromParams({ at: '07:00' }, NOW))).toEqual({
      kind: 'once',
      at: new Date(2026, 0, 2, 7, 0, 0).getTime(),
    });
    expect(buildTriggerFromParams({ at: '99:99' }, NOW)).toEqual({
      error: 'invalid at time (expected HH:MM): "99:99"',
    });
    expect(buildTriggerFromParams({ at: 'noon' }, NOW)).toEqual({ error: 'invalid at time (expected HH:MM): "noon"' });
  });
});
