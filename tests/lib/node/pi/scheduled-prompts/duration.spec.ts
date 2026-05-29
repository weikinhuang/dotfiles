/**
 * Tests for lib/node/pi/scheduled-prompts/duration.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  formatDuration,
  parseDuration,
  parseDurationRange,
} from '../../../../../lib/node/pi/scheduled-prompts/duration.ts';

describe('parseDuration', () => {
  test('parses single-unit durations', () => {
    expect(parseDuration('10s')).toBe(10_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  test('accumulates combined segments', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
    expect(parseDuration('1d2h')).toBe(86_400_000 + 2 * 3_600_000);
  });

  test('is case-insensitive and trims', () => {
    expect(parseDuration('  2H ')).toBe(2 * 3_600_000);
  });

  test('rejects bare numbers and unknown units', () => {
    expect(parseDuration('5')).toBeNull();
    expect(parseDuration('5w')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
  });

  test('rejects zero', () => {
    expect(parseDuration('0s')).toBeNull();
  });
});

describe('parseDurationRange', () => {
  test('parses a min-max window', () => {
    expect(parseDurationRange('30s-5m')).toEqual({ minMs: 30_000, maxMs: 300_000 });
  });

  test('treats a single duration as an equal-bounds range', () => {
    expect(parseDurationRange('2m')).toEqual({ minMs: 120_000, maxMs: 120_000 });
  });

  test('rejects an inverted range and unparseable sides', () => {
    expect(parseDurationRange('5m-30s')).toBeNull();
    expect(parseDurationRange('5m-')).toBeNull();
    expect(parseDurationRange('-5m')).toBeNull();
    expect(parseDurationRange('5x-10m')).toBeNull();
    expect(parseDurationRange('')).toBeNull();
  });
});

describe('formatDuration', () => {
  test('renders compact components, dropping zeros', () => {
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(90 * 60_000)).toBe('1h30m');
    expect(formatDuration(86_400_000 + 2 * 3_600_000)).toBe('1d2h');
  });

  test('clamps non-positive to 0s', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(500)).toBe('0s');
  });
});
