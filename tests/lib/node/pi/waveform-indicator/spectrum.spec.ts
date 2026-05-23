/**
 * Tests for lib/node/pi/waveform-indicator/spectrum.ts.
 */

/* oxlint-disable no-control-regex -- this whole file inspects ANSI SGR escapes */

import { describe, expect, test } from 'vitest';

import {
  buildSpectrumFrames,
  SPECTRUM_BAR_PERIOD,
  spectrumBar,
} from '../../../../../lib/node/pi/waveform-indicator/spectrum.ts';

const SGR_RE = /\x1b\[[0-9;]*m/g;
const TRUECOLOR_FG_RE = /\x1b\[38;2;\d+;\d+;\d+m/g;
const FG_RESET_RE = /\x1b\[39m/g;

function stripAnsi(s: string): string {
  return s.replace(SGR_RE, '');
}

describe('spectrumBar', () => {
  test('SPECTRUM_BAR_PERIOD is 120', () => {
    expect(SPECTRUM_BAR_PERIOD).toBe(120);
  });

  test('returns heights inside [0, 4] for every (k, t) sample', () => {
    for (let k = 0; k < 20; k++) {
      for (let t = 0; t < 240; t++) {
        const h = spectrumBar(k, t);

        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(4);
      }
    }
  });

  test('is periodic with period SPECTRUM_BAR_PERIOD per column', () => {
    for (let k = 0; k < 20; k++) {
      for (let t = 0; t < 30; t++) {
        expect(spectrumBar(k, t + SPECTRUM_BAR_PERIOD)).toBeCloseTo(spectrumBar(k, t), 10);
      }
    }
  });

  test('different columns DO NOT lock-step bounce together', () => {
    // Pick a sample frame and assert at least 8 distinct heights across 20 columns.
    const t = 17;
    const heights = new Set<number>();
    for (let k = 0; k < 20; k++) {
      heights.add(Math.round(spectrumBar(k, t) * 100));
    }

    expect(heights.size).toBeGreaterThanOrEqual(8);
  });

  test('actually exercises the full dynamic range', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < 20; k++) {
      for (let t = 0; t < SPECTRUM_BAR_PERIOD; t++) {
        const h = spectrumBar(k, t);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }

    // Heat-map needs visible green AND visible red over a loop.
    expect(min).toBeLessThan(0.5);
    expect(max).toBeGreaterThan(3.5);
  });
});

describe('buildSpectrumFrames', () => {
  test('returns totalFrames frames of glyphWidth braille glyphs each', () => {
    const frames = buildSpectrumFrames({ glyphWidth: 7, totalFrames: 12 });

    expect(frames).toHaveLength(12);

    for (const frame of frames) {
      const stripped = stripAnsi(frame);

      expect(stripped).toHaveLength(7);

      for (const ch of stripped) {
        const cp = ch.codePointAt(0)!;

        expect(cp).toBeGreaterThanOrEqual(0x2800);
        expect(cp).toBeLessThanOrEqual(0x28ff);
      }
    }
  });

  test('every glyph carries a truecolor SGR + reset', () => {
    const frames = buildSpectrumFrames({ glyphWidth: 6, totalFrames: 4 });
    for (const frame of frames) {
      expect(frame.match(TRUECOLOR_FG_RE)).toHaveLength(6);
      expect(frame.match(FG_RESET_RE)).toHaveLength(6);
    }
  });

  test('animation is alive: no two consecutive frames are identical', () => {
    const frames = buildSpectrumFrames();
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).not.toBe(frames[i - 1]);
    }
  });

  test('loops seamlessly: frame totalFrames matches frame 0 byte-for-byte', () => {
    // Default (totalFrames=120, hueSpeed=3) → bars return to phase AND
    // hue drift completes 360° → the next-after-last frame must equal
    // frame 0 with no shape OR color seam.
    const extended = buildSpectrumFrames({ totalFrames: 121 });

    expect(extended[120]).toBe(extended[0]);
  });

  test('rejects-by-construction: hueSpeed=4 reintroduces a color seam', () => {
    const seamful = buildSpectrumFrames({ hueSpeed: 4, totalFrames: 121 });

    expect(seamful[120]).not.toBe(seamful[0]);
  });

  test('reads visually different from the wave: column heights are independent across a frame', () => {
    // The waveform is a continuous shape → adjacent columns differ by
    // small smooth steps. The spectrum's per-column phases mean adjacent
    // columns can have very different heights, so a single frame should
    // contain >=2 distinct glyph codepoints (after stripping color).
    const frame = stripAnsi(buildSpectrumFrames({ totalFrames: 1 })[0]);
    const distinct = new Set(frame);

    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });
});
