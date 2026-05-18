/**
 * Tests for lib/node/pi/waveform-indicator.ts.
 *
 * The lib module has zero pi dependencies so these tests run without the
 * pi runtime.
 */

/* eslint-disable no-control-regex -- this whole file inspects ANSI SGR escapes */

import { describe, expect, test } from 'vitest';

import {
  SPECTRUM_BAR_PERIOD,
  WAVE_SHAPE_PERIOD,
  buildIndicatorFrames,
  buildSpectrumFrames,
  colorize,
  encodeBrailleColumns,
  hslToRgb,
  shimmerLabel,
  spectrumBar,
  waveShape,
} from '../../../../lib/node/pi/waveform-indicator.ts';

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const SGR_RE = /\x1b\[[0-9;]*m/g;
const TRUECOLOR_FG_RE = /\x1b\[38;2;\d+;\d+;\d+m/g;
const FG_RESET_RE = /\x1b\[39m/g;

function stripAnsi(s: string): string {
  return s.replace(SGR_RE, '');
}

// ──────────────────────────────────────────────────────────────────────
// encodeBrailleColumns
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// hslToRgb
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// colorize
// ──────────────────────────────────────────────────────────────────────

describe('colorize', () => {
  test('wraps text in truecolor SGR open + reset', () => {
    expect(colorize('x', { r: 10, g: 20, b: 30 })).toBe('\x1b[38;2;10;20;30mx\x1b[39m');
  });
});

// ──────────────────────────────────────────────────────────────────────
// waveShape
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// buildIndicatorFrames
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// shimmerLabel
// ──────────────────────────────────────────────────────────────────────

describe('shimmerLabel', () => {
  test('preserves character order when ANSI is stripped', () => {
    const out = shimmerLabel('Thinking...', 0);

    expect(stripAnsi(out)).toBe('Thinking...');
  });

  test('wraps each non-whitespace character in its own SGR pair', () => {
    const out = shimmerLabel('abc', 0);

    expect(out.match(TRUECOLOR_FG_RE)).toHaveLength(3);
    expect(out.match(FG_RESET_RE)).toHaveLength(3);
  });

  test('does NOT colorize whitespace', () => {
    const out = shimmerLabel('a b', 0);

    // Two visible chars → two color escapes; the space passes through raw.
    expect(out.match(TRUECOLOR_FG_RE)).toHaveLength(2);
    expect(out).toContain(' ');
  });

  test('handles empty string', () => {
    expect(shimmerLabel('', 0)).toBe('');
  });

  test('different ticks produce different output (label shimmers)', () => {
    const a = shimmerLabel('Thinking...', 0);
    const b = shimmerLabel('Thinking...', 30);

    expect(a).not.toBe(b);
  });

  test('iterates by code point so multi-byte glyphs get one color', () => {
    // U+1F4A1 (light bulb) is 2 UTF-16 code units but one code point.
    const out = shimmerLabel('💡!', 0);

    expect(out.match(TRUECOLOR_FG_RE)).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// (helpers above for stripAnsi reuse)
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// spectrumBar
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// buildSpectrumFrames
// ──────────────────────────────────────────────────────────────────────

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
