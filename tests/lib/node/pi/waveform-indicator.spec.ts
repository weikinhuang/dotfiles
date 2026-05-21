/**
 * Tests for lib/node/pi/waveform-indicator.ts.
 *
 * The lib module has zero pi dependencies so these tests run without the
 * pi runtime.
 */

/* oxlint-disable no-control-regex -- this whole file inspects ANSI SGR escapes */

import { describe, expect, test } from 'vitest';

import {
  SPECTRUM_BAR_PERIOD,
  TOKEN_RATE_BUFFER_SIZE,
  TOKEN_RATE_HUE_HIGH,
  TOKEN_RATE_HUE_LOW,
  TOKEN_RATE_MIN_SCALE,
  WAVE_SHAPE_PERIOD,
  buildIndicatorFrames,
  buildSpectrumFrames,
  buildTokenRateFrame,
  colorize,
  encodeBrailleColumns,
  hslToRgb,
  pushTokenRateSample,
  shimmerLabel,
  spectrumBar,
  tokenRateBarsToHeights,
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

// ──────────────────────────────────────────────────────────────────────
// token-rate buffer + frame
// ──────────────────────────────────────────────────────────────────────

function freshRateBuffer(): number[] {
  return Array.from({ length: TOKEN_RATE_BUFFER_SIZE }, () => 0);
}

describe('pushTokenRateSample', () => {
  test('TOKEN_RATE_BUFFER_SIZE is 20 (10 glyphs x 2 columns)', () => {
    expect(TOKEN_RATE_BUFFER_SIZE).toBe(20);
  });

  test('appends on the right and drops the oldest from the left (FIFO)', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, 50);

    expect(buf).toHaveLength(TOKEN_RATE_BUFFER_SIZE);
    expect(buf[buf.length - 1]).toBe(50);
    expect(buf[0]).toBe(0);
  });

  test('a single spike scrolls left across N pushes', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, 100);

    // Now position TOKEN_RATE_BUFFER_SIZE-1 holds the spike.
    expect(buf[TOKEN_RATE_BUFFER_SIZE - 1]).toBe(100);

    // Push zeros and watch the spike drift left.
    for (let i = 1; i < TOKEN_RATE_BUFFER_SIZE; i++) {
      pushTokenRateSample(buf, 0);

      expect(buf[TOKEN_RATE_BUFFER_SIZE - 1 - i]).toBe(100);
    }

    // After TOKEN_RATE_BUFFER_SIZE zero-pushes the spike falls off.
    pushTokenRateSample(buf, 0);
    for (const v of buf) {
      expect(v).toBe(0);
    }
  });

  test('non-finite or negative rates clamp to 0', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, Number.NaN);

    expect(buf[buf.length - 1]).toBe(0);
    pushTokenRateSample(buf, -5);

    expect(buf[buf.length - 1]).toBe(0);
    pushTokenRateSample(buf, Number.POSITIVE_INFINITY);

    expect(buf[buf.length - 1]).toBe(0);
  });

  test('keeps the buffer at fixed length 20', () => {
    const buf = freshRateBuffer();
    for (let i = 0; i < 100; i++) {
      pushTokenRateSample(buf, i);

      expect(buf).toHaveLength(TOKEN_RATE_BUFFER_SIZE);
    }
  });
});

describe('tokenRateBarsToHeights', () => {
  test(`TOKEN_RATE_MIN_SCALE is ${TOKEN_RATE_MIN_SCALE}`, () => {
    expect(TOKEN_RATE_MIN_SCALE).toBe(30);
  });

  test('zero-rate buffer maps to all-zero heights (chart is flat)', () => {
    const heights = tokenRateBarsToHeights(freshRateBuffer());

    expect(heights).toHaveLength(TOKEN_RATE_BUFFER_SIZE);
    for (const h of heights) {
      expect(h).toBe(0);
    }
  });

  test('autoscale floor prevents tiny rates from maxing the bars', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, 5); // 5 tok/s, well under the 30 floor.
    const heights = tokenRateBarsToHeights(buf);
    // 5 / 30 = 0.166 → round(0.666) = 1, well below the 4-bar max.
    expect(heights[heights.length - 1]).toBeLessThan(4);
    expect(heights[heights.length - 1]).toBeGreaterThanOrEqual(0);
  });

  test('a sample at the autoscale floor maxes the bar (ceiling = floor)', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, TOKEN_RATE_MIN_SCALE);
    const heights = tokenRateBarsToHeights(buf);
    // scale = max(floor, max(buffer)) = 30 → ratio 30/30 = 1.0 → 4.
    expect(heights[heights.length - 1]).toBe(4);
  });

  test('a sample at half the floor renders ~2 bars', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, TOKEN_RATE_MIN_SCALE / 2);
    const heights = tokenRateBarsToHeights(buf);
    // 15 / 30 = 0.5 → round(2) = 2.
    expect(heights[heights.length - 1]).toBe(2);
  });

  test('autoscale ceiling lifts when a sample exceeds the floor', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, 90); // ceiling moves to 90.
    pushTokenRateSample(buf, 45); // 45 / 90 = 0.5 → round(2) = 2.
    const heights = tokenRateBarsToHeights(buf);

    expect(heights[heights.length - 2]).toBe(4); // the 90 spike is the top.
    expect(heights[heights.length - 1]).toBe(2);
  });

  test('respects a caller-supplied minScale', () => {
    const buf = freshRateBuffer();
    pushTokenRateSample(buf, 50);
    const heights = tokenRateBarsToHeights(buf, { minScale: 100 });
    // 50 / 100 = 0.5 → 2.
    expect(heights[heights.length - 1]).toBe(2);
  });

  test('non-finite samples are treated as zero', () => {
    const buf = freshRateBuffer();
    buf[5] = Number.NaN;
    buf[6] = Number.POSITIVE_INFINITY;
    pushTokenRateSample(buf, 30);
    const heights = tokenRateBarsToHeights(buf);
    // NaN/Infinity shouldn't poison the autoscale or the height map.
    expect(heights[5]).toBeGreaterThanOrEqual(0);
    expect(heights[6]).toBeGreaterThanOrEqual(0);
    expect(heights[heights.length - 1]).toBe(4);
  });
});

