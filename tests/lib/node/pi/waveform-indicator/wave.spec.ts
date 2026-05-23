/**
 * Tests for lib/node/pi/waveform-indicator/wave.ts.
 */

/* oxlint-disable no-control-regex -- this whole file inspects ANSI SGR escapes */

import { describe, expect, test } from 'vitest';

import {
  buildIndicatorFrames,
  WAVE_SHAPE_PERIOD,
  waveShape,
} from '../../../../../lib/node/pi/waveform-indicator/wave.ts';

const SGR_RE = /\x1b\[[0-9;]*m/g;
const TRUECOLOR_FG_RE = /\x1b\[38;2;\d+;\d+;\d+m/g;
const FG_RESET_RE = /\x1b\[39m/g;

function stripAnsi(s: string): string {
  return s.replace(SGR_RE, '');
}

describe('waveShape', () => {
  test('outputs are clamped to [0, 4] across a full period', () => {
    for (let x = 0; x < WAVE_SHAPE_PERIOD; x += 0.25) {
      const v = waveShape(x);

      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(4);
    }
  });

  test('is periodic with period WAVE_SHAPE_PERIOD', () => {
    for (let x = 0; x < 5; x += 0.5) {
      expect(waveShape(x)).toBeCloseTo(waveShape(x + WAVE_SHAPE_PERIOD), 10);
    }
  });

  test('actually exercises the dynamic range (not a constant)', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let x = 0; x < WAVE_SHAPE_PERIOD; x += 0.25) {
      const v = waveShape(x);
      if (v < min) min = v;
      if (v > max) max = v;
    }

    // Want a wave that visibly bobs across the available height range.
    expect(max - min).toBeGreaterThan(2);
  });
});

describe('buildIndicatorFrames', () => {
  test('produces totalFrames frames at default settings', () => {
    const frames = buildIndicatorFrames();

    expect(frames).toHaveLength(120);
  });

  test('respects custom totalFrames', () => {
    const frames = buildIndicatorFrames({ totalFrames: 30 });

    expect(frames).toHaveLength(30);
  });

  test('every frame contains exactly glyphWidth braille glyphs', () => {
    const frames = buildIndicatorFrames({ glyphWidth: 8, totalFrames: 16 });
    for (const frame of frames) {
      const stripped = stripAnsi(frame);

      // oxlint-disable-next-line typescript/no-misused-spread -- braille code points are intentional; we assert codepoint count, not grapheme clusters
      expect([...stripped]).toHaveLength(8);

      // Every code point must live in the U+2800..U+28FF braille block.
      for (const ch of stripped) {
        const cp = ch.codePointAt(0)!;

        expect(cp).toBeGreaterThanOrEqual(0x2800);
        expect(cp).toBeLessThanOrEqual(0x28ff);
      }
    }
  });

  test('frames carry truecolor SGR escapes (rainbow shimmer)', () => {
    const frames = buildIndicatorFrames({ glyphWidth: 6, totalFrames: 4 });
    for (const frame of frames) {
      // Every glyph wrapped in 38;2;R;G;B + reset.
      expect(frame.match(TRUECOLOR_FG_RE)).toHaveLength(6);
      expect(frame.match(FG_RESET_RE)).toHaveLength(6);
    }
  });

  test('animation actually moves between adjacent frames', () => {
    const frames = buildIndicatorFrames({ glyphWidth: 12, totalFrames: 60 });
    // Two consecutive frames should never be identical, otherwise the
    // wave looks frozen at the user's chosen scrollSpeed default.
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).not.toBe(frames[i - 1]);
    }
  });

  test('loops seamlessly: last frame wraps to first when scrollSpeed*totalFrames is a multiple of WAVE_SHAPE_PERIOD', () => {
    // Default: scrollSpeed=0.5, totalFrames=120 → 60 samples advance = 1 period.
    const frames = buildIndicatorFrames();
    // Strip color so we're only comparing the wave shape (hue intentionally drifts).
    const firstShape = stripAnsi(frames[0]);
    // Re-render frame 0 with the same options - asserting determinism here
    // is the seam test: the next frame after totalFrames-1 would be the
    // identical-shape "frame totalFrames", which should equal frame 0.
    const reRender = buildIndicatorFrames();

    expect(stripAnsi(reRender[0])).toBe(firstShape);

    // And frame 0 with hueSpeed=0 should equal a frame that's totalFrames
    // worth of advance later (which we synthesize by overriding totalFrames).
    const noHueDrift = buildIndicatorFrames({ hueSpeed: 0, totalFrames: 121 });

    expect(noHueDrift[120]).toBe(noHueDrift[0]);
  });

  test('color loops seamlessly: hue at frame totalFrames matches frame 0 when hueSpeed*totalFrames is a multiple of 360', () => {
    // Default: hueSpeed=3, totalFrames=120 → 360° advance = 1 full rotation.
    // Render an extra frame and assert frame 120 equals frame 0 byte-for-byte
    // (both wave shape AND color), proving there's no seam at the loop point.
    const extended = buildIndicatorFrames({ totalFrames: 121 });

    expect(extended[120]).toBe(extended[0]);
  });

  test('rejects-by-construction: with mismatched hueSpeed there IS a visible color seam', () => {
    // Sanity-check that the seamlessness property above is real and not a
    // side-effect of the test setup. With hueSpeed=4 and totalFrames=120,
    // the hue advances 480° = 120° per loop → frame 120 should NOT equal
    // frame 0.
    const seamful = buildIndicatorFrames({ hueSpeed: 4, totalFrames: 121 });

    expect(seamful[120]).not.toBe(seamful[0]);
  });
});
