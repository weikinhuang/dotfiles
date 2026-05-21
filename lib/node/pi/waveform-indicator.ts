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
// Spectrum bars (audio-EQ pattern)
// ──────────────────────────────────────────────────────────────────────

/** Period of {@link spectrumBar}, in frame units. */
export const SPECTRUM_BAR_PERIOD = 120;

/**
 * Bar height for column `k` at frame `t`. Each column has its own
 * phase offsets so bars bounce independently, like a music spectrum
 * analyzer rather than one flowing wave.
 *
 * Sum of four commensurable sines (periods 120, 60, 40, 30 - all divide
 * 120) normalized into [0, MAX_HEIGHT]. After {@link SPECTRUM_BAR_PERIOD}
 * frames every column returns to its starting height, making the loop
 * seamless. Per-column phase offsets are simple rational multiples of
 * `k` - chosen so neighbouring bars don't lock-step bounce together.
 */
export function spectrumBar(k: number, t: number): number {
  const tau = (2 * Math.PI * t) / 120;
  const phaseA = k * 0.7;
  const phaseB = k * 1.7 + 0.5;
  const phaseC = k * 2.4 + 1.1;
  const phaseD = k * 0.9 + 1.7;
  const a = 1.0 * Math.sin(tau + phaseA); // slow bias (period 120)
  const b = 0.7 * Math.sin(tau * 2 + phaseB); // half-loop bounce (period 60)
  const c = 0.5 * Math.sin(tau * 3 + phaseC); // third-loop bounce (period 40)
  const d = 0.3 * Math.sin(tau * 4 + phaseD); // quarter-loop bounce (period 30)
  // Sum extrema ≈ ±2.5; map [-2.5, 2.5] → [0, MAX_HEIGHT].
  const sum = a + b + c + d;
  const normalized = (sum + 2.5) * (MAX_HEIGHT / 5);
  if (normalized < 0) return 0;
  if (normalized > MAX_HEIGHT) return MAX_HEIGHT;
  return normalized;
}

export interface SpectrumFrameOptions {
  /** Number of braille glyphs in the indicator. Each glyph = 2 bars. Default 10. */
  glyphWidth?: number;
  /**
   * Pre-computed cycle length, in frames. Default 120. For a seamless
   * loop, `totalFrames` must be a multiple of {@link SPECTRUM_BAR_PERIOD}.
   */
  totalFrames?: number;
  /**
   * Degrees of slow rainbow drift per frame, layered on top of the
   * height-based heat-map color. Default 3.
   *
   * For a seamless color loop, `hueSpeed * totalFrames` must be a
   * multiple of 360. Defaults (3 × 120 = 360°) give exactly one rainbow
   * rotation per loop cycle on top of the height gradient.
   */
  hueSpeed?: number;
  /** HSL saturation in [0, 1]. Default 0.75. */
  saturation?: number;
  /** HSL lightness in [0, 1]. Default 0.55. */
  lightness?: number;
  /** Hue offset for frame 0, in degrees. Default 0. */
  startHue?: number;
}

const DEFAULT_SPECTRUM_OPTIONS: Required<SpectrumFrameOptions> = {
  glyphWidth: 10,
  totalFrames: 120,
  hueSpeed: 3,
  saturation: 0.75,
  lightness: 0.55,
  startHue: 0,
};

/**
 * Pre-render every frame of the spectrum-bars animation.
 *
 * Each glyph is colored by the taller of its two bars ("bar tip" color)
 * on a green → yellow → red gradient that mimics a classic EQ display:
 * tall bars glow red, short bars glow green. A slow rainbow drift is
 * layered on top so held bars don't look static and the animation reads
 * differently from the scrolling waveform.
 */
export function buildSpectrumFrames(opts: SpectrumFrameOptions = {}): string[] {
  const o = { ...DEFAULT_SPECTRUM_OPTIONS, ...opts };
  const frames: string[] = [];
  for (let t = 0; t < o.totalFrames; t++) {
    let frame = '';
    for (let k = 0; k < o.glyphWidth; k++) {
      const leftH = spectrumBar(2 * k, t);
      const rightH = spectrumBar(2 * k + 1, t);
      const glyph = encodeBrailleColumns(leftH, rightH);
      // Heat-map: tall=red (0°), mid=yellow (60°), short=green (120°).
      const peak = Math.max(leftH, rightH);
      const baseHue = 120 - (peak / MAX_HEIGHT) * 120;
      const hue = o.startHue + baseHue + t * o.hueSpeed;
      frame += colorize(glyph, hslToRgb(hue, o.saturation, o.lightness));
    }
    frames.push(frame);
  }
  return frames;
}

// ──────────────────────────────────────────────────────────────────────
// Token-rate (live tokens/sec) bars
// ──────────────────────────────────────────────────────────────────────

/**
 * Number of slots in the token-rate render buffer. Matches the default
 * 10-glyph spectrum/scroll geometry: each braille glyph carries two bars,
 * so 20 samples == 10 glyphs. The parity matters - an odd-length buffer
 * would leave a half-glyph at the leading edge.
 */
