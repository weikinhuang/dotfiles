/**
 * Per-character rainbow shimmer for the `waveform-indicator` extension's
 * `setWorkingMessage` label. Iterates the input by Unicode code point so
 * multi-byte glyphs (emoji, accented letters) get one color per visual
 * character, and skips whitespace so the byte count doesn't bloat with
 * SGR escapes that wouldn't render anyway.
 *
 * Pure module - composes {@link colorize} + {@link hslToRgb} from the
 * sibling `color.ts`. No pi dependencies.
 */

import { colorize, hslToRgb } from './color.ts';

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
