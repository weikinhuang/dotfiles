/**
 * Live tokens/sec visualizer for the `waveform-indicator` extension.
 *
 * Maintains a rolling buffer of recent tokens/sec samples, autoscales
 * the magnitude into braille bar heights, and renders the resulting
 * frame coloured on a full-spectrum heat-map (blue → cyan → green →
 * yellow → red).
 *
 * Pure module - composes braille encoding + HSL colorization. No pi
 * dependencies. Sibling to `wave.ts` and `spectrum.ts`; the persona
 * dispatcher in the `waveform-indicator` extension picks one of the
 * three.
 */

import { encodeBrailleColumns, MAX_HEIGHT } from './braille.ts';
import { colorize, hslToRgb } from './color.ts';

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
