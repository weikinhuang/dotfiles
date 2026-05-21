/**
 * Tests for lib/node/pi/waveform-indicator-rate.ts.
 *
 * Pure state-machine tests - no fake timers, no fake pi events, just
 * direct calls into the sample-step rules.
 */

import { describe, expect, test } from 'vitest';

import {
  MIN_SAMPLE_DT_MS,
  markMessageEnd,
  markMessageStart,
  newTokenRateState,
  stepTokenRate,
} from '../../../../lib/node/pi/waveform-indicator-rate.ts';

describe('newTokenRateState', () => {
  test('returns a clean state with no baseline and no pending skip', () => {
    const s = newTokenRateState();

    expect(s.lastSampleAtMs).toBeUndefined();
    expect(s.lastSampleTokens).toBeUndefined();
    expect(s.skipNextSample).toBe(false);
  });
});

describe('stepTokenRate - first sample (cold start)', () => {
  test('emits nothing and captures the baseline', () => {
    const s = newTokenRateState();

    const r = stepTokenRate(s, 100, 1_000);

    expect(r.rate).toBeUndefined();
    expect(r.rebaselined).toBe(false);
    expect(s.lastSampleAtMs).toBe(1_000);
    expect(s.lastSampleTokens).toBe(100);
  });
});

describe('stepTokenRate - normal sample', () => {
  test('computes tokens/sec from delta and dt', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 100, 1_000);
    // 60 tokens over 1 second → 60 tokens/sec.
    const r = stepTokenRate(s, 160, 2_000);

    expect(r.rate).toBeCloseTo(60, 10);
    expect(r.rebaselined).toBe(false);
    expect(s.lastSampleAtMs).toBe(2_000);
    expect(s.lastSampleTokens).toBe(160);
  });

  test('handles sub-second dt as a proportional rate', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 100, 1_000);
    // 4 tokens over 80 ms → 50 tokens/sec.
    const r = stepTokenRate(s, 104, 1_080);

    expect(r.rate).toBeCloseTo(50, 10);
  });

  test('emits 0 when delta is 0 (idle but ticking)', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 100, 1_000);
    const r = stepTokenRate(s, 100, 1_080);

    expect(r.rate).toBe(0);
    expect(r.rebaselined).toBe(false);
  });
});

describe('stepTokenRate - sub-ms dt skip', () => {
  test('skips emission and does NOT update the baseline', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 100, 1_000);
    // Two ticks land in the same millisecond - dt = 0.
    const r = stepTokenRate(s, 160, 1_000);

    expect(r.rate).toBeUndefined();
    expect(r.rebaselined).toBe(false);
    // Baseline is unchanged so the next non-degenerate dt computes correctly.
    expect(s.lastSampleAtMs).toBe(1_000);
    expect(s.lastSampleTokens).toBe(100);
  });

  test('a follow-up tick with a real dt computes against the preserved baseline', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 100, 1_000);
    stepTokenRate(s, 160, 1_000); // skipped
    // 100 tokens over 1 second from the preserved baseline.
    const r = stepTokenRate(s, 200, 2_000);

    expect(r.rate).toBeCloseTo(100, 10);
  });

  test(`MIN_SAMPLE_DT_MS is ${MIN_SAMPLE_DT_MS}`, () => {
    expect(MIN_SAMPLE_DT_MS).toBe(1);
  });
});

describe('stepTokenRate - negative-delta re-baseline', () => {
  test('emits rate=0 and resets the baseline when tokens shrink', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 1_000, 1_000);
    // committedUsage shrank (compaction) or the byte estimate reset
    // post-message_end - currentTokens is now lower than the baseline.
    const r = stepTokenRate(s, 800, 2_000);

    expect(r.rate).toBe(0);
    expect(r.rebaselined).toBe(true);
    expect(s.lastSampleAtMs).toBe(2_000);
    expect(s.lastSampleTokens).toBe(800);
  });

  test('after a re-baseline, the next non-shrunk delta is computed off the new floor', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 1_000, 1_000);
    stepTokenRate(s, 800, 2_000); // re-baselined to 800@2000
    // 50 tokens over 1s from the new baseline.
    const r = stepTokenRate(s, 850, 3_000);

    expect(r.rate).toBeCloseTo(50, 10);
  });

  test('negative-delta path consumes a pending skipNextSample', () => {
    const s = newTokenRateState();
    markMessageStart(s, 1_000, 1_000);
    // currentTokens drops between message_start and the first tick (e.g. a
    // compaction landed in that window). Re-baseline wins and the pending
    // skip is cleared so we don't double-skip on the next tick.
    const r = stepTokenRate(s, 500, 1_080);

    expect(r.rate).toBe(0);
    expect(r.rebaselined).toBe(true);
    expect(s.skipNextSample).toBe(false);
  });
});

