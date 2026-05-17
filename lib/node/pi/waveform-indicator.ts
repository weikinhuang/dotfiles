/**
 * Pure helpers for config/pi/extensions/waveform-indicator.ts.
 *
 * Renders a music-style braille waveform for pi's `setWorkingIndicator`
 * frames and a per-character rainbow shimmer for the `setWorkingMessage`
 * label. Zero dependencies on @earendil-works/pi-coding-agent so this
 * module is pure-vitest territory.
 *
 * Encoding: each braille glyph carries two waveform samples (left column
 * and right column), with sample heights in 0..4 rendered as bars from the
 * bottom. That doubles the horizontal resolution vs. chunky 2-col-thick
 * bars and matches the mixed-column look of inputs like ⠤⢴⣿⡧⣾⣿⡦.
 */

const FG_RESET = '\x1b[39m';

// Bitmasks for "bar from bottom" heights 0..4 in each braille column.
//
// Braille bit layout (U+2800 base, dots 1..8 → bits 0..7):
//   1=0x01  4=0x08
//   2=0x02  5=0x10
//   3=0x04  6=0x20
//   7=0x40  8=0x80
//
// Left column dots from top: 1, 2, 3, 7. Right column: 4, 5, 6, 8.
// Heights fill from the bottom up: 7→3→2→1 (left), 8→6→5→4 (right).
const LEFT_COL_MASKS = [0x00, 0x40, 0x44, 0x46, 0x47] as const;
const RIGHT_COL_MASKS = [0x00, 0x80, 0xa0, 0xb0, 0xb8] as const;

const MAX_HEIGHT = 4;

function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return 0;
  const rounded = Math.round(h);
  if (rounded < 0) return 0;
  if (rounded > MAX_HEIGHT) return MAX_HEIGHT;
  return rounded;
}

/**
 * Encode two waveform sample heights (0..4) into a single braille glyph.
 * Heights are clamped and rounded; out-of-range values are pinned, not thrown.
 */
export function encodeBrailleColumns(leftHeight: number, rightHeight: number): string {
  const lh = clampHeight(leftHeight);
  const rh = clampHeight(rightHeight);
  return String.fromCharCode(0x2800 + LEFT_COL_MASKS[lh] + RIGHT_COL_MASKS[rh]);
}

// ──────────────────────────────────────────────────────────────────────
// Color
// ──────────────────────────────────────────────────────────────────────

