/**
 * Truecolor colorization for the `waveform-indicator` extension's
 * braille frames and shimmering label.
 *
 * Pure module - zero pi dependencies - so the HSL→RGB conversion and
 * SGR wrapping are directly unit-testable. The visualizers under
 * `wave.ts` / `spectrum.ts` / `token-rate.ts` and the label shimmer
 * under `shimmer.ts` all compose `colorize(text, hslToRgb(...))`.
 */

const FG_RESET = '\x1b[39m';

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
