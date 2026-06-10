/**
 * Tests for config/pi/avatar/tools/slice-sheets.ts pure helpers.
 *
 * The magick-driven parts (chromaMask, detectBackgroundColor, writeCell) need
 * ImageMagick + real images, so only the pure color helpers are unit-tested
 * here. main() is import-guarded, so importing the module does not run the CLI.
 */

import { describe, expect, test } from 'vitest';

import { parsePixel, pickBackgroundColor } from '../../../../../config/pi/avatar/tools/slice-sheets.ts';

describe('parsePixel', () => {
  test('parses srgb() and srgba()', () => {
    expect(parsePixel('srgb(143,174,143)')).toEqual([143, 174, 143]);
    expect(parsePixel('srgba(0,255,0,1)')).toEqual([0, 255, 0]);
    expect(parsePixel('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
  });

  test('parses #rrggbb and #rgb hex', () => {
    expect(parsePixel('#00ff00')).toEqual([0, 255, 0]);
    expect(parsePixel('#0f0')).toEqual([0, 255, 0]);
    expect(parsePixel('  #8FAE8F  ')).toEqual([143, 174, 143]);
  });

  test('clamps out-of-range channel values', () => {
    expect(parsePixel('srgb(300,400,128)')).toEqual([255, 255, 128]);
  });

  test('returns undefined for unrecognized strings', () => {
    expect(parsePixel('not a color')).toBeUndefined();
    expect(parsePixel('')).toBeUndefined();
  });
});

describe('pickBackgroundColor', () => {
  test('returns the dominant flat background as srgb()', () => {
    const samples = ['srgb(142,173,142)', 'srgb(143,174,143)', 'srgb(144,175,144)', 'srgb(143,174,143)'];
    expect(pickBackgroundColor(samples, '#00FF00')).toBe('srgb(143,174,143)');
  });

  test('a minority of art-clipping samples do not move the detected background', () => {
    // Nine background samples (spring-green) + two character outliers: the
    // background bucket dominates, so detection still keys the real green
    // rather than falling back.
    const samples = [
      'srgb(0,255,131)',
      'srgb(0,255,130)',
      'srgb(1,255,132)',
      'srgb(0,254,131)',
      'srgb(0,255,129)',
      'srgb(2,255,131)',
      'srgb(0,255,131)',
      'srgb(1,255,130)',
      'srgb(0,255,132)',
      'srgb(200,30,40)',
      'srgb(245,245,245)',
    ];
    expect(pickBackgroundColor(samples, '#00FF00')).toBe('srgb(0,255,131)');
  });

  test('falls back when fewer than three samples parse', () => {
    expect(pickBackgroundColor(['garbage', 'srgb(0,255,0)'], '#00FF00')).toBe('#00FF00');
  });

  test('falls back when no color clusters into a majority (not a flat-bg sheet)', () => {
    const samples = ['srgb(10,20,30)', 'srgb(90,90,90)', 'srgb(200,40,40)', 'srgb(0,120,255)'];
    expect(pickBackgroundColor(samples, '#00FF00')).toBe('#00FF00');
  });
});
