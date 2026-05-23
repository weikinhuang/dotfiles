/**
 * Tests for lib/node/pi/btw/footer.ts.
 */

import { describe, expect, test } from 'vitest';

import { formatDuration, formatFooter, formatTokens } from '../../../../../lib/node/pi/btw/footer.ts';

describe('formatTokens', () => {
  test('sub-1000 renders as integer', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  test('1000–9999 uses one decimal k', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(9999)).toBe('10.0k');
  });

  test('10000–999999 uses integer k', () => {
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(45_678)).toBe('46k');
    expect(formatTokens(999_000)).toBe('999k');
  });

  test('≥1M uses two decimals M', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M');
    expect(formatTokens(1_234_567)).toBe('1.23M');
    expect(formatTokens(12_500_000)).toBe('12.50M');
  });

  test('non-finite or negative clamps to 0', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(-1)).toBe('0');
  });
});

describe('formatDuration', () => {
  test('sub-second uses ms', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  test('1–10 seconds uses one decimal', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(9999)).toBe('10.0s');
  });

  test('≥10 seconds rounds to integer seconds', () => {
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(34_500)).toBe('35s');
  });

  test('non-finite or negative clamps to 0ms', () => {
    expect(formatDuration(Number.NaN)).toBe('0ms');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
    expect(formatDuration(-1)).toBe('0ms');
  });
});

describe('formatFooter', () => {
  test('renders all fields when provided', () => {
    const out = formatFooter({
      model: 'claude-opus-4-7',
      totalTokens: 12_345,
      cacheReadTokens: 10_000,
      outputTokens: 180,
      costUsd: 0.00234,
      durationMs: 1200,
    });

    expect(out).toBe('[model: claude-opus-4-7 · 12k tokens · 10k cached · 180 out · $0.0023 · 1.2s · ephemeral]');
  });

  test('omits missing fields', () => {
    const out = formatFooter({ model: 'qwen3-6-35b-a3b' });

    expect(out).toBe('[model: qwen3-6-35b-a3b · ephemeral]');
  });

  test('omits zero cache read (only worth surfacing when caching engaged)', () => {
    const out = formatFooter({
      model: 'foo',
      totalTokens: 1000,
      cacheReadTokens: 0,
      outputTokens: 100,
    });

    expect(out).not.toContain('cached');
    expect(out).toContain('1.0k tokens');
    expect(out).toContain('100 out');
  });

  test('omits zero cost but keeps zero duration (long/short is interesting even at 0)', () => {
    const out = formatFooter({ model: 'foo', costUsd: 0, durationMs: 0 });

    expect(out).not.toContain('$');
    expect(out).toContain('0ms');
  });

  test('always labels the call as ephemeral so the user remembers it was not saved', () => {
    expect(formatFooter({ model: 'x' })).toContain('ephemeral');
  });
});
