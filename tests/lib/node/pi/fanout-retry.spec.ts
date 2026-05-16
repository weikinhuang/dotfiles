import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  classifyTransientError,
  computeBackoffMs,
  TRANSIENT_ERROR_PATTERNS,
  withTransientRetry,
} from '../../../../lib/node/pi/fanout-retry.ts';

describe('classifyTransientError', () => {
  test('returns false for non-Error inputs', () => {
    expect(classifyTransientError(undefined)).toBe(false);
    expect(classifyTransientError(null)).toBe(false);
    expect(classifyTransientError(0)).toBe(false);
    expect(classifyTransientError('')).toBe(false);
  });

  test('returns false for a plain message with no transient signal', () => {
    expect(classifyTransientError(new Error('auth failed'))).toBe(false);
    expect(classifyTransientError(new Error('400 Bad Request'))).toBe(false);
    expect(classifyTransientError(new Error('401 Unauthorized'))).toBe(false);
    expect(classifyTransientError(new Error('403 Forbidden'))).toBe(false);
    expect(classifyTransientError(new Error('bad request: model not found'))).toBe(false);
  });

  test('matches the exact "Connection error." message we saw from the SDK', () => {
    // This is the literal string the pi-ai / openai SDK surfaces on
    // a TCP-level failure, and what the observed fanout batch failure
    // recorded in journal.md.
    expect(classifyTransientError(new Error('Connection error.'))).toBe(true);
  });

  test('matches common node-fetch / undici / openai failure patterns', () => {
    const transient = [
      'fetch failed',
      'socket hang up',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND api.openai.com',
      'Request timed out',
      'Request timeout after 30000ms',
      'Network error occurred',
    ];
    for (const m of transient) {
      expect(classifyTransientError(new Error(m)), `should match: ${m}`).toBe(true);
    }
  });

  test('matches HTTP transient statuses (429 / 5xx) as tokens', () => {
    expect(classifyTransientError(new Error('429 Too Many Requests'))).toBe(true);
    expect(classifyTransientError(new Error('rate limited'))).toBe(true);
    expect(classifyTransientError(new Error('500 Internal Server Error'))).toBe(true);
    expect(classifyTransientError(new Error('502 Bad Gateway'))).toBe(true);
    expect(classifyTransientError(new Error('503 Service Unavailable'))).toBe(true);
    expect(classifyTransientError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  test('does NOT match status codes embedded in unrelated tokens', () => {
    // Guard against the regex matching "5xx" in longer digit runs
    // (e.g. a byte count or an id). The patterns anchor on \D|^|$
    // boundaries for exactly this reason.
    expect(classifyTransientError(new Error('response body 12345 bytes'))).toBe(false);
    expect(classifyTransientError(new Error('id=42900'))).toBe(false);
    expect(classifyTransientError(new Error('sha256:55003eac'))).toBe(false);
  });

  test('accepts non-Error throws (string, object)', () => {
    expect(classifyTransientError('Connection error.')).toBe(true);
    expect(classifyTransientError({ toString: () => 'ECONNRESET' })).toBe(true);
    expect(classifyTransientError({ toString: () => 'auth failure' })).toBe(false);
  });

  test('exports a non-empty pattern list for docs + introspection', () => {
    expect(TRANSIENT_ERROR_PATTERNS.length).toBeGreaterThan(10);
    // Regression guard: the literal "connection error" pattern
    // (which is what the observed fanout batch failure produced)
    // MUST stay in the list.
    expect(TRANSIENT_ERROR_PATTERNS.some((re) => re.test('Connection error.'))).toBe(true);
  });
});

describe('computeBackoffMs', () => {
  test('returns initialDelayMs on attempt 1 when random is mid-range', () => {
    const ms = computeBackoffMs(1, { initialDelayMs: 1000, maxDelayMs: 8000, random: () => 0.5 });

    // 1000 + 1000 * (0.5 * 0.5 - 0.25) = 1000 + 0 = 1000
    expect(ms).toBe(1000);
  });

  test('doubles on attempt 2, 4x on attempt 3 (no jitter)', () => {
    const random = (): number => 0.5; // zero jitter

    expect(computeBackoffMs(1, { initialDelayMs: 1000, random })).toBe(1000);
    expect(computeBackoffMs(2, { initialDelayMs: 1000, random })).toBe(2000);
    expect(computeBackoffMs(3, { initialDelayMs: 1000, random })).toBe(4000);
    expect(computeBackoffMs(4, { initialDelayMs: 1000, random })).toBe(8000);
  });

  test('caps at maxDelayMs regardless of attempt', () => {
    const ms = computeBackoffMs(10, { initialDelayMs: 1000, maxDelayMs: 5000, random: () => 0.5 });

    expect(ms).toBe(5000);
  });

  test('jitter keeps result within ±25% of the base', () => {
    const base = 1500;
    const lo = computeBackoffMs(1, { initialDelayMs: base, random: () => 0 }); // -25%
    const hi = computeBackoffMs(1, { initialDelayMs: base, random: () => 0.999 }); // ≈+25%

    expect(lo).toBe(Math.round(base * 0.75));
    expect(hi).toBe(Math.round(base * (1 + (0.999 * 0.5 - 0.25))));
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(Math.round(base * 1.25));
  });

  test('never returns negative', () => {
    // Pathological: random=0 with a tiny initial. Base - 25% still
    // has to clamp at 0.
    const ms = computeBackoffMs(1, { initialDelayMs: 1, random: () => 0 });

    expect(ms).toBeGreaterThanOrEqual(0);
  });
});

describe('withTransientRetry', () => {
  let sleepSpy: ((ms: number) => Promise<void>) & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sleepSpy = vi.fn().mockResolvedValue(undefined) as typeof sleepSpy;
  });

  test('returns on first success without calling sleep', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withTransientRetry(fn, { sleep: sleepSpy });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('retries on a transient error and then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('Connection error.')).mockResolvedValueOnce('recovered');
    const onRetry = vi.fn();
    const result = await withTransientRetry(fn, {
      sleep: sleepSpy,
      onRetry,
      random: () => 0.5,
    });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
  });

  test('rethrows immediately on a non-transient error without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

    await expect(withTransientRetry(fn, { sleep: sleepSpy })).rejects.toThrow(/401/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('exhausts maxAttempts and rethrows the last transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(withTransientRetry(fn, { sleep: sleepSpy, maxAttempts: 3, random: () => 0.5 })).rejects.toThrow(
      /ECONNRESET/,
    );
    expect(fn).toHaveBeenCalledTimes(3);
    // Slept between attempts 1→2 and 2→3, so 2 sleeps for 3 attempts.
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  test('passes the 1-indexed attempt number to fn', async () => {
    const calls: number[] = [];
    const fn = vi.fn().mockImplementation((attempt: number) => {
      calls.push(attempt);
      if (attempt < 3) throw new Error('Connection error.');
      return Promise.resolve('ok');
    });
    const result = await withTransientRetry(fn, { sleep: sleepSpy, random: () => 0.5 });

    expect(result).toBe('ok');
    expect(calls).toEqual([1, 2, 3]);
  });

  test('honors AbortSignal at the start of each iteration', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(() => {
      // Mid-flight: caller aborts. Next iteration should exit.
      controller.abort();
      return Promise.reject(new Error('Connection error.'));
    });

    await expect(
      withTransientRetry(fn, { sleep: sleepSpy, signal: controller.signal, random: () => 0.5 }),
    ).rejects.toThrow(/Connection error/);
    // Called exactly once - the abort short-circuits attempt 2 and
    // surfaces the last transient error rather than a generic abort.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('maxAttempts=1 disables retry entirely', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Connection error.'));

    await expect(withTransientRetry(fn, { sleep: sleepSpy, maxAttempts: 1 })).rejects.toThrow(/Connection error/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});
