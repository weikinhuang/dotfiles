/**
 * Pure keyword matching for the roleplay lorebook (SillyTavern "World
 * Info" equivalent).
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * A `lore` entry fires when:
 *   - it is `constant` (always fires, ignoring triggers), OR
 *   - any of its primary `triggers` is present in the scan text (OR), and
 *   - its optional `secondaryKeys` gate passes under `secondaryMode`:
 *       AND = every secondary key present,
 *       OR  = at least one present,
 *       NOT = none present,
 *       NOT_ALL = not every one present (fires unless ALL are present).
 *
 * Matching is whole-word and case-insensitive: a trigger only fires on a
 * token boundary, so `"RI"` matches `"RI"` / `"(RI)"` but not `"spring"`.
 * Multi-word triggers (`"Rhodes Island"`) and punctuation-bearing keys
 * (`"Dr. Kal'tsit"`) are matched literally between boundaries.
 *
 * Word characters for the boundary test are letters, digits, AND combining
 * marks (`\p{M}`), so `"cafe"` does not fire inside `"cafe\u0301"`.
 *
 * Scripts written without spaces (Han, Hiragana, Katakana, Thai, Lao,
 * Khmer, Myanmar) have no token boundaries, so the boundary requirement is
 * dropped on any side where the keyword's edge character is in one of those
 * scripts (`"阿米娅"` fires in `"阿米娅说"`). A neighboring character from
 * such a script also counts as a boundary for other keywords, so `"RI"`
 * fires in `"罗德岛RI基地"`. Hangul uses spaces and keeps strict boundaries.
 */

import { type LoreMeta, type RoleplayEntry } from './store.ts';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex char-class body for word characters (letters, digits, combining marks). */
const WORD_CLASS = String.raw`\p{L}\p{N}\p{M}`;
/** Regex char-class body for scripts written without inter-word spaces. */
const NO_SPACE_CLASS = String.raw`\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}`;
const NO_SPACE_RE = new RegExp(`^[${NO_SPACE_CLASS}]$`, 'u');
const LEFT_BOUNDARY = `(?<=^|[^${WORD_CLASS}]|[${NO_SPACE_CLASS}])`;
const RIGHT_BOUNDARY = `(?=$|[^${WORD_CLASS}]|[${NO_SPACE_CLASS}])`;

/**
 * Whole-word, case-insensitive presence test. A keyword matches only when
 * flanked by non-word characters (or string edges), so short acronyms don't
 * match inside longer words. The boundary is not required on a side whose
 * edge character belongs to a no-space script (see module doc).
 */
export function hasKeyword(haystack: string, keyword: string): boolean {
  const k = keyword.trim();
  if (k.length === 0) return false;
  const chars = Array.from(k);
  const left = NO_SPACE_RE.test(chars[0]) ? '' : LEFT_BOUNDARY;
  const right = NO_SPACE_RE.test(chars[chars.length - 1]) ? '' : RIGHT_BOUNDARY;
  const re = new RegExp(`${left}${escapeRegExp(k)}${right}`, 'iu');
  return re.test(haystack);
}

function secondaryPasses(meta: LoreMeta, scanText: string): boolean {
  if (meta.secondaryKeys.length === 0) return true;
  const present = meta.secondaryKeys.map((k) => hasKeyword(scanText, k));
  switch (meta.secondaryMode) {
    case 'AND':
      return present.every(Boolean);
    case 'OR':
      return present.some(Boolean);
    case 'NOT':
      return !present.some(Boolean);
    case 'NOT_ALL':
      return !present.every(Boolean);
  }
}

/** True when a single lore entry fires against the scan text. */
export function loreFires(entry: RoleplayEntry, scanText: string): boolean {
  const meta = entry.lore;
  if (!meta) return false;
  // Author kill-switch: a disabled entry never fires, not even `constant`.
  if (meta.enabled === false) return false;
  if (meta.constant) return true;
  if (meta.triggers.length === 0) return false;
  const primary = meta.triggers.some((t) => hasKeyword(scanText, t));
  if (!primary) return false;
  return secondaryPasses(meta, scanText);
}

/**
 * Filter `entries` to the `lore` entries that fire against `scanText`,
 * preserving input order. Non-lore entries are ignored.
 */
export function matchLore(entries: readonly RoleplayEntry[], scanText: string): RoleplayEntry[] {
  return entries.filter((e) => e.kind === 'lore' && loreFires(e, scanText));
}
