/**
 * Pure terminal image-sequence encoders for the `avatar` extension.
 *
 * Two protocols, both emitting a single string the widget paints:
 *   - kitty graphics protocol (APC `_G`), chunked at 4096 base64 bytes.
 *   - iTerm2 inline images (OSC 1337 `File=`).
 *
 * Sizing is expressed in terminal cells (`cols` x `rows`) so the caller
 * controls the on-screen footprint. No pi imports - unit-testable.
 */

const ESC = '\x1b';
/** APC string terminator used by the kitty graphics protocol. */
const ST = '\x1b\\';
/** Max base64 payload per kitty transmission chunk. */
const KITTY_CHUNK = 4096;

export interface ImageCellSize {
  /** Display width in terminal columns. */
  cols: number;
  /** Display height in terminal rows. */
  rows: number;
}

/**
 * Encode a PNG (already base64) as a kitty graphics-protocol sequence
 * that transmits and displays in one shot (`a=T`, `f=100`). `C=1` keeps
 * the cursor from advancing past the image; `q=2` suppresses the
 * terminal's acknowledgement so it can't corrupt the TUI stream. Large
 * payloads are split into `m=1` continuation chunks per spec.
 */
export function encodeKittyImage(base64: string, size: ImageCellSize): string {
  const control = `a=T,f=100,c=${size.cols},r=${size.rows},C=1,q=2`;

  if (base64.length <= KITTY_CHUNK) {
    return `${ESC}_G${control};${base64}${ST}`;
  }

  const parts: string[] = [];
  for (let offset = 0; offset < base64.length; offset += KITTY_CHUNK) {
    const chunk = base64.slice(offset, offset + KITTY_CHUNK);
    const more = offset + KITTY_CHUNK < base64.length ? 1 : 0;
    if (offset === 0) {
      parts.push(`${ESC}_G${control},m=1;${chunk}${ST}`);
    } else {
      parts.push(`${ESC}_Gm=${more};${chunk}${ST}`);
    }
  }
  return parts.join('');
}

/**
 * Encode a PNG (already base64) as an iTerm2 inline-image sequence.
 * `width`/`height` are given in cells; `preserveAspectRatio=1` letterboxes
 * within that box. `byteLength` (the decoded PNG size) is advertised via
 * `size=` when provided - iTerm2 treats it as a hint only.
 */
export function encodeITermImage(base64: string, size: ImageCellSize, byteLength?: number): string {
  const args = ['inline=1', `width=${size.cols}`, `height=${size.rows}`, 'preserveAspectRatio=1'];
  if (byteLength !== undefined && byteLength > 0) {
    args.push(`size=${byteLength}`);
  }
  return `${ESC}]1337;File=${args.join(';')}:${base64}\x07`;
}
