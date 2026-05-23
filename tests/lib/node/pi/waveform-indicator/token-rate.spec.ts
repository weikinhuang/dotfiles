/**
 * Tests for lib/node/pi/waveform-indicator/token-rate.ts.
 */

/* oxlint-disable no-control-regex -- this whole file inspects ANSI SGR escapes */

import { describe, expect, test } from 'vitest';

import {
  TOKEN_RATE_BUFFER_SIZE,
  TOKEN_RATE_HUE_HIGH,
  TOKEN_RATE_HUE_LOW,
  TOKEN_RATE_MIN_SCALE,
  buildTokenRateFrame,
  pushTokenRateSample,
  tokenRateBarsToHeights,
} from '../../../../../lib/node/pi/waveform-indicator/token-rate.ts';

const SGR_RE = /\x1b\[[0-9;]*m/g;
const TRUECOLOR_FG_RE = /\x1b\[38;2;\d+;\d+;\d+m/g;
const FG_RESET_RE = /\x1b\[39m/g;

function stripAnsi(s: string): string {
  return s.replace(SGR_RE, '');
}

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
