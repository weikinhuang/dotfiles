/**
 * Tests for lib/node/pi/scheduled-prompts/schedule.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  AFTER_BACKOFF_MAX_SCALE,
  applyActivity,
  buildSchedule,
  computeNextFire,
  describeTrigger,
  FIRE_SLOP_MS,
  isDue,
  makeScheduleId,
  pickPrompt,
  recordRun,
  reconcileSchedule,
  type Schedule,
  type Trigger,
  wantsIdle,
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

  test('impossible-but-parseable cron (no match in horizon) yields null, does not throw', () => {
    // Regression: `0 0 30 2 *` (Feb 30) parses fine but has no matching
    // instant, so cronNext throws. computeNextFire must catch and disarm.
    const s = makeSchedule({ kind: 'cron', expr: '0 0 30 2 *' });
    expect(() => computeNextFire(s, new Date(CREATED))).not.toThrow();
    expect(computeNextFire(s, new Date(CREATED))).toBeNull();
  });

  test('after fires a random delay within the window past the anchor', () => {
    const s = makeSchedule({ kind: 'after', minMs: 30_000, maxMs: 300_000 });
    const anchor = new Date(CREATED);
    expect(computeNextFire(s, anchor, fixedRng(0))).toBe(CREATED + 30_000);
    // rng ~1 lands at the top of the [min, max] window.
    expect(computeNextFire(s, anchor, fixedRng(0.999999))).toBe(CREATED + 300_000);
  });

  test('after backs off by doubling the window per unanswered run, capped', () => {
    const base = makeSchedule({ kind: 'after', minMs: 30_000, maxMs: 60_000 });
    // 2 unanswered -> 4x window; min bound = 30s * 4 = 120s.
    expect(computeNextFire({ ...base, unansweredRuns: 2 }, new Date(CREATED), fixedRng(0))).toBe(CREATED + 120_000);
    // Beyond the cap, the scale saturates at AFTER_BACKOFF_MAX_SCALE.
    const capped = computeNextFire({ ...base, unansweredRuns: 99 }, new Date(CREATED), fixedRng(0));
    expect(capped).toBe(CREATED + 30_000 * AFTER_BACKOFF_MAX_SCALE);
  });

  test('maxRuns retires a schedule once the cap is reached', () => {
    const s = makeSchedule({ kind: 'interval', ms: 30 * 60_000 }, { maxRuns: 3, runCount: 3 });
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

  test('after bumps unansweredRuns so the next gap backs off', () => {
    const s = makeSchedule({ kind: 'after', minMs: 30_000, maxMs: 60_000 });
    const ran = recordRun(s, CREATED, fixedRng(0));
    expect(ran.unansweredRuns).toBe(1);
    // Next gap now uses the 2x window: min bound 60s.
    expect(ran.nextFireAt).toBe(CREATED + 60_000);
  });

  test('retires (no next fire) once maxRuns is hit', () => {
    const s = makeSchedule({ kind: 'interval', ms: 30 * 60_000 }, { maxRuns: 1 });
    const ran = recordRun(s, CREATED + 30 * 60_000);
    expect(ran.runCount).toBe(1);
    expect(ran.nextFireAt).toBeUndefined();
  });
});

describe('applyActivity', () => {
  test('resets an after timer and clears backoff on interactive input', () => {
    const s = makeSchedule({ kind: 'after', minMs: 30_000, maxMs: 60_000 }, { unansweredRuns: 3, nextFireAt: CREATED });
    const at = CREATED + 1_000_000;
    const out = applyActivity(s, at, fixedRng(0), { resetBackoff: true });
    expect(out.unansweredRuns).toBe(0);
    expect(out.nextFireAt).toBe(at + 30_000);
  });

  test('re-anchors without clearing backoff on a turn ending', () => {
    const s = makeSchedule({ kind: 'after', minMs: 30_000, maxMs: 60_000 }, { unansweredRuns: 2, nextFireAt: CREATED });
    const at = CREATED + 1_000_000;
    const out = applyActivity(s, at, fixedRng(0), { resetBackoff: false });
    expect(out.unansweredRuns).toBe(2);
    // Backoff preserved: 4x window, min bound 120s past the anchor.
    expect(out.nextFireAt).toBe(at + 120_000);
  });

  test('leaves a disabled schedule untouched', () => {
    const s = makeSchedule({ kind: 'after', minMs: 30_000, maxMs: 60_000 }, { enabled: false });
    expect(applyActivity(s, CREATED + 5_000, fixedRng(0))).toBe(s);
  });
});

describe('pickPrompt', () => {
  test('returns the sole prompt for a single-prompt schedule', () => {
    const s = makeSchedule({ kind: 'interval', ms: 1000 });
    expect(pickPrompt(s, fixedRng(0)).text).toBe('do the thing');
  });

  test('random pick indexes the pool by rng and leaves the cursor', () => {
    const s = makeSchedule({ kind: 'interval', ms: 1000 }, { prompts: ['a', 'b', 'c'], promptCursor: 0 });
    expect(pickPrompt(s, fixedRng(0)).text).toBe('a');
    expect(pickPrompt(s, fixedRng(0.5)).text).toBe('b');
    expect(pickPrompt(s, fixedRng(0.99)).text).toBe('c');
    expect(pickPrompt(s, fixedRng(0.5)).cursor).toBe(0);
  });

  test('round-robin advances the cursor and wraps', () => {
    const s = makeSchedule(
      { kind: 'interval', ms: 1000 },
      { prompts: ['a', 'b'], promptPick: 'roundRobin', promptCursor: 1 },
    );
    const first = pickPrompt(s);
    expect(first.text).toBe('b');
    expect(first.cursor).toBe(0);
    const second = pickPrompt({ ...s, promptCursor: first.cursor });
    expect(second.text).toBe('a');
    expect(second.cursor).toBe(1);
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
    expect(describeTrigger({ kind: 'after', minMs: 30_000, maxMs: 300_000 })).toBe('after 30s-5m idle');
  });
});

describe('buildSchedule', () => {
  test('shapes an enabled schedule and computes the first fire', () => {
    const s = buildSchedule(
      { id: 'sp-b', prompt: 'ping', trigger: { kind: 'interval', ms: 30 * 60_000 }, scope: 'global' },
      CREATED,
    );
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBe(CREATED);
    expect(s.runCount).toBe(0);
    expect(s.nextFireAt).toBe(CREATED + 30 * 60_000);
    // Non-`after` triggers don't default the idle knobs on.
    expect(s.resetOnActivity).toBeUndefined();
    expect(s.whenIdle).toBeUndefined();
  });

  test('an after trigger defaults resetOnActivity/whenIdle on', () => {
    const s = buildSchedule(
      {
        id: 'sp-a',
        prompt: 'still there?',
        trigger: { kind: 'after', minMs: 30_000, maxMs: 60_000 },
        scope: 'session',
      },
      CREATED,
      fixedRng(0),
    );
    expect(s.resetOnActivity).toBe(true);
    expect(s.whenIdle).toBe(true);
  });

  test('explicit idle knobs override the after defaults', () => {
    const s = buildSchedule(
      {
        id: 'sp-a2',
        prompt: 'x',
        trigger: { kind: 'after', minMs: 30_000, maxMs: 60_000 },
        scope: 'session',
        resetOnActivity: false,
        whenIdle: false,
      },
      CREATED,
      fixedRng(0),
    );
    expect(s.resetOnActivity).toBe(false);
    expect(s.whenIdle).toBe(false);
  });
});

describe('wantsIdle', () => {
  test('after defaults to idle-only; others do not', () => {
    expect(wantsIdle(makeSchedule({ kind: 'after', minMs: 1, maxMs: 2 }))).toBe(true);
    expect(wantsIdle(makeSchedule({ kind: 'interval', ms: 1000 }))).toBe(false);
  });

  test('an explicit whenIdle wins over the kind default', () => {
    expect(wantsIdle(makeSchedule({ kind: 'after', minMs: 1, maxMs: 2 }, { whenIdle: false }))).toBe(false);
    expect(wantsIdle(makeSchedule({ kind: 'interval', ms: 1000 }, { whenIdle: true }))).toBe(true);
  });
});

describe('isDue', () => {
  const s = makeSchedule({ kind: 'interval', ms: 1000 }, { nextFireAt: CREATED });

  test('due at or within the slop window of the cached target', () => {
    expect(isDue(s, CREATED)).toBe(true);
    expect(isDue(s, CREATED - FIRE_SLOP_MS)).toBe(true);
    expect(isDue(s, CREATED - FIRE_SLOP_MS - 1)).toBe(false);
  });

  test('never due when disabled or unarmed', () => {
    expect(isDue(makeSchedule({ kind: 'interval', ms: 1000 }, { nextFireAt: CREATED, enabled: false }), CREATED)).toBe(
      false,
    );
    expect(isDue(makeSchedule({ kind: 'interval', ms: 1000 }), CREATED)).toBe(false);
  });
});
