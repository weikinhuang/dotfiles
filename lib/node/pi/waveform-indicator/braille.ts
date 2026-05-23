/**
 * Braille-glyph waveform encoder for the `waveform-indicator` extension.
 *
 * Each U+2800 braille glyph carries two waveform samples - one in the
 * left column, one in the right - so a single character renders two
 * sample heights and the visualizer gets twice the horizontal resolution
 * of a chunky 2-col-thick bar at the same width. Heights are 0..4
 * (`MAX_HEIGHT`), filled from the bottom of each column upward, matching
 * the look of inputs like ⠤⢴⣿⡧⣾⣿⡦.
 *
 * Pure module - zero pi dependencies - so the bit-twiddling is directly
 * unit-testable and the visualizers can compose it freely.
 */

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

/** Maximum height a single braille column can render (4 stacked dots). */
export const MAX_HEIGHT = 4;

function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return 0;
  const rounded = Math.round(h);
  if (rounded < 0) return 0;
  if (rounded > MAX_HEIGHT) return MAX_HEIGHT;
  return rounded;
}

/**
 * Encode two waveform sample heights (0..4) into a single braille glyph.
 * Heights are clamped and rounded; out-of-range values are pinned, not
 * thrown.
 */
export function encodeBrailleColumns(leftHeight: number, rightHeight: number): string {
  const lh = clampHeight(leftHeight);
  const rh = clampHeight(rightHeight);
  return String.fromCharCode(0x2800 + LEFT_COL_MASKS[lh] + RIGHT_COL_MASKS[rh]);
}
