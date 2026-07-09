/**
 * Shared frame-loop for the braille visualizers (`wave.ts`, `spectrum.ts`).
 *
 * Both visualizers pre-render an animation the same way: for each of
 * `totalFrames` frames, walk `glyphWidth` braille glyphs, sample the two
 * sub-columns of each glyph, encode them into a braille character, and wrap
 * that character in a truecolor SGR. Only the per-glyph height sampling and
 * the per-glyph colour differ between the two - so those are the injected
 * callbacks and the loop lives here once.
 *
 * Pure module - composes {@link encodeBrailleColumns} and {@link colorize};
 * no pi dependencies.
 */

import { encodeBrailleColumns } from './braille.ts';
import { type RGB, colorize } from './color.ts';

export interface BrailleAnimationOptions {
  /** Number of braille glyphs per frame. */
  glyphWidth: number;
  /** Number of pre-rendered frames in the loop. */
  totalFrames: number;
}

/** Sample the left/right sub-column heights of glyph `k` at frame `t`. */
export type BrailleSampleFn = (k: number, t: number) => { left: number; right: number };

/** Pick the colour of glyph `k` at frame `t` given its sampled heights. */
export type BrailleColorFn = (k: number, t: number, left: number, right: number) => RGB;

/**
 * Pre-render every frame of a braille animation. `sample` supplies the two
 * sub-column heights per glyph and `color` supplies the glyph's RGB; the
 * returned frame strings are ready for `ctx.ui.setWorkingIndicator({ frames })`.
 */
export function buildBrailleAnimationFrames(
  opts: BrailleAnimationOptions,
  sample: BrailleSampleFn,
  color: BrailleColorFn,
): string[] {
  const frames: string[] = [];
  for (let t = 0; t < opts.totalFrames; t++) {
    let frame = '';
    for (let k = 0; k < opts.glyphWidth; k++) {
      const { left, right } = sample(k, t);
      const glyph = encodeBrailleColumns(left, right);
      frame += colorize(glyph, color(k, t, left, right));
    }
    frames.push(frame);
  }
  return frames;
}
