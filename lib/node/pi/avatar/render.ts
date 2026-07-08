/**
 * Pure render/format helpers for the `avatar` extension.
 *
 * Two families of pure logic live here:
 *
 *   1. **Frame building** - {@link imageRows} sizes an image to the cell grid
 *      and {@link buildImageFrame} decodes a PNG and encodes it to the target
 *      protocol (kitty / iTerm2 / sixel / half-block), producing a
 *      {@link RenderedFrame}. These read a file and the environment (for tmux
 *      wrapping) but are otherwise deterministic.
 *   2. **Line layout** - the `render*Frame` helpers turn a `RenderedFrame`
 *      (plus the info column, separator, and size) into the exact terminal
 *      lines the widget paints, including the sixel cursor-gymnastics that
 *      cooperate with pi-tui's differential renderer.
 *
 * The pi-coupled glue (the widget, `getCellDimensions`, `visibleWidth`) stays
 * in the extension shell; text renderers here take an injected {@link TextMeasure}
 * so their width math stays testable without a pi-tui import.
 */

import { readFileSync } from 'node:fs';

import { encodeITermImage, encodeKittyImage } from './encode.ts';
import { encodeHalfblock } from './halfblock.ts';
import { decodePng } from './png-decode.ts';
import { readPngDimensions } from './png.ts';
import { SIXEL_IMAGE_LINE_MARKER, encodeSixel, resizeNearest } from './sixel.ts';
import type { RenderedFrame } from './store.ts';
import { isInTmux, wrapForTmux } from './tmux.ts';
import type { Protocol } from './types.ts';

/** Pixel dimensions of one terminal cell (from pi-tui's `getCellDimensions`). */
export interface CellDimensions {
  widthPx: number;
  heightPx: number;
}

/**
 * Width measurement injected by the shell so the text renderers can stay
 * pure while still using pi-tui's ANSI/wide-char-aware measurements.
 */
export interface TextMeasure {
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number, ellipsis: string): string;
}

/** Cell-rows an image `cols` wide occupies once scaled to preserve aspect. */
export function imageRows(dims: { width: number; height: number }, cols: number, cell: CellDimensions): number {
  if (dims.width <= 0 || cell.heightPx <= 0) return Math.max(1, Math.round(cols / 2));
  const scaledHeightPx = (dims.height * (cols * cell.widthPx)) / dims.width;
  return Math.max(1, Math.round(scaledHeightPx / cell.heightPx));
}

/**
 * Build a {@link RenderedFrame} for the PNG at `pngPath`, targeting `protocol`
 * at `cols` cells wide. Returns null when the file is unreadable or (for the
 * pixel-shipping protocols) the PNG cannot be decoded. `env` is read only to
 * decide tmux passthrough wrapping.
 */
export function buildImageFrame(
  pngPath: string,
  protocol: Protocol,
  cols: number,
  cell: CellDimensions,
  env: NodeJS.ProcessEnv = process.env,
): RenderedFrame | null {
  let data: Buffer;
  try {
    data = readFileSync(pngPath);
  } catch {
    return null;
  }
  const dims = readPngDimensions(data) ?? { width: 1, height: 1 };
  const rows = imageRows(dims, cols, cell);
  if (protocol === 'halfblock') {
    // Half-block packs two pixel rows into one cell-row, so target 2*rows px tall.
    const decoded = decodePng(data);
    if (!decoded) return null;
    const cells = encodeHalfblock(resizeNearest(decoded, cols, rows * 2));
    return { kind: 'halfblock', cells, rows: cells.length };
  }
  const inTmux = isInTmux(env);
  if (protocol === 'sixel') {
    // Sixel ships actual pixels: decode, scale to the on-screen footprint, encode.
    const decoded = decodePng(data);
    if (!decoded) return null;
    const dstW = Math.max(1, Math.round(cols * cell.widthPx));
    const dstH = Math.max(1, Math.round((decoded.height * dstW) / decoded.width));
    const inner = encodeSixel(resizeNearest(decoded, dstW, dstH));
    // Wrap only the DCS payload for tmux; the marker stays outside so pi-tui
    // still sees `\x1b_G` at line start and skips its width guard. Outside
    // tmux, the marker still sits in front of the bare sixel as before.
    const wrapped = inTmux ? wrapForTmux(inner) : inner;
    const sequence = SIXEL_IMAGE_LINE_MARKER + wrapped;
    return { kind: 'image', sequence, rows, style: 'sixel' };
  }
  const base64 = data.toString('base64');
  const size = { cols, rows };
  // Kitty (`\x1b_G`) and iTerm2 (`\x1b]1337;File=`) lines stay recognised by
  // pi-tui's `isImageLine` even when wrapped, because the doubled-ESC encoding
  // preserves the protocol prefix as a substring.
  if (protocol === 'iterm2') {
    const raw = encodeITermImage(base64, size, data.length);
    return { kind: 'image', sequence: inTmux ? wrapForTmux(raw) : raw, rows, style: 'iterm2' };
  }
  const raw = encodeKittyImage(base64, size);
  return { kind: 'image', sequence: inTmux ? wrapForTmux(raw) : raw, rows, style: 'kitty' };
}

