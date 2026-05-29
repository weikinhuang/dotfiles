/**
 * Tests for lib/node/pi/scheduled-prompts/cron.ts.
 *
 * All `cronNext` assertions use local-time `Date` constructors so they
 * are timezone-independent: both the input and the expected output are
 * built the same way.
 */

import { describe, expect, test } from 'vitest';

import { cronNext, parseCron } from '../../../../../lib/node/pi/scheduled-prompts/cron.ts';

describe('parseCron', () => {
  test('parses wildcards', () => {
    const f = parseCron('* * * * *');
    expect(f).not.toBeNull();
    expect(f?.minute).toHaveLength(60);
    expect(f?.hour).toHaveLength(24);
    expect(f?.domRestricted).toBe(false);
    expect(f?.dowRestricted).toBe(false);
  });

  test('parses single values', () => {
    const f = parseCron('0 9 * * *');
    expect(f?.minute).toEqual([0]);
    expect(f?.hour).toEqual([9]);
    expect(f?.domRestricted).toBe(false);
  });

  test('parses step, range, and list', () => {
    expect(parseCron('*/15 * * * *')?.minute).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 9-11 * * *')?.hour).toEqual([9, 10, 11]);
    expect(parseCron('0 9,17 * * *')?.hour).toEqual([9, 17]);
    expect(parseCron('0 0-10/5 * * *')?.hour).toEqual([0, 5, 10]);
    expect(parseCron('0 5/6 * * *')?.hour).toEqual([5, 11, 17, 23]);
  });

  test('normalizes day-of-week 7 to 0 (Sunday)', () => {
    expect(parseCron('0 0 * * 7')?.dayOfWeek).toEqual([0]);
    expect(parseCron('0 0 * * 0,7')?.dayOfWeek).toEqual([0]);
  });

  test('rejects malformed expressions', () => {
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('* * * * * *')).toBeNull();
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('* 24 * * *')).toBeNull();
    expect(parseCron('* * 0 * *')).toBeNull();
    expect(parseCron('* * * 13 *')).toBeNull();
    expect(parseCron('* * * * 8')).toBeNull();
    expect(parseCron('mon * * * *')).toBeNull();
    expect(parseCron('5-2 * * * *')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull();
  });
});

describe('cronNext', () => {
  test('finds the next daily 9am', () => {
    const f = parseCron('0 9 * * *')!;
    const after = new Date(2026, 0, 1, 8, 0, 0); // Jan 1 2026 08:00 local
    expect(cronNext(f, after)).toEqual(new Date(2026, 0, 1, 9, 0, 0));
  });

  test('rolls to the next day when the time has passed', () => {
    const f = parseCron('0 9 * * *')!;
    const after = new Date(2026, 0, 1, 10, 0, 0);
    expect(cronNext(f, after)).toEqual(new Date(2026, 0, 2, 9, 0, 0));
  });

  test('is strictly after the input minute', () => {
    const f = parseCron('0 9 * * *')!;
    const after = new Date(2026, 0, 1, 9, 0, 0);
    expect(cronNext(f, after)).toEqual(new Date(2026, 0, 2, 9, 0, 0));
  });

  test('handles every-15-minutes', () => {
    const f = parseCron('*/15 * * * *')!;
    const after = new Date(2026, 0, 1, 9, 7, 0);
    expect(cronNext(f, after)).toEqual(new Date(2026, 0, 1, 9, 15, 0));
  });

  test('matches a specific weekday', () => {
    // Jan 1 2026 is a Thursday (getDay() === 4). Next Monday is Jan 5.
    const f = parseCron('30 8 * * 1')!;
    const after = new Date(2026, 0, 1, 12, 0, 0);
    const next = cronNext(f, after);
    expect(next.getDay()).toBe(1);
    expect(next).toEqual(new Date(2026, 0, 5, 8, 30, 0));
  });

  test('OR semantics when both dom and dow are restricted', () => {
    // Fire on the 1st of the month OR on Mondays.
    const f = parseCron('0 0 1 * 1')!;
    const after = new Date(2026, 0, 1, 12, 0, 0); // Thu Jan 1
    // Next match is Monday Jan 5 (dow), not Feb 1 (dom), since OR.
    expect(cronNext(f, after)).toEqual(new Date(2026, 0, 5, 0, 0, 0));
  });
});
