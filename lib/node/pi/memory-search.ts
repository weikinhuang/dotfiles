/**
 * Pure ranking helpers for the memory extension's `search` action, its
 * save-time duplicate check, and the capture-assist "already saved?" check.
 *
 * No pi imports - testable under `vitest`.
 *
 * The query is TOKENIZED first (see {@link tokenizeQuery}): a
 * natural-language prompt like "tell me about the auth mock policy" is
 * scored on its content words (auth / mock / policy), not as one whole
 * string. Each token is matched as a word, not a loose subsequence (a
 * subsequence like t..e..s..t matches almost any long description):
 *   - whole word > word prefix > mid-word substring (4+ chars only);
 *   - weighted high on the name, medium on the description, and low on
 *     the body, which is only read lazily when name+description didn't
 *     already clear a threshold (so a strong header hit skips a disk read).
 * Token scores are summed. `searchMemories` then drops results far below
 * the best hit and caps the list.
 *
 * Cheap lexical ranking: enough signal to order the index sensibly without
 * embeddings or a second model call.
 */

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
const DEFAULT_BODY_READ_THRESHOLD = 30;

/** Results scoring below this fraction of the best hit are dropped. */
const DEFAULT_MIN_RELATIVE_SCORE = 0.15;

/** Most results `searchMemories` returns by default. */
const DEFAULT_SEARCH_LIMIT = 10;

/** Mid-word substring hits only count for tokens at least this long. */
const MIN_INFIX_TOKEN_LEN = 4;

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

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[a-z0-9]/.test(ch);

/**
 * Best word-aware match of a lowercased `token` in `text`: a whole word
 * scores 3x its length, a word prefix 2x, a mid-word substring 1x (only
 * for tokens of {@link MIN_INFIX_TOKEN_LEN}+ chars), otherwise 0.
 */
export function tokenScore(token: string, text: string): number {
  if (token.length === 0) return 0;
  const hay = text.toLowerCase();
  const whole = 3 * token.length;
  let best = 0;
  for (let i = hay.indexOf(token); i !== -1; i = hay.indexOf(token, i + 1)) {
    const startsWord = !isWordChar(hay[i - 1]);
    const endsWord = !isWordChar(hay[i + token.length]);
    let s = 0;
    if (startsWord && endsWord) s = whole;
    else if (startsWord) s = 2 * token.length;
    else if (token.length >= MIN_INFIX_TOKEN_LEN) s = token.length;
    if (s > best) best = s;
    if (best === whole) break;
  }
  return best;
}

/** Summed name+description score across all query tokens. */
function headerScore(tokens: readonly string[], entry: MemoryEntry): number {
  let score = 0;
  for (const t of tokens) {
    score += NAME_WEIGHT * tokenScore(t, entry.name) + DESC_WEIGHT * tokenScore(t, entry.description);
  }
  return score;
}

/** Body signal: summed word-aware token score, weighted low. */
function bodyScore(tokens: readonly string[], body: string): number {
  let score = 0;
  for (const t of tokens) score += BODY_WEIGHT * tokenScore(t, body);
  return score;
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

export interface SearchOptions {
  /** Header score under which the body is read. */
  bodyReadThreshold?: number;
  /** Drop results scoring below this fraction of the best hit (0 keeps all). */
  minRelativeScore?: number;
  /** Maximum number of results (default 10). */
  limit?: number;
}

/**
 * Rank `entries` against `query`, dropping zero-score entries and those far
 * below the best hit, sorted by score descending and capped at
 * `opts.limit`. The query is tokenized first (see {@link tokenizeQuery}).
 * `getBody` is lazy: only called for entries whose name+description score
 * is below `opts.bodyReadThreshold`.
 */
export function searchMemories(
  entries: readonly MemoryEntry[],
  getBody: (e: MemoryEntry) => string | null,
  query: string,
  opts: SearchOptions = {},
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
  if (scored.length === 0) return scored;
  const floor = scored[0].score * (opts.minRelativeScore ?? DEFAULT_MIN_RELATIVE_SCORE);
  return scored.filter((s) => s.score >= floor).slice(0, opts.limit ?? DEFAULT_SEARCH_LIMIT);
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
  const selfNameScore = NAME_WEIGHT * tokens.reduce((s, t) => s + tokenScore(t, candidate.name), 0);
  // Guard against a degenerate self-score: a default threshold of
  // `0.6 * 0` collapses to 0, which every scored entry clears, turning
  // the near-duplicate check into "match everything". Bail unless the
  // caller pinned an explicit threshold.
  if (opts.threshold === undefined && selfNameScore <= 0) return [];
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_FRACTION * selfNameScore;
  const max = opts.max ?? 3;

  const scored = searchMemories(existing, getBody, candidate.name, {
    minRelativeScore: 0,
    limit: Number.POSITIVE_INFINITY,
  });
  return scored.filter((s) => s.score >= threshold).slice(0, max);
}