export function renderKittyFrame(
  frame: RenderedFrame & { kind: 'image' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const avatarPad = ' '.repeat(size);
  const lines: string[] = [];
  for (let i = 0; i < frame.rows; i++) {
    const head = i === 0 ? ` ${frame.sequence}${avatarPad}` : ` ${avatarPad}`;
    lines.push(`${head} ${sep} ${info[i] ?? ''}`);
  }
  return lines;
}

export function renderITermFrame(
  frame: RenderedFrame & { kind: 'image' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const skipPad = `\x1b[${1 + size}C`;
  const lines: string[] = [];
  for (let i = 0; i < frame.rows; i++) {
    if (i < frame.rows - 1) {
      lines.push(`${skipPad} ${sep} ${info[i] ?? ''}`);
    } else {
      const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : '';
      lines.push(`${up}\x1b[1C${frame.sequence} ${sep} ${info[i] ?? ''}`);
    }
  }
  return lines;
}

/**
 * Render a sixel avatar frame. Unlike kitty / iTerm2 (whose terminals track the
 * image as an object and advance the cursor for us), sixel paints raw pixels
 * into the cell grid, so the layout has to cooperate with pi-tui's differential
 * renderer:
 *
 *   - Info text sits to the right of the image and is positioned with
 *     cursor-forward (`CSI n C`), not spaces - spaces would draw over (and so
 *     erase) the image pixels.
 *   - The sixel is painted on the LAST emitted line, after pi-tui has issued its
 *     per-line `\x1b[2K` erases for the block; painting on an earlier line would
 *     get wiped by the next line's erase. `\x1b[{rows-1}A` walks the cursor up
 *     to the top of the reserved block so the image paints downward over it.
 *   - Before painting, the image's cell column is cleared row-by-row with
 *     `\x1b[{n}X` (erase chars, left region only) so a previous frame's pixels
 *     do not ghost through transparent areas of the new frame.
 *   - The whole paint is wrapped in DECSC / DECRC (`\x1b7` / `\x1b8`) so the
 *     cursor returns to the end of the last line, where pi-tui's cursor model
 *     expects it. pi-tui itself does not use DECSC / DECRC.
 */
export function renderSixelFrame(
  frame: RenderedFrame & { kind: 'image' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const skip = `\x1b[${1 + size}C`;
  const lines: string[] = [];
  for (let i = 0; i < frame.rows - 1; i++) {
    lines.push(`${skip} ${sep} ${info[i] ?? ''}`);
  }
  const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : '';
  const clearWidth = size + 1;
  let paint = `\x1b7\r${up}`;
  for (let r = 0; r < frame.rows; r++) {
    paint += `\x1b[${clearWidth}X`;
    if (r < frame.rows - 1) paint += '\x1b[1B';
  }
  paint += `${up}\x1b[1C${frame.sequence}\x1b8`;
  const last = frame.rows - 1;
  lines.push(`${skip} ${sep} ${info[last] ?? ''}${paint}`);
  return lines;
}

/**
 * Render a half-block (pixel-art) avatar frame. Each entry in `frame.cells`
 * is a styled string of `size` cells (one cell = two stacked pixels) and
 * already terminates with an SGR reset, so the separator and info text on
 * the right stay unstyled. No cursor gymnastics: pi-tui's `extractAnsiCode`
 * strips the SGR codes, so each cell counts as one visible column.
 */
export function renderHalfblockFrame(
  frame: RenderedFrame & { kind: 'halfblock' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const blank = ' '.repeat(size);
  const lines: string[] = [];
  for (let i = 0; i < frame.rows; i++) {
    const cell = frame.cells[i] ?? blank;
    lines.push(` ${cell} ${sep} ${info[i] ?? ''}`);
  }
  return lines;
}

/** Collapse a kaomoji frame to a single ` face | tally ` line to save vertical space. */
export function renderTextFrameCompact(
  frame: RenderedFrame & { kind: 'text' },
  size: number,
  tally: string,
  sep: string,
  width: number,
  measure: TextMeasure,
): string[] {
  const emote = frame.lines[0] ?? '';
  const pad = Math.max(0, size - measure.visibleWidth(emote));
  const cell =
    emote.length > 0 ? `${' '.repeat(Math.floor(pad / 2))}${emote}${' '.repeat(Math.ceil(pad / 2))}` : ' '.repeat(size);
  const tallyWidth = Math.max(4, width - size - 4);
  const trimmed =
    measure.visibleWidth(tally) > tallyWidth ? measure.truncateToWidth(tally, tallyWidth, '\u2026') : tally;
  return [` ${cell} ${sep} ${trimmed}`];
}

/**
 * Render a scene frame as a standalone full-width banner (no info panel
 * beside it). Mirrors the avatar frame renderers minus the ` | info`
 * suffix: half-block emits its cell rows directly; kitty / iTerm2 place the
 * image escape on row 0 and reserve the remaining rows; sixel uses the same
 * save / move-up / paint dance as {@link renderSixelFrame}.
 */
export function renderSceneBanner(frame: RenderedFrame, cols: number): string[] {
  if (frame.kind === 'halfblock') {
    return frame.cells.map((cell) => ` ${cell}`);
  }
  if (frame.kind === 'text') {
    return frame.lines.map((line) => ` ${line}`);
  }
  if (frame.style === 'sixel') {
    const lines: string[] = [];
    for (let i = 0; i < frame.rows - 1; i++) lines.push(' ');
    const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : '';
    let paint = `\x1b7\r${up}`;
    for (let r = 0; r < frame.rows; r++) {
      paint += `\x1b[${cols + 1}X`;
      if (r < frame.rows - 1) paint += '\x1b[1B';
    }
    paint += `${up}\x1b[1C${frame.sequence}\x1b8`;
    lines.push(paint);
    return lines;
  }
  // kitty / iTerm2: the escape on row 0 draws over the next `rows` cell-rows.
  const pad = ' '.repeat(cols);
  const lines: string[] = [];
  for (let i = 0; i < frame.rows; i++) {
    lines.push(i === 0 ? ` ${frame.sequence}${pad}` : ` ${pad}`);
  }
  return lines;
}

export function renderTextFrame(
  frame: RenderedFrame & { kind: 'text' },
  size: number,
  info: string[],
  sep: string,
  measure: TextMeasure,
): string[] {
  const emoteRow = 1;
  const rowCount = Math.max(emoteRow + frame.lines.length, info.length, 3);
  const lines: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const idx = i - emoteRow;
    const emote = idx >= 0 && idx < frame.lines.length ? frame.lines[idx] : '';
    const pad = Math.max(0, size - measure.visibleWidth(emote));
    const cell =
      emote.length > 0
        ? `${' '.repeat(Math.floor(pad / 2))}${emote}${' '.repeat(Math.ceil(pad / 2))}`
        : ' '.repeat(size);
    lines.push(` ${cell} ${sep} ${info[i] ?? ''}`);
  }
  return lines;
}
