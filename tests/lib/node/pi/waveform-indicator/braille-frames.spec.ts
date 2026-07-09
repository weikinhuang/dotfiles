/**
 * Tests for lib/node/pi/waveform-indicator/braille-frames.ts.
 *
 * The shared frame-loop extracted from wave.ts / spectrum.ts. Pure - no pi
 * runtime. Byte-for-byte compatibility with the two callers is covered by
 * their own specs; this spec pins the loop's structure and callback wiring.
 */

import { describe, expect, test } from 'vitest';

import { buildBrailleAnimationFrames } from '../../../../../lib/node/pi/waveform-indicator/braille-frames.ts';
import { encodeBrailleColumns } from '../../../../../lib/node/pi/waveform-indicator/braille.ts';
import { colorize } from '../../../../../lib/node/pi/waveform-indicator/color.ts';

describe('buildBrailleAnimationFrames', () => {
  test('renders totalFrames frames of glyphWidth colorized glyphs', () => {
    const frames = buildBrailleAnimationFrames(
      { glyphWidth: 3, totalFrames: 4 },
      (k, t) => ({ left: (k + t) % 5, right: k % 5 }),
      () => ({ r: 10, g: 20, b: 30 }),
    );
    expect(frames).toHaveLength(4);
    // Each frame concatenates exactly glyphWidth colorized glyphs.
    for (let t = 0; t < 4; t++) {
      let expected = '';
      for (let k = 0; k < 3; k++) {
        expected += colorize(encodeBrailleColumns((k + t) % 5, k % 5), { r: 10, g: 20, b: 30 });
      }
      expect(frames[t]).toBe(expected);
    }
  });

  test('threads (k, t, left, right) into the color callback', () => {
    const seen: [number, number, number, number][] = [];
    buildBrailleAnimationFrames(
      { glyphWidth: 2, totalFrames: 1 },
      (k) => ({ left: k, right: k + 1 }),
      (k, t, left, right) => {
        seen.push([k, t, left, right]);
        return { r: 0, g: 0, b: 0 };
      },
    );
    expect(seen).toEqual([
      [0, 0, 0, 1],
      [1, 0, 1, 2],
    ]);
  });

  test('a zero-frame or zero-width request yields an empty / blank result', () => {
    expect(
      buildBrailleAnimationFrames(
        { glyphWidth: 3, totalFrames: 0 },
        () => ({ left: 0, right: 0 }),
        () => ({ r: 0, g: 0, b: 0 }),
      ),
    ).toEqual([]);
    expect(
      buildBrailleAnimationFrames(
        { glyphWidth: 0, totalFrames: 2 },
        () => ({ left: 0, right: 0 }),
        () => ({ r: 0, g: 0, b: 0 }),
      ),
    ).toEqual(['', '']);
  });
});
