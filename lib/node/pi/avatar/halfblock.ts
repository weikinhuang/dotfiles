/**
 * Pure RGBA -> Unicode half-block renderer for the `avatar` extension.
 *
 * Each terminal cell encodes two stacked pixels via the upper-half block
 * (`U+2580 ▀`): the foreground SGR colour paints the top pixel and the
 * background SGR colour paints the bottom pixel. For a cell where only one
 * half is opaque we use the matching glyph (`▀` top-only, `▄` bottom-only,
 * space when both are transparent) and the default-background SGR (`49`)
 * for the empty half.
 *
 * Output is ordinary truecolor SGR text: pi-tui's `extractAnsiCode()` strips
 * CSI sequences so each cell counts as one visible column - no width-guard
 * crash, no cursor gymnastics. The caller drops the resulting lines into the
 * widget the same way as the kaomoji text path.
 *
 * No pi imports - unit-testable. Truecolor only by design (256-colour
 * fallback is out of scope).
 */

import { type RgbaImage } from './sixel.ts';

const ESC = '\x1b';
/** Alpha at or above this counts as opaque; below it is left transparent. */
const ALPHA_THRESHOLD = 128;

/** SGR reset terminator written at the end of every cell-row line. */
const RESET = `${ESC}[0m`;

/**
 * Encode `img` as one styled string per cell-row, packing two pixel rows
 * into each row of upper-half-block glyphs. The returned array has
 * `ceil(height / 2)` entries; each entry ends with an SGR reset so adjacent
 * text (separator, info panel) stays unstyled.
 */
export function encodeHalfblock(img: RgbaImage): string[] {
  const { width, height, rgba } = img;
  const cellRows = Math.max(1, Math.ceil(height / 2));
  const lines: string[] = [];

  for (let cy = 0; cy < cellRows; cy++) {
    const topY = cy * 2;
    const botY = Math.min(height - 1, topY + 1);
    const hasBottom = topY + 1 < height;
    let line = '';
    for (let x = 0; x < width; x++) {
      const to = (topY * width + x) * 4;
      const bo = (botY * width + x) * 4;
      const topOpaque = rgba[to + 3] >= ALPHA_THRESHOLD;
      const botOpaque = hasBottom && rgba[bo + 3] >= ALPHA_THRESHOLD;

      if (topOpaque && botOpaque) {
        const tr = rgba[to];
        const tg = rgba[to + 1];
        const tb = rgba[to + 2];
        const br = rgba[bo];
        const bg = rgba[bo + 1];
        const bb = rgba[bo + 2];
        line += `${ESC}[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m\u2580`;
      } else if (topOpaque) {
        const tr = rgba[to];
        const tg = rgba[to + 1];
        const tb = rgba[to + 2];
        line += `${ESC}[38;2;${tr};${tg};${tb};49m\u2580`;
      } else if (botOpaque) {
        const br = rgba[bo];
        const bg = rgba[bo + 1];
        const bb = rgba[bo + 2];
        line += `${ESC}[38;2;${br};${bg};${bb};49m\u2584`;
      } else {
        line += `${ESC}[49m `;
      }
    }
    lines.push(`${line}${RESET}`);
  }

  return lines;
}
