/**
 * Pure helpers for the `image-ref` autocomplete provider.
 *
 * The extension stacks a custom provider (via `ctx.ui.addAutocomplete-
 * Provider`) so typing the `&` marker pops a file-path completion menu
 * scoped to image files - the same `&./mock.png` token the `input`
 * handler later turns into an `<image>` attachment. This module owns the
 * pure parts: finding the `&`-marked token under the cursor, splitting
 * it into the directory to read and the basename fragment to match, and
 * shaping directory entries into completion items whose `value` keeps
 * the typed marker + path prefix intact (so the editor's built-in
 * `applyCompletion` splices them in correctly).
 *
 * The filesystem read (`readdir`) lives in the extension shell; this
 * module is pure (only `node:path` + the peer tilde helper) so the token
 * parsing and candidate shaping are unit-testable without touching disk.
 */

import { isAbsolute, resolve } from 'node:path';

import { expandTilde } from '../path-expand.ts';
import { MARKER } from './extract.ts';

/**
 * Image extensions matching the four MIMEs {@link import('./detect.ts')}
 * sniffs. The completion menu filters on extension (cheap, no bytes);
 * the real byte sniff still gates attachment at `input` time, so a
 * mis-named file completed here just stays as text when sent.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** A completion candidate, shaped like pi-tui's `AutocompleteItem`. */
export interface CompletionItem {
  /** Text spliced into the editor (carries the `&` marker + path prefix). */
  value: string;
  /** Menu label (basename, with a trailing `/` for directories). */
  label: string;
}

/** One directory entry, as the shell hands it in after a `readdir`. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

/** The `&`-marked token under the cursor, split for lookup + display. */
export interface MarkerToken {
  /** Partial path after the marker, exactly as typed (may be `''`). */
  partial: string;
  /** Literal directory prefix incl. trailing slash, as typed (`''` when none). */
  dirPrefix: string;
  /** Basename fragment to match within the directory. */
  base: string;
}

/** Escape a string for safe interpolation into a `RegExp` source. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A whitespace-delimited token at the end of the text that begins with
// the marker. The captured group stops at the next marker so `&a &b`
// reads as two tokens. MARKER is expected to be a single non-space char.
const MARKER_RE = new RegExp(`(?:^|\\s)${escapeRe(MARKER)}([^\\s${escapeRe(MARKER)}]*)$`);

/**
 * Find the marker-prefixed token ending at the cursor and split it into
 * the directory prefix (as typed) and the basename fragment to match.
 * Returns `null` when the cursor is not sitting in a marked token.
 */
export function extractMarkerToken(textBeforeCursor: string): MarkerToken | null {
  const match = MARKER_RE.exec(textBeforeCursor);
  if (!match) return null;
  const partial = match[1] ?? '';
  const slash = partial.lastIndexOf('/');
  const dirPrefix = slash === -1 ? '' : partial.slice(0, slash + 1);
  const base = slash === -1 ? partial : partial.slice(slash + 1);
  return { partial, dirPrefix, base };
}

/** The prefix string the editor replaces (marker + typed partial). */
export function completionPrefix(token: MarkerToken): string {
  return `${MARKER}${token.partial}`;
}

/** Resolve the absolute directory whose entries should be listed. */
export function resolveReadDir(token: MarkerToken, cwd: string, homedir: string): string {
  const expanded = expandTilde(token.dirPrefix || '.', homedir);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** True when `name` ends with a known image extension. */
export function isImageFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Turn directory entries into completion items for `token`.
 *
 * Directories are always offered (so the user can drill down); regular
 * files only when they carry an image extension. Matching is a
 * case-insensitive prefix on the basename fragment. Hidden entries
 * (leading `.`) are surfaced only once the user types a leading `.`.
 * Directories sort first, then alphabetically; the list is capped at
 * `maxItems`.
 */
export function buildCompletionItems(entries: DirEntry[], token: MarkerToken, maxItems: number): CompletionItem[] {
  const base = token.base.toLowerCase();
  const showHidden = token.base.startsWith('.');
  const matched = entries.filter((entry) => {
    if (entry.name === '.' || entry.name === '..') return false;
    if (!showHidden && entry.name.startsWith('.')) return false;
    if (!entry.isDirectory && !isImageFile(entry.name)) return false;
    return entry.name.toLowerCase().startsWith(base);
  });
  matched.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return matched.slice(0, maxItems).map((entry) => {
    const suffix = entry.isDirectory ? '/' : '';
    return {
      value: `${MARKER}${token.dirPrefix}${entry.name}${suffix}`,
      label: `${entry.name}${suffix}`,
    };
  });
}
