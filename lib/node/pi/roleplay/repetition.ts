/**
 * Pure repetition / anti-slop detection for the `roleplay` extension.
 *
 * Token-level repetition is already handled by the sampler
 * (`presence_penalty` / `frequency_penalty`). What a sampler cannot see
 * is MULTI-TURN phrase repetition: a model reusing the same 5-word
 * cadence or stock sensory phrase across consecutive replies. This
 * module finds those echoes so the extension can inject a one-line
 * "vary your phrasing" nudge - additive only, it never rewrites output.
 *
 * Roleplay-aware: phrases that appear in the active cast's character
 * sheets (speech tics, verbatim canon lines) are EXCLUDED, so a
 * signature catchphrase a persona is supposed to repeat ("I swear on
 * this gun in my hand") is never flagged. The extension builds the
 * exclusion set from the loaded character bodies via
 * {@link buildExcludeSet} and passes it to {@link detectRepetition}.
 *
 * No pi imports - unit-tested under vitest.
 */

/** Knobs for {@link detectRepetition} (resolved from the roleplay config). */
export interface RepetitionConfig {
  /** Length of the word n-gram compared across replies. */
  ngram: number;
  /** How many of the most-recent assistant replies to scan. */
  window: number;
  /** Occurrences of an n-gram across the window before it is flagged. */
  minCount: number;
}

/** Hard floor on the flag threshold - a 1-occurrence "repeat" is not a repeat. */
const MIN_FLAG_COUNT = 2;

/**
 * Normalize a block of prose into a flat lowercased word list for
 * n-gram comparison. Markdown emphasis markers and punctuation are
 * dropped so `*I lean back*` and `I lean back.` compare equal; word
 * boundaries collapse runs of whitespace. Unicode letters/digits are
 * kept (personas use non-ASCII names).
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[*_`~]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** All contiguous `n`-word n-grams of `words` (space-joined). Empty when too short. */
export function ngrams(words: readonly string[], n: number): string[] {
  const size = Math.max(2, Math.floor(n));
  if (words.length < size) return [];
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) {
    out.push(words.slice(i, i + size).join(' '));
  }
  return out;
}

/**
 * Build the exclusion set: every `ngram`-gram that appears in any of the
 * supplied character-sheet bodies. A candidate repetition that matches
 * one of these is a deliberate signature phrase, not slop, and is
 * suppressed.
 */
export function buildExcludeSet(sheetBodies: readonly string[], ngram: number): Set<string> {
  const set = new Set<string>();
  for (const body of sheetBodies) {
    for (const g of ngrams(normalizeWords(body), ngram)) set.add(g);
  }
  return set;
}

/**
 * Detect phrases repeated across the most-recent assistant replies.
 *
 * Scans the last `window` entries of `assistantTexts`, counts every
 * `ngram`-gram (skipping any in `exclude`), and returns the phrases that
 * occur at least `minCount` times, most-repeated first. Returns an empty
 * array when nothing repeats.
 */
export function detectRepetition(
  assistantTexts: readonly string[],
  exclude: ReadonlySet<string>,
  cfg: RepetitionConfig,
): string[] {
  const window = assistantTexts.slice(-Math.max(1, Math.floor(cfg.window)));
  const counts = new Map<string, number>();
  for (const text of window) {
    for (const g of ngrams(normalizeWords(text), cfg.ngram)) {
      if (exclude.has(g)) continue;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  const threshold = Math.max(MIN_FLAG_COUNT, Math.floor(cfg.minCount));
  return [...counts.entries()]
    .filter(([, c]) => c >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([phrase]) => phrase);
}

/** Max phrases named in a single nudge so the reminder stays short. */
const NUDGE_PHRASE_LIMIT = 3;

/**
 * Render the nudge body for the detected phrases, or `null` when there
 * is nothing to say (so the caller injects nothing). The block is framed
 * as a directive the model acts on this turn, not as scene content.
 */
export function formatRepetitionNudge(phrases: readonly string[], limit: number = NUDGE_PHRASE_LIMIT): string | null {
  if (phrases.length === 0) return null;
  const shown = phrases
    .slice(0, Math.max(1, limit))
    .map((p) => `"${p}"`)
    .join(', ');
  return (
    `You have reused this phrasing in recent replies: ${shown}. ` +
    'Vary your wording, imagery, and sentence structure this turn - do not echo your earlier replies.'
  );
}
