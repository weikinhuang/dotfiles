/**
 * Shared helpers for appending a section to a system prompt.
 *
 * Several extensions bolt a markdown section onto the base system prompt
 * from a `before_agent_start` chain step and must stay idempotent so
 * `/reload` and other re-entry paths don't double-inject. Two idempotency
 * strategies were duplicated across the tree; this centralises both:
 *
 *   - {@link appendSectionByHeading} keys off a stable heading line (used
 *     when the section text itself varies run-to-run, e.g. a vocabulary
 *     list, so a full-text suffix check would miss).
 *   - {@link appendSectionOnce} keys off the (trimmed) section text as a
 *     suffix (used when the section is stable and callers also want the
 *     appended text trimmed).
 *
 * Pure module - no pi imports.
 */

/**
 * Append `section` to `base`, separated by a blank line. Idempotent on
 * `heading`: if `base` already contains that heading line the base is
 * returned unchanged. `section` is appended verbatim (not trimmed); an
 * empty/whitespace-only base returns `section` as-is.
 */
export function appendSectionByHeading(base: string, section: string, heading: string): string {
  if (base.includes(heading)) return base;
  const trimmed = base.replace(/\s+$/, '');
  if (trimmed.length === 0) return section;
  return `${trimmed}\n\n${section}`;
}

/**
 * Append `section` to `base`, separated by a blank line. The section is
 * trimmed first; an empty section returns `base` unchanged and an
 * empty-ish base returns the trimmed section. Idempotent when `base`
 * already ends with the trimmed section (a defensive re-entry guard so
 * the prompt stays byte-stable across turns).
 */
export function appendSectionOnce(base: string, section: string): string {
  const b = base ?? '';
  const add = (section ?? '').trim();
  if (!add) return b;
  if (!b.trim()) return add;
  if (b.trimEnd().endsWith(add)) return b;
  return `${b.replace(/\s+$/, '')}\n\n${add}`;
}