describe('buildTokenRateFrame', () => {
  test('all-zero heights render entirely blank braille glyphs', () => {
    const heights = Array.from<number>({ length: TOKEN_RATE_BUFFER_SIZE }).fill(0);
    const frame = buildTokenRateFrame(heights);
    const stripped = stripAnsi(frame);

    expect(stripped).toHaveLength(TOKEN_RATE_BUFFER_SIZE / 2);
    for (const ch of stripped) {
      expect(ch).toBe('⠀');
    }
  });

  test('every encoded glyph is in U+2800..U+28FF', () => {
    const heights = [0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 2, 3, 1, 4, 0, 2, 3, 1, 4, 0];
    const frame = buildTokenRateFrame(heights);
    const stripped = stripAnsi(frame);
    for (const ch of stripped) {
      const cp = ch.codePointAt(0)!;

      expect(cp).toBeGreaterThanOrEqual(0x2800);
      expect(cp).toBeLessThanOrEqual(0x28ff);
    }
  });

  test('one glyph per height pair, plus a truecolor SGR + reset per glyph', () => {
    const heights = [0, 0, 1, 2, 3, 4, 2, 1, 4, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4];
    const frame = buildTokenRateFrame(heights);
    const stripped = stripAnsi(frame);

    expect(stripped).toHaveLength(heights.length / 2);
    expect(frame.match(TRUECOLOR_FG_RE)).toHaveLength(heights.length / 2);
    expect(frame.match(FG_RESET_RE)).toHaveLength(heights.length / 2);
  });

  test('odd-length height arrays drop the trailing height to preserve parity', () => {
    const heights = [4, 4, 4]; // last "4" has no partner; produces 1 glyph.
    const frame = buildTokenRateFrame(heights);

    expect(stripAnsi(frame)).toHaveLength(1);
  });

  test('full-spectrum heat-map: low heights paint blue, high heights paint red', () => {
    const lowFrame = buildTokenRateFrame([1, 0]); // peak=1 → hue ~180° (cyan)
    const veryLowFrame = buildTokenRateFrame([0, 0]); // peak=0 → hue 240° (blue)
    const highFrame = buildTokenRateFrame([4, 4]); // peak=4 → hue 0° (red)
    const sgrRe = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
    const lowMatch = sgrRe.exec(lowFrame)!;
    const veryLowMatch = sgrRe.exec(veryLowFrame)!;
    const highMatch = sgrRe.exec(highFrame)!;
    const lowRgb = { r: Number(lowMatch[1]), g: Number(lowMatch[2]), b: Number(lowMatch[3]) };
    const veryLowRgb = { r: Number(veryLowMatch[1]), g: Number(veryLowMatch[2]), b: Number(veryLowMatch[3]) };
    const highRgb = { r: Number(highMatch[1]), g: Number(highMatch[2]), b: Number(highMatch[3]) };

    // Cold end (peak=0, hue 240°): blue dominant.
    expect(veryLowRgb.b).toBeGreaterThan(veryLowRgb.r);
    expect(veryLowRgb.b).toBeGreaterThan(veryLowRgb.g);

    // Near-cold (peak=1, hue ~180° cyan): blue and green both high, red low.
    expect(lowRgb.b).toBeGreaterThan(lowRgb.r);
    expect(lowRgb.g).toBeGreaterThan(lowRgb.r);

    // Hot end (peak=4, hue 0°): red dominant.
    expect(highRgb.r).toBeGreaterThan(highRgb.g);
    expect(highRgb.r).toBeGreaterThan(highRgb.b);
  });

  test('mid heights (peak=2) land near green (the midpoint of the gradient)', () => {
    const midFrame = buildTokenRateFrame([2, 2]);
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(midFrame)!;
    const mid = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    // Halfway from 240° to 0° lands on 120° → green.
    expect(mid.g).toBeGreaterThan(mid.r);
    expect(mid.g).toBeGreaterThan(mid.b);
  });

  test('peak=3 lands in the yellow band (between green and red)', () => {
    const frame = buildTokenRateFrame([3, 3]);
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(frame)!;
    const rgb = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    // 240 + (3/4)*(-240) = 60° → yellow (red + green, blue minimal).
    expect(rgb.r).toBeGreaterThan(rgb.b);
    expect(rgb.g).toBeGreaterThan(rgb.b);
  });

  test('TOKEN_RATE_HUE_LOW / TOKEN_RATE_HUE_HIGH bookend the full-spectrum gradient', () => {
    expect(TOKEN_RATE_HUE_LOW).toBe(240);
    expect(TOKEN_RATE_HUE_HIGH).toBe(0);
  });

  test('every height pair lands somewhere on the spectrum (no clamped/all-zero SGR)', () => {
    // Sanity-check that the gradient never collapses to (0,0,0) for any
    // peak value - a degenerate hue would make the chart unreadable for
    // that bar height.
    for (let l = 0; l <= 4; l++) {
      for (let r = 0; r <= 4; r++) {
        if (l === 0 && r === 0) continue; // skip the all-blank glyph itself
        const frame = buildTokenRateFrame([l, r]);
        const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(frame)!;
        const rgb = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };

        expect(Math.max(rgb.r, rgb.g, rgb.b)).toBeGreaterThan(0);
      }
    }
  });
});
