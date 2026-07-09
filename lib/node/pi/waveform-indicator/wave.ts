/**
 * Music-style scrolling-waveform visualizer for the `waveform-indicator`
 * extension. Pre-renders every frame of a scrolling braille waveform
 * for pi's `setWorkingIndicator({ frames })` call, with a slow rainbow
 * drift layered on top.
 *
 * Pure module - composes {@link encodeBrailleColumns}, {@link hslToRgb},
 * and {@link colorize} from the sibling braille / color modules. No pi
 * dependencies. The frame builder is deterministic given its options,
 * so the spec just snapshots `frames[0]` / `frames[N-1]` and asserts
 * the seam closes.
 *
 * Looping math: the wave is the sum of five commensurable sines on a
 * 60-sample fundamental. With the default `scrollSpeed=0.5` and
 * `totalFrames=120`, `0.5 * 120 = 60` samples advance per loop, which
 * is one full period - so the geometry returns to phase exactly when
 * the rainbow returns to its starting hue (`hueSpeed=3 * 120 = 360°`).
 */

import { MAX_HEIGHT } from './braille.ts';
import { buildBrailleAnimationFrames } from './braille-frames.ts';
import { hslToRgb } from './color.ts';

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
  return buildBrailleAnimationFrames(
    { glyphWidth: o.glyphWidth, totalFrames: o.totalFrames },
    (k, t) => {
      // Right-to-left scroll: as offset grows, the shape's peaks shift left.
      const offset = t * o.scrollSpeed;
      return { left: waveShape(k * 2 + offset), right: waveShape(k * 2 + 1 + offset) };
    },
    (k, t) => hslToRgb(o.startHue + k * o.hueSpread + t * o.hueSpeed, o.saturation, o.lightness),
  );
}
