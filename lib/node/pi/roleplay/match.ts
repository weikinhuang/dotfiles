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
 *       NOT = none present.
 *
 * Matching is whole-word and case-insensitive: a trigger only fires on a
 * token boundary, so `"RI"` matches `"RI"` / `"(RI)"` but not `"spring"`.
 * Multi-word triggers (`"Rhodes Island"`) and punctuation-bearing keys
 * (`"Dr. Kal'tsit"`) are matched literally between boundaries.
 */

import { type LoreMeta, type RoleplayEntry } from './store.ts';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive presence test. A keyword matches only when
 * flanked by non-letter/non-digit characters (or string edges), so short
 * acronyms don't match inside longer words.
 */
export function hasKeyword(haystack: string, keyword: string): boolean {
  const k = keyword.trim();
  if (k.length === 0) return false;
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(k)}(?:[^\\p{L}\\p{N}]|$)`, 'iu');
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
  }
}

/** True when a single lore entry fires against the scan text. */
export function loreFires(entry: RoleplayEntry, scanText: string): boolean {
  const meta = entry.lore;
  if (!meta) return false;
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
