/**
 * Tiny shared text helpers for the `roleplay` extension's pure modules.
 *
 * No pi imports - unit-testable under `vitest`.
 */

/**
 * Trim `s` to at most `max` chars WITHOUT cutting a word in half. Collapses
 * internal whitespace first; when the cap lands mid-word, backs up to the
 * last whole word and strips any trailing separator so a clamped value reads
 * clean (`"...berries, whipp"` -> `"...berries"`) instead of showing a
 * fragment. Used for single-line values (fact names, beat summaries) - it
 * collapses newlines, so do not pass a multi-line block through it whole.
 */
export function clampWords(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  // Only back up when the cap fell inside a word (the next char is non-space).
  if (/\S/.test(t.charAt(max))) {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  return cut.replace(/[\s,;:.-]+$/, '').trimEnd();
}
