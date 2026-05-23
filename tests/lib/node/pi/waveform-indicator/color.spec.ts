/**
 * Tests for lib/node/pi/waveform-indicator/color.ts.
 */

import { describe, expect, test } from 'vitest';

import { colorize, hslToRgb } from '../../../../../lib/node/pi/waveform-indicator/color.ts';

describe('hslToRgb', () => {
  test('hue 0 with full sat+light = 50% is pure red', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual({ r: 255, g: 0, b: 0 });
  });

  test('hue 120 is pure green at l=0.5', () => {
    expect(hslToRgb(120, 1, 0.5)).toEqual({ r: 0, g: 255, b: 0 });
  });

  test('hue 240 is pure blue at l=0.5', () => {
    expect(hslToRgb(240, 1, 0.5)).toEqual({ r: 0, g: 0, b: 255 });
  });

  test('zero saturation gives gray independent of hue', () => {
    const a = hslToRgb(0, 0, 0.5);
    const b = hslToRgb(180, 0, 0.5);

    expect(a).toEqual({ r: 128, g: 128, b: 128 });
    expect(b).toEqual(a);
  });

  test('negative and >360 hues wrap', () => {
    expect(hslToRgb(-360, 1, 0.5)).toEqual(hslToRgb(0, 1, 0.5));
    expect(hslToRgb(720, 1, 0.5)).toEqual(hslToRgb(0, 1, 0.5));
  });

  test('saturation and lightness clamp to [0, 1]', () => {
    expect(hslToRgb(0, 5, 0.5)).toEqual(hslToRgb(0, 1, 0.5));
    expect(hslToRgb(0, -1, 0.5)).toEqual(hslToRgb(0, 0, 0.5));
    expect(hslToRgb(0, 1, 5)).toEqual({ r: 255, g: 255, b: 255 });
    expect(hslToRgb(0, 1, -1)).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('colorize', () => {
  test('wraps text in truecolor SGR open + reset', () => {
    expect(colorize('x', { r: 10, g: 20, b: 30 })).toBe('\x1b[38;2;10;20;30mx\x1b[39m');
  });
});
