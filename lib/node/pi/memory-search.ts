/**
 * Pure ranking helpers for the memory extension's `search` action, its
 * save-time duplicate check, and per-turn recall.
 *
 * No pi imports - testable under `vitest`.
 *
 * The query is TOKENIZED first (see {@link tokenizeQuery}): a
 * natural-language prompt like "tell me about the auth mock policy" is
 * scored on its content words (auth / mock / policy), not as one doomed
 * whole-string subsequence. This is the difference between recall that
 * fires on real sentences and recall that only fires on hand-typed
 * keywords. Each surviving token contributes:
 *   - a fuzzy (subsequence) match on the name, weighted high;
 *   - a fuzzy match on the description, weighted medium;
 *   - a substring match on the body, weighted low and only consulted
 *     lazily when name+description didn't already clear a threshold (so
 *     we skip a disk read for every entry on every search).
 * Token scores are summed.
 *
 * This is the cheap version of a multi-pass recall ranker: enough signal
 * to order the index sensibly without embeddings or a second model call.
 */

import { fuzzyMatch } from './fuzzy-match.ts';
import { type MemoryEntry } from './memory-reducer.ts';

export interface ScoredMemory {
  entry: MemoryEntry;
  score: number;
}

/** Weight applied to a name match - the strongest signal. */
const NAME_WEIGHT = 3;
/** Weight applied to a description match. */
const DESC_WEIGHT = 2;
/** Weight applied to a body substring match - the weakest signal. */
const BODY_WEIGHT = 1;

/**
 * Default name+description score under which the body is read and a
 * substring signal added. Picked so a clear name/description hit skips
 * the disk read while a weak (or zero) header score still falls through
 * to "body matches too" behaviour.
 */
const DEFAULT_BODY_READ_THRESHOLD = 6;

/** Tokens shorter than this are dropped before scoring (kills "i", "a"). */
const MIN_TOKEN_LEN = 2;

/**
 * Fraction of a candidate's own name-score that an existing memory must
 * reach to count as a near-duplicate. Calibrated against the candidate's
 * self-score so it is independent of the fuzzy scorer's absolute scale:
 * ~0.6 flags an entry sharing most of the candidate's name tokens.
 */
const DEFAULT_SIMILARITY_FRACTION = 0.6;

/**
 * Common English function words dropped from a query so they don't add
 * uniform noise across the whole index (and falsely lift non-matches over
 * `minScore`). Intentionally conservative - domain-ish verbs (build, run,
 * test, fix) are kept since they often ARE the content word.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'done',
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'whom',
  'which',
  'whose',
  'can',
  'could',
  'would',
  'should',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'i',
  'me',
  'my',
  'mine',
  'we',
  'us',
  'our',
  'you',
  'your',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'the',
  'about',
  'tell',
  'show',
  'please',
  'help',
  'let',
  'need',
  'want',
  'give',
  'so',
  'if',
  'then',
  'than',
  'from',
  'into',
  'out',
  'up',
  'down',
  'over',
  'under',
  'there',
  'here',
  // Contraction fragments left behind after splitting on the apostrophe
  // (you're -> re, i've -> ve, i'll -> ll): pure noise that fuzzy/prefix
  // matches broadly. The 1-char tails (s, d, m, t) already fall to MIN_TOKEN_LEN.
  're',
  've',
  'll',
  // Generic connectives kept below MIN_TOKEN_LEN's reach but semantically empty.
  'also',
  'like',
  'use',
  'using',
  'ones',
  'them',
  'they',
]);

/**
 * Split a query into lowercased significant tokens: break on any
 * non-alphanumeric run (so `auth-mock` and `grafana.internal/d/api` split
 * into words too), then drop stopwords and tokens shorter than
 * `MIN_TOKEN_LEN`. Falls back to the whole trimmed query as a single token
 * when filtering would leave nothing (e.g. a 1-char id query, or an
 * all-stopword string) so a short deliberate query never silently matches
 * nothing.
 */
export function tokenizeQuery(query: string): string[] {
  const lower = query.trim().toLowerCase();
  if (lower.length === 0) return [];
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
  return tokens.length > 0 ? tokens : [lower];
}

/** Fuzzy score of `token` against `text`, or 0 when it doesn't match. */
function fuzzyScore(token: string, text: string): number {
  const m = fuzzyMatch(token, text);
  return m ? m.score : 0;
}

/** Summed name+description fuzzy score across all query tokens. */
function headerScore(tokens: readonly string[], entry: MemoryEntry): number {
  let score = 0;
  for (const t of tokens) {
    score += NAME_WEIGHT * fuzzyScore(t, entry.name) + DESC_WEIGHT * fuzzyScore(t, entry.description);
  }
  return score;
}

/** Body signal: weighted count of query tokens present as substrings. */
function bodyScore(tokens: readonly string[], body: string): number {
  const hay = body.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits += 1;
  return BODY_WEIGHT * hits;
}

/**
 * Combined name+description+body score for a single entry against the
 * pre-tokenized query. `getBody` is only called when the name+description
 * score is below `bodyReadThreshold`, so a strong header hit never
 * triggers a disk read.
 */
function scoreEntry(
  entry: MemoryEntry,
  getBody: (e: MemoryEntry) => string | null,
  tokens: readonly string[],
  bodyReadThreshold: number,
): number {
  let score = headerScore(tokens, entry);
  if (score < bodyReadThreshold) {
    const body = getBody(entry);
    if (body) score += bodyScore(tokens, body);
  }
  return score;
}

/**
 * Rank `entries` against `query`, dropping zero-score entries. Sorted by
 * score descending. The query is tokenized first (see {@link tokenizeQuery}).
 * `getBody` is lazy: only called for entries whose name+description score
 * is below `opts.bodyReadThreshold`.
 */
export function searchMemories(
  entries: readonly MemoryEntry[],
  getBody: (e: MemoryEntry) => string | null,
  query: string,
  opts: { bodyReadThreshold?: number } = {},
): ScoredMemory[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const threshold = opts.bodyReadThreshold ?? DEFAULT_BODY_READ_THRESHOLD;

  const scored: ScoredMemory[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, getBody, tokens, threshold);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Find existing memories that look similar to a save candidate. `existing`
 * must already be filtered to the same scope+type as the candidate by the
 * caller. Queries on the candidate's name (the strongest discriminator)
 * via the same tokenized scorer as {@link searchMemories}, and returns the
 * top `opts.max` hits at or above a threshold calibrated as a fraction of
 * the candidate's own name self-score (scale-independent).
 */
export function findSimilarMemories(
  candidate: { name: string; description: string; body: string },
  existing: readonly MemoryEntry[],
  getBody: (e: MemoryEntry) => string | null,
  opts: { threshold?: number; max?: number } = {},
): ScoredMemory[] {
  const tokens = tokenizeQuery(candidate.name);
  if (tokens.length === 0) return [];
  // The maximum name-component score an identical-named entry would reach;
  // a near-duplicate must clear a fraction of it.
  const selfNameScore = NAME_WEIGHT * tokens.reduce((s, t) => s + fuzzyScore(t, candidate.name), 0);
  // Guard against a degenerate self-score: a default threshold of
  // `0.6 * 0` collapses to 0, which every scored entry clears, turning
  // the near-duplicate check into "match everything". Bail unless the
  // caller pinned an explicit threshold.
  if (opts.threshold === undefined && selfNameScore <= 0) return [];
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_FRACTION * selfNameScore;
  const max = opts.max ?? 3;

  const scored = searchMemories(existing, getBody, candidate.name);
  return scored.filter((s) => s.score >= threshold).slice(0, max);
}
