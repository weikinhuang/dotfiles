/**
 * Tests for lib/node/pi/scheduled-prompts/schedule.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  computeNextFire,
  describeTrigger,
  makeScheduleId,
  recordRun,
  reconcileSchedule,
  type Schedule,
  type Trigger,
} from '../../../../../lib/node/pi/scheduled-prompts/schedule.ts';

const CREATED = new Date(2026, 0, 1, 0, 0, 0).getTime();

function makeSchedule(trigger: Trigger, over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sp-test',
    prompt: 'do the thing',
    trigger,
    scope: 'session',
    enabled: true,
    createdAt: CREATED,
    runCount: 0,
    ...over,
  };
}

// Deterministic RNG that always returns the same fraction.
function fixedRng(value: number): () => number {
  return () => value;
}

describe('computeNextFire', () => {
  test('cron returns the next matching minute', () => {
    const s = makeSchedule({ kind: 'cron', expr: '0 9 * * *' });
    const after = new Date(2026, 0, 1, 8, 0, 0);
    expect(computeNextFire(s, after)).toBe(new Date(2026, 0, 1, 9, 0, 0).getTime());
  });

  test('interval is anchored on createdAt for a stable phase', () => {
    const s = makeSchedule({ kind: 'interval', ms: 30 * 60_000 });
    // 70 minutes after creation -> next 30m multiple is at +90m.
    const after = new Date(CREATED + 70 * 60_000);
    expect(computeNextFire(s, after)).toBe(CREATED + 90 * 60_000);
  });

  test('interval first fire is one interval after creation', () => {
    const s = makeSchedule({ kind: 'interval', ms: 30 * 60_000 });
    expect(computeNextFire(s, new Date(CREATED))).toBe(CREATED + 30 * 60_000);
  });

  test('once returns the absolute instant, then null after it ran', () => {
    const at = CREATED + 10 * 60_000;
    const s = makeSchedule({ kind: 'once', at });
    expect(computeNextFire(s, new Date(CREATED))).toBe(at);
    expect(computeNextFire({ ...s, runCount: 1 }, new Date(CREATED))).toBeNull();
  });

  test('jitter shifts forward by a bounded random amount', () => {
    const s = makeSchedule({ kind: 'cron', expr: '0 9 * * *' }, { jitterMs: 60_000 });
    const after = new Date(2026, 0, 1, 8, 0, 0);
    const base = new Date(2026, 0, 1, 9, 0, 0).getTime();
    expect(computeNextFire(s, after, fixedRng(0))).toBe(base);
    expect(computeNextFire(s, after, fixedRng(0.5))).toBe(base + 30_000);
  });

  test('invalid cron expression yields null', () => {
    const s = makeSchedule({ kind: 'cron', expr: 'not a cron' });
    expect(computeNextFire(s, new Date(CREATED))).toBeNull();
  });
});

describe('reconcileSchedule', () => {
  test('clears nextFireAt when disabled', () => {
    const s = makeSchedule({ kind: 'cron', expr: '0 9 * * *' }, { enabled: false, nextFireAt: 123 });
    expect(reconcileSchedule(s, CREATED).nextFireAt).toBeUndefined();
  });

  test('keeps a future cached recurring target untouched', () => {
    const future = CREATED + 10_000;
    const s = makeSchedule({ kind: 'interval', ms: 30 * 60_000 }, { nextFireAt: future });
    expect(reconcileSchedule(s, CREATED).nextFireAt).toBe(future);
  });

  test('recomputes a recurring target that fell into the past (skips the missed fire)', () => {
    const s = makeSchedule({ kind: 'interval', ms: 30 * 60_000 }, { nextFireAt: CREATED - 1 });
    const now = CREATED + 70 * 60_000;
    expect(reconcileSchedule(s, now).nextFireAt).toBe(CREATED + 90 * 60_000);
  });

  test('keeps an overdue once target so it fires immediately', () => {
    const at = CREATED + 10_000;
    const s = makeSchedule({ kind: 'once', at }, { nextFireAt: at });
    const now = CREATED + 60_000; // past the target
    expect(reconcileSchedule(s, now).nextFireAt).toBe(at);
  });
});

describe('recordRun', () => {
  test('bumps runCount/lastRunAt and advances a recurring target', () => {
    const s = makeSchedule({ kind: 'interval', ms: 30 * 60_000 });
    const firedAt = CREATED + 30 * 60_000;
    const ran = recordRun(s, firedAt);
    expect(ran.runCount).toBe(1);
    expect(ran.lastRunAt).toBe(firedAt);
    expect(ran.nextFireAt).toBe(CREATED + 60 * 60_000);
  });

  test('clears nextFireAt for a spent once', () => {
    const at = CREATED + 10_000;
    const s = makeSchedule({ kind: 'once', at });
    const ran = recordRun(s, at);
    expect(ran.runCount).toBe(1);
    expect(ran.nextFireAt).toBeUndefined();
  });
});

describe('makeScheduleId', () => {
  test('produces a prefixed id', () => {
    expect(makeScheduleId(fixedRng(0.5))).toMatch(/^sp-[0-9a-z]+$/);
  });
});

describe('describeTrigger', () => {
  test('renders each kind', () => {
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *' })).toBe('cron "0 9 * * *"');
    expect(describeTrigger({ kind: 'interval', ms: 30 * 60_000 })).toBe('every 30m');
    expect(describeTrigger({ kind: 'interval', ms: 2 * 3_600_000 })).toBe('every 2h');
    expect(describeTrigger({ kind: 'once', at: CREATED })).toContain('once at');
  });
});
