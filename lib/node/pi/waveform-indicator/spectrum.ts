/**
 * Audio-EQ-style spectrum-bars visualizer for the `waveform-indicator`
 * extension. Pre-renders frames of independently bouncing braille bars,
 * each glyph coloured on a green→yellow→red height-based heat-map with
 * a slow rainbow drift on top so held bars don't look static.
 *
 * Pure module - composes braille encoding + HSL colorization. No pi
 * dependencies. Sibling to `wave.ts` (scrolling waveform) and
 * `token-rate.ts` (live tokens/sec) so the three visualizers can be
 * swapped per-persona without each carrying its own colorizer copy.
 */

import { encodeBrailleColumns, MAX_HEIGHT } from './braille.ts';
import { colorize, hslToRgb } from './color.ts';

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