export const TOKEN_RATE_BUFFER_SIZE = 20;

/**
 * Minimum autoscale ceiling, in tokens/sec. Keeps a single low-rate
 * sample from saturating the bars (a 5 tok/s sample against an autoscale
 * of 5 would max the chart out). 30 tok/s is roughly a fast-streaming
 * provider's sustained rate, so anything below this floor renders as
 * "lower than typical streaming" instead of "off the charts".
 */
export const TOKEN_RATE_MIN_SCALE = 30;

/**
 * Full-spectrum magnitude heat-map endpoints. Low rate → blue (`240°`),
 * mid → green (`120°`) via cyan, high → red (`0°`) via yellow. Spans
 * the cool half of the wheel as well as the warm half so the gradient
 * carries more information per bar height than a green-to-red map -
 * a 1-bar sample reads as "cold blue" instead of "barely-different
 * green", and the eye picks out the shape of the chart more easily.
 *
 * Direction is already conveyed by the `↑` / `↓` arrows in the dim
 * suffix, so dedicating the hue channel to magnitude is the
 * higher-information choice.
 */
export const TOKEN_RATE_HUE_LOW = 240;
export const TOKEN_RATE_HUE_HIGH = 0;

export interface TokenRateHeightsOptions {
  /** Autoscale floor (tokens/sec). Default {@link TOKEN_RATE_MIN_SCALE}. */
  minScale?: number;
}

/**
 * Mutate `buffer` in place: drop the oldest (left-most) sample and append
 * `rate` on the right. Returns the same buffer for fluent use. Non-finite
 * `rate` values are clamped to `0` rather than poisoning the autoscale.
 */
export function pushTokenRateSample(buffer: number[], rate: number): number[] {
  const safe = Number.isFinite(rate) && rate > 0 ? rate : 0;
  buffer.shift();
  buffer.push(safe);
  return buffer;
}

/**
 * Map `buffer` of tokens/sec samples to a `0..MAX_HEIGHT` height array
 * with an autoscale: the ceiling is `max(minScale, max(buffer))`, so a
 * single tall spike doesn't permanently shrink subsequent bars but a
 * sustained burst still rescales the chart. Heights are rounded to the
 * nearest integer so the braille encoder can render them directly.
 */
export function tokenRateBarsToHeights(buffer: readonly number[], opts: TokenRateHeightsOptions = {}): number[] {
  const minScale = opts.minScale ?? TOKEN_RATE_MIN_SCALE;
  let peak = minScale;
  for (const v of buffer) {
    if (Number.isFinite(v) && v > peak) peak = v;
  }
  const scale = peak;
  const heights: number[] = [];
  for (const v of buffer) {
    const safe = Number.isFinite(v) && v > 0 ? v : 0;
    const ratio = safe / scale;
    const h = Math.round(MAX_HEIGHT * (ratio > 1 ? 1 : ratio));
    heights.push(h);
  }
  return heights;
}

export interface TokenRateFrameOptions {
  /** HSL saturation in [0, 1]. Default 0.75 (matches spectrum). */
  saturation?: number;
  /** HSL lightness in [0, 1]. Default 0.55 (matches spectrum). */
  lightness?: number;
  /** Low-rate hue endpoint, in degrees. Default {@link TOKEN_RATE_HUE_LOW} (blue). */
  hueLow?: number;
  /** High-rate hue endpoint, in degrees. Default {@link TOKEN_RATE_HUE_HIGH} (red). */
  hueHigh?: number;
}

const DEFAULT_TOKEN_RATE_FRAME_OPTIONS: Required<TokenRateFrameOptions> = {
  saturation: 0.75,
  lightness: 0.55,
  hueLow: TOKEN_RATE_HUE_LOW,
  hueHigh: TOKEN_RATE_HUE_HIGH,
};

/**
 * Encode a height array (one entry per bar) into a single braille frame
 * coloured with the full-spectrum magnitude heat-map (blue → cyan →
 * green → yellow → red). Pairs of heights collapse into one glyph
 * (left + right column); odd-length arrays drop the trailing height to
 * preserve glyph parity.
 *
 * Each glyph's hue is picked off the taller of its two bars, so a frame
 * with bars rising on the right reads as "the latest sample is hottest"
 * exactly the way the scrolling chart wants it to.
 */
export function buildTokenRateFrame(heights: readonly number[], opts: TokenRateFrameOptions = {}): string {
  const o = { ...DEFAULT_TOKEN_RATE_FRAME_OPTIONS, ...opts };
  const span = o.hueHigh - o.hueLow;
  let frame = '';
  for (let i = 0; i + 1 < heights.length; i += 2) {
    const leftH = heights[i];
    const rightH = heights[i + 1];
    const glyph = encodeBrailleColumns(leftH, rightH);
    const peak = Math.max(leftH, rightH);
    const hue = o.hueLow + (peak / MAX_HEIGHT) * span;
    frame += colorize(glyph, hslToRgb(hue, o.saturation, o.lightness));
  }
  return frame;
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
