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

/**
 * Normalize a multi-line body destined for injection: strip trailing
 * horizontal whitespace from every line, collapse runs of 3+ newlines down
 * to a single blank line, and trim the ends. Unlike {@link clampWords} this
 * PRESERVES paragraph structure (single blank lines survive) - it only removes
 * the bloat that inflates the injected block and the char-budget accounting
 * (`budget.ts` counts `body.length`). Returns `''` for a whitespace-only body,
 * which the caller treats as "nothing to inject".
 */
export function normalizeInjectedBody(s: string): string {
  return s
    .replace(/[^\S\n]+$/gm, '') // drop trailing spaces/tabs on each line
    .replace(/\n{3,}/g, '\n\n') // collapse blank-line runs to one blank line
    .trim();
}
