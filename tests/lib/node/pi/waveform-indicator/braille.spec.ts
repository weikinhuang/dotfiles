/**
 * Tests for lib/node/pi/waveform-indicator/braille.ts.
 */

import { describe, expect, test } from 'vitest';

import { encodeBrailleColumns } from '../../../../../lib/node/pi/waveform-indicator/braille.ts';

describe('encodeBrailleColumns', () => {
  test('zero+zero is the blank braille pattern', () => {
    expect(encodeBrailleColumns(0, 0)).toBe('\u2800');
  });

  test('max+max is the full block ⣿', () => {
    expect(encodeBrailleColumns(4, 4)).toBe('⣿');
  });

  test('mid+mid (height 3) is ⣶', () => {
    // Left h=3 → 0x46 (dots 7+3+2), right h=3 → 0xB0 (dots 8+6+5).
    // Sum 0xF6 → U+28F6 = ⣶.
    expect(encodeBrailleColumns(3, 3)).toBe('⣶');
  });

  test('mid+mid (height 2) is ⣤', () => {
    // Left h=2 → 0x44, right h=2 → 0xA0. Sum 0xE4 → U+28E4 = ⣤.
    expect(encodeBrailleColumns(2, 2)).toBe('⣤');
  });

  test('left-only height 4 is ⡇', () => {
    // 0x47 = dots 1+2+3+7.
    expect(encodeBrailleColumns(4, 0)).toBe('⡇');
  });

  test('right-only height 4 is ⢸', () => {
    // 0xB8 = dots 4+5+6+8.
    expect(encodeBrailleColumns(0, 4)).toBe('⢸');
  });

  test('rounds fractional heights to nearest integer', () => {
    expect(encodeBrailleColumns(2.4, 2.6)).toBe(encodeBrailleColumns(2, 3));
  });

  test('clamps out-of-range heights instead of throwing', () => {
    expect(encodeBrailleColumns(-1, 99)).toBe(encodeBrailleColumns(0, 4));
  });

  test('NaN heights collapse to zero', () => {
    expect(encodeBrailleColumns(Number.NaN, Number.NaN)).toBe('\u2800');
  });
});
