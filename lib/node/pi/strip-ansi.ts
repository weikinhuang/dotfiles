/**
 * ANSI SGR stripper shared by pi helpers.
 *
 * Pure module - no pi imports. The regex matches CSI sequences ending
 * in `m` (`\x1b[…m`), narrow enough that text containing other ANSI
 * controls (cursor moves etc.) is left alone.
 */

const ESC = '\u001b';

const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Strip every ANSI SGR (`\x1b[…m`) sequence from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(SGR_PATTERN, '');
}
