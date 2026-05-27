/**
 * Pure color-name resolver for the `color-tags` pi extension.
 *
 * Maps a string color name to an `{ open, close }` pair of ANSI SGR
 * sequences. The rewriter wraps `[c:NAME]content[/c]` spans with these
 * sequences, so the input text turns into colored output when pi's
 * Markdown renderer hands it to chalk / `wrapTextWithAnsi`.
 *
 * Coverage:
 *   - Named-16: `red`, `green`, `bright-red`, `gray`, ... → SGR 30-37/90-97.
 *   - 256-index: `x256-N` or `256-N`, N=0..255 → SGR 38;5;N.
 *   - 24-bit hex: `#RRGGBB` and `#RGB` → SGR 38;2;R;G;B.
 *   - Theme tokens (`accent`, `success`, `mdHeading`, ...) are NOT handled
 *     here - the extension layer wraps with a theme-aware lookup that
 *     calls `theme.getFgAnsi(token)` first, then falls through to this
 *     pure resolver.
 *
 * Close sequence is always `\x1b[39m` (default-foreground), not `\x1b[0m`
 * (full reset). A full reset would clobber bold / italic / theme styling
 * pi's Markdown renderer applied to the surrounding text - we only want
 * to undo the foreground change.
 *
 * Unknown names return `undefined`. The rewriter leaves the literal tag
 * in place on undefined so the failure is visible to the user instead of
 * silently dropped.
 */

/**
 * Control-sequence introducer. Defined as a constant so we can reuse it
 * in regex sources via `new RegExp` template strings without writing
 * literal `\x1b` (oxlint's `no-control-regex` flags those).
 */
export const ESC = '\u001B';

/** Always-default-foreground close sequence shared by every resolved color. */
export const CLOSE_FG = `${ESC}[39m`;

export interface ResolvedColor {
  /** Opening SGR sequence, e.g. `\x1b[31m` for `red`. */
  open: string;
  /** Always `\x1b[39m` - resets foreground without clobbering bold/italic/theme. */
  close: string;
}

/** Named-16 colors with their SGR foreground codes. */
const NAMED_16: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  'bright-black': 90,
  'bright-red': 91,
  'bright-green': 92,
  'bright-yellow': 93,
  'bright-blue': 94,
  'bright-magenta': 95,
  'bright-cyan': 96,
  'bright-white': 97,
  // `gray` / `grey` are conventional aliases for bright-black.
  gray: 90,
  grey: 90,
};

function open16(code: number): string {
  return `${ESC}[${code}m`;
}

function open256(index: number): string {
  return `${ESC}[38;5;${index}m`;
}

function openRgb(r: number, g: number, b: number): string {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

function tryNamed16(name: string): ResolvedColor | undefined {
  const code = NAMED_16[name];
  if (typeof code !== 'number') return undefined;
  return { open: open16(code), close: CLOSE_FG };
}

function try256(name: string): ResolvedColor | undefined {
  // Accept both `x256-N` and `256-N` so users can pick whichever reads
  // more naturally. Strict: digits only, 0..255 inclusive.
  const m = /^(?:x256-|256-)(\d{1,3})$/.exec(name);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0 || n > 255) return undefined;
  return { open: open256(n), close: CLOSE_FG };
}

function tryHex(name: string): ResolvedColor | undefined {
  if (!name.startsWith('#')) return undefined;
  const hex = name.slice(1);
  if (hex.length === 3) {
    if (!/^[0-9a-fA-F]{3}$/.test(hex)) return undefined;
    const r = Number.parseInt(hex[0] + hex[0], 16);
    const g = Number.parseInt(hex[1] + hex[1], 16);
    const b = Number.parseInt(hex[2] + hex[2], 16);
    return { open: openRgb(r, g, b), close: CLOSE_FG };
  }
  if (hex.length === 6) {
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return { open: openRgb(r, g, b), close: CLOSE_FG };
  }
  return undefined;
}

/**
 * Resolve a color name to an SGR `{ open, close }` pair, or `undefined`
 * if the name doesn't match any of the supported shapes. The caller
 * decides what to do with `undefined` - the rewriter leaves the literal
 * tag in place so unknown names are visible instead of silently dropped.
 */
export function resolveColor(rawName: string): ResolvedColor | undefined {
  const name = rawName.trim();
  if (name.length === 0) return undefined;
  // Case-insensitive for the named-16 layer; the other layers care about
  // the literal characters (digits / hex), so we normalise only the
  // named-16 lookup.
  const lower = name.toLowerCase();
  return tryNamed16(lower) ?? try256(lower) ?? tryHex(name);
}

/**
 * Names this pure resolver knows about, surfaced for the system-prompt
 * builder and for tests. The list is illustrative, not exhaustive - the
 * `x256-N` and `#RRGGBB` shapes also resolve.
 */
export const NAMED_COLOR_NAMES: readonly string[] = Object.keys(NAMED_16);