describe('stepTokenRate - first-sample-after-message_start skip', () => {
  test('markMessageStart primes a skip on the next tick', () => {
    const s = newTokenRateState();
    markMessageStart(s, 1_000, 500);

    expect(s.skipNextSample).toBe(true);
    expect(s.lastSampleAtMs).toBe(1_000);
    expect(s.lastSampleTokens).toBe(500);
  });

  test('the first tick after message_start is silenced but updates the baseline', () => {
    const s = newTokenRateState();
    markMessageStart(s, 1_000, 500);
    // 50 tokens flowed in the 80 ms since message_start - we don't want
    // to push that "instant spike" because dt is artificially small.
    const r = stepTokenRate(s, 550, 1_080);

    expect(r.rate).toBeUndefined();
    expect(s.skipNextSample).toBe(false);
    expect(s.lastSampleAtMs).toBe(1_080);
    expect(s.lastSampleTokens).toBe(550);
  });

  test('the second tick after message_start emits a normal rate', () => {
    const s = newTokenRateState();
    markMessageStart(s, 1_000, 500);
    stepTokenRate(s, 550, 1_080); // skipped, baseline → (550, 1080)
    // 40 tokens over 80 ms → 500 tokens/sec.
    const r = stepTokenRate(s, 590, 1_160);

    expect(r.rate).toBeCloseTo(500, 6);
  });
});

describe('stepTokenRate - post-message_end reset', () => {
  test('markMessageEnd clears the baseline', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 1_000, 1_000);
    stepTokenRate(s, 1_500, 2_000);
    markMessageEnd(s);

    expect(s.lastSampleAtMs).toBeUndefined();
    expect(s.lastSampleTokens).toBeUndefined();
    expect(s.skipNextSample).toBe(false);
  });

  test('the next tick after message_end re-baselines (emits nothing)', () => {
    const s = newTokenRateState();
    stepTokenRate(s, 1_000, 1_000);
    markMessageEnd(s);
    const r = stepTokenRate(s, 1_000, 3_000);

    expect(r.rate).toBeUndefined();
    expect(s.lastSampleAtMs).toBe(3_000);
    expect(s.lastSampleTokens).toBe(1_000);
  });
});

describe('stepTokenRate - integration: full message lifecycle', () => {
  test('cold start → message_start → ticks → message_end → next message starts clean', () => {
    const s = newTokenRateState();

    // Cold start tick before any message.
    expect(stepTokenRate(s, 0, 1_000).rate).toBeUndefined();

    // Pi fires message_update 'start'.
    markMessageStart(s, 1_200, 0);

    // First tick after message_start is silenced (rate would be a spike).
    expect(stepTokenRate(s, 40, 1_280).rate).toBeUndefined();

    // Subsequent ticks emit rates.
    expect(stepTokenRate(s, 80, 1_360).rate).toBeCloseTo(500, 6);
    expect(stepTokenRate(s, 120, 1_440).rate).toBeCloseTo(500, 6);

    // Pi fires message_end. Byte counter reset is reflected by
    // currentTokens shrinking (final usage.output exceeds estimated bytes
    // / 4 by a small amount, but the buffer reset can still produce a
    // shrink). The negative-delta clause re-baselines and emits 0.
    markMessageEnd(s);
    expect(stepTokenRate(s, 90, 1_520).rate).toBeUndefined(); // cold-start after end

    // Second message starts.
    markMessageStart(s, 2_000, 90);
    expect(stepTokenRate(s, 100, 2_080).rate).toBeUndefined(); // skipped
    expect(stepTokenRate(s, 200, 2_160).rate).toBeCloseTo(1_250, 6);
  });
});
