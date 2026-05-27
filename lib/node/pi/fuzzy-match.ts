/**
 * fzf-style subsequence fuzzy match used by the reverse-search overlay
 * in `cross-session-history.ts`.
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 *
 * Pattern is matched against text as a subsequence: each pattern char
 * must appear in the text in order, but not necessarily contiguously.
 * Match is case-insensitive (case-exact matches earn a small bonus).
 *
 * Scoring rewards the things a human would call a "good match":
 * - Consecutive run of pattern chars (so `gst` in `git status`
 *   ranks higher than spread-out matches).
 * - Match starts at the beginning of a word (after space, `/`, `-`,
 *   `_`, `.`, `\t`, or at index 0).
 * - Case-exact match on top of the case-insensitive base.
 *
 * Returns `null` when the pattern can't be matched at all, so callers
 * can filter the list down to ranked hits.
 */

export interface FuzzyMatch {
  /** Total match score; higher is better. Suitable for `sort((a, b) => b.score - a.score)`. */
  score: number;
  /** Indices into `text` of the matched characters (in order). */
  indices: number[];
}

/**
 * `true` when `ch` looks like the end of a word - so the next char is
 * the start of a new word and earns the "word-boundary" bonus. The
 * `undefined` case (i.e. `text[-1]`, before the string) counts as a
 * boundary so a pattern that matches at index 0 always gets the bonus.
 */
function isWordBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return ch === ' ' || ch === '\t' || ch === '-' || ch === '_' || ch === '/' || ch === '.';
}

/**
 * Match `pattern` against `text` as a subsequence and return a score
 * + matched-char positions, or `null` when not all pattern chars
 * appear in order. An empty pattern matches everything with score 0
 * and no indices - callers can short-circuit to "show the full list."
 */
export function fuzzyMatch(pattern: string, text: string): FuzzyMatch | null {
  if (pattern.length === 0) return { score: 0, indices: [] };

  const pLower = pattern.toLowerCase();
  const tLower = text.toLowerCase();

  const indices: number[] = [];
  let pIdx = 0;
  let lastMatchIdx = -2;
  let score = 0;

  for (let tIdx = 0; tIdx < tLower.length && pIdx < pLower.length; tIdx++) {
    if (tLower[tIdx] !== pLower[pIdx]) continue;

    let charScore = 1;
    if (tIdx === lastMatchIdx + 1) charScore += 5;
    if (isWordBoundary(text[tIdx - 1])) charScore += 3;
    if (text[tIdx] === pattern[pIdx]) charScore += 1;

    indices.push(tIdx);
    score += charScore;
    lastMatchIdx = tIdx;
    pIdx++;
  }

  if (pIdx < pLower.length) return null;
  return { score, indices };
}