export interface RGB {
  r: number;
  g: number;
  b: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Convert HSL → RGB. h in degrees (any sign), s and l in [0, 1].
 * Returns 8-bit channels (0..255).
 */
export function hslToRgb(h: number, s: number, l: number): RGB {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) {
    r1 = c;
    g1 = x;
  } else if (hue < 120) {
    r1 = x;
    g1 = c;
  } else if (hue < 180) {
    g1 = c;
    b1 = x;
  } else if (hue < 240) {
    g1 = x;
    b1 = c;
  } else if (hue < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/** Wrap text in a truecolor SGR foreground escape. */
export function colorize(text: string, rgb: RGB): string {
  return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}${FG_RESET}`;
}

// ──────────────────────────────────────────────────────────────────────
// Wave shape
// ──────────────────────────────────────────────────────────────────────

/**
 * Periodic shape sampled at sample-index `x`. Period = 60 samples.
 *
 * Sum of five commensurable sines (periods 60, 20, 12, 6, 4 - all divide
 * 60) normalized into [0, MAX_HEIGHT]. Commensurability keeps the loop
 * seamless: after `scrollSpeed * totalFrames` samples of advance all five
 * components return to phase together.
 *
 * Why five components on a 60-sample fundamental: with the default
 * 10-glyph (= 20-sample) window and `scrollSpeed=0.5`, the visible shape
 * only fully repeats once per loop cycle (every 120 frames ≈ 9.6 s).
 * That breaks up the "obviously looping" feel a single short-period
 * waveform has, while the layered tempos read like a music-waveform
 * envelope (slow amplitude swell + faster oscillations) instead of a
 * pure tone.
 */
export function waveShape(x: number): number {
  const t = (2 * Math.PI * x) / 60;
  const a = 1.0 * Math.sin(t); // slow envelope
  const b = 0.7 * Math.sin(t * 3 + 0.4); // mid swell (period 20)
  const c = 0.7 * Math.sin(t * 5 + 0.7); // music tempo (period 12)
  const d = 0.45 * Math.sin(t * 10 + 1.3); // detail (period 6)
  const e = 0.3 * Math.sin(t * 15 + 1.9); // grain (period 4)
  // Empirical extrema of the sum are within roughly ±3.0; map [-3, 3] → [0, 4].
  const sum = a + b + c + d + e;
  const normalized = (sum + 3) * (MAX_HEIGHT / 6);
  if (normalized < 0) return 0;
  if (normalized > MAX_HEIGHT) return MAX_HEIGHT;
  return normalized;
}

/** Period of {@link waveShape}, in sample units. */
export const WAVE_SHAPE_PERIOD = 60;

// ──────────────────────────────────────────────────────────────────────
// Frame builder
// ──────────────────────────────────────────────────────────────────────

export interface IndicatorFrameOptions {
  /** Number of braille glyphs in the indicator. Each glyph = 2 samples. Default 10. */
  glyphWidth?: number;
  /**
   * Pre-computed cycle length, in frames. The animation is pre-rendered
   * once and replayed by pi's loader, so this controls how long before
   * the loop seam. Default 120 (≈ 9.6 s at intervalMs=80).
   *
   * For a seamless loop, `scrollSpeed * totalFrames` must be a multiple
   * of {@link WAVE_SHAPE_PERIOD}.
   */
  totalFrames?: number;
  /** Samples advanced per frame. Default 0.5 (right-to-left scroll, ≈ 3 glyphs/sec at 80 ms). */
  scrollSpeed?: number;
  /**
   * Degrees of hue drift per frame. Default 3.
   *
   * For a seamless color loop, `hueSpeed * totalFrames` must be a
   * multiple of 360. Defaults (3 × 120 = 360°) give exactly one rainbow
   * rotation per loop cycle. If you raise one, raise the other to match
   * or you'll see a visible hue snap when the indicator restarts.
   */
  hueSpeed?: number;
  /** Degrees of hue between adjacent glyphs (rainbow band width). Default 24. */
  hueSpread?: number;
  /** HSL saturation in [0, 1]. Default 0.7. */
  saturation?: number;
  /** HSL lightness in [0, 1]. Default 0.6. */
  lightness?: number;
  /** Hue offset for frame 0, in degrees. Default 0. */
  startHue?: number;
}

const DEFAULT_INDICATOR_OPTIONS: Required<IndicatorFrameOptions> = {
  glyphWidth: 10,
  totalFrames: 120,
  scrollSpeed: 0.5,
  hueSpeed: 3,
  hueSpread: 24,
  saturation: 0.7,
  lightness: 0.6,
  startHue: 0,
};

/**
 * Pre-render every frame of the indicator animation. The returned array is
 * meant to be passed straight to `ctx.ui.setWorkingIndicator({ frames })`,
 * which cycles them at `intervalMs`.
 *
 * Each frame contains `glyphWidth` braille glyphs, each colorized with a
 * truecolor SGR escape so pi's loader can render them verbatim.
 */
export function buildIndicatorFrames(opts: IndicatorFrameOptions = {}): string[] {
  const o = { ...DEFAULT_INDICATOR_OPTIONS, ...opts };
  const frames: string[] = [];
  for (let t = 0; t < o.totalFrames; t++) {
    let frame = '';
    const offset = t * o.scrollSpeed;
    for (let k = 0; k < o.glyphWidth; k++) {
      // Right-to-left scroll: as offset grows, the shape's peaks shift left.
      const xLeft = k * 2 + offset;
      const xRight = k * 2 + 1 + offset;
      const glyph = encodeBrailleColumns(waveShape(xLeft), waveShape(xRight));
      const hue = o.startHue + k * o.hueSpread + t * o.hueSpeed;
      frame += colorize(glyph, hslToRgb(hue, o.saturation, o.lightness));
    }
    frames.push(frame);
  }
  return frames;
}

// ──────────────────────────────────────────────────────────────────────
// Label shimmer
// ──────────────────────────────────────────────────────────────────────

export interface LabelShimmerOptions {
  /** Degrees of hue drift per tick. Default 2. */
  hueSpeed?: number;
  /** Degrees of hue between adjacent characters. Default 15. */
  hueSpread?: number;
  /** HSL saturation in [0, 1]. Default 0.55. */
  saturation?: number;
  /** HSL lightness in [0, 1]. Default 0.7. */
  lightness?: number;
  /** Hue offset for tick 0, in degrees. Default 0. */
  startHue?: number;
}

const DEFAULT_LABEL_OPTIONS: Required<LabelShimmerOptions> = {
  hueSpeed: 2,
  hueSpread: 15,
  saturation: 0.55,
  lightness: 0.7,
  startHue: 0,
};

/**
 * Wrap each non-whitespace character in `text` with a truecolor SGR so the
 * label shimmers across the rainbow as `tick` increases. Whitespace is
 * preserved verbatim - colorizing it just bloats the byte count without
 * any visual effect.
 *
 * Iterates by Unicode code point so multi-byte glyphs (emoji, accented
 * letters) get one color per visual character.
 */
export function shimmerLabel(text: string, tick: number, opts: LabelShimmerOptions = {}): string {
  const o = { ...DEFAULT_LABEL_OPTIONS, ...opts };
  let out = '';
  let k = 0;
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      out += ch;
      k++;
      continue;
    }
    const hue = o.startHue + k * o.hueSpread + tick * o.hueSpeed;
    out += colorize(ch, hslToRgb(hue, o.saturation, o.lightness));
    k++;
  }
  return out;
}
