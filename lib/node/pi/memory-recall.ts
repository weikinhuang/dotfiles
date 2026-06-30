/**
 * Per-turn memory recall: score the saved memory index against the
 * current user prompt and surface the best matches.
 *
 * No pi imports - testable under `vitest`.
 *
 * Where {@link ./memory-prompt.ts}'s `formatMemoryIndex` injects the
 * STATIC index into the cached system prompt (it only changes on
 * save/update/remove), this module computes the DYNAMIC, per-prompt
 * relevance that rides the TURN via the `context` hook. Keeping the two
 * apart is the load-bearing cache decision: the system-prompt prefix
 * stays byte-stable turn-to-turn, so the provider's KV cache survives.
 *
 * Two output modes, both driven from the same ranking:
 *   - MARKING (default): `markedIds` lists the most-relevant ids so the
 *     extension can nudge the model to `memory read` them. Costs a few
 *     dozen tokens in the turn, never in the cached prefix.
 *   - BODY INJECTION (`injectBodies`): `block` renders the top-K bodies
 *     under a `## Relevant memory` heading (each truncated to fit
 *     `bodyBudget`) so the model skips the `read` round-trip.
 *
 * The scorer is pluggable (`opts.scorer`) so a future embedding pass can
 * slot in without touching callers; it defaults to the shared lexical
 * {@link searchMemories} ranker.
 */

import { type MemoryEntry, type MemoryState } from './memory-reducer.ts';
import { type ScoredMemory, searchMemories } from './memory-search.ts';
import { truncate } from './shared.ts';

/** Pluggable scorer: rank `entries` against `query`, best first. */
export type RecallScorer = (
  entries: readonly MemoryEntry[],
  getBody: (e: MemoryEntry) => string | null,
  query: string,
) => ScoredMemory[];

export interface RecallOptions {
  /** Max number of matches to surface. Default 3. */
  topK?: number;
  /**
   * Minimum fused score an entry must clear to be surfaced. Default 1 -
   * a single weak signal (e.g. a lone body substring hit at
   * `BODY_WEIGHT`) is enough to mark, but a zero-score non-match is not.
   */
  minScore?: number;
  /** Render the bodies block instead of marking only. Default false. */
  injectBodies?: boolean;
  /** Char cap for each injected body when `injectBodies`. Default 1500. */
  bodyBudget?: number;
  /**
   * Ranking function. Defaults to the shared lexical {@link searchMemories}
   * scorer; override to slot in an embedding pass later.
   */
  scorer?: RecallScorer;
}

export interface RecallResult {
  /** Ids of the top matches, ranked best-first. Always returned. */
  markedIds: string[];
  /**
   * Rendered `## Relevant memory` block (top-K bodies, each truncated to
   * `bodyBudget`), or `null` when `injectBodies` is off or there is
   * nothing to render.
   */
  block: string | null;
}

const DEFAULT_TOPK = 3;
const DEFAULT_MIN_SCORE = 1;
const DEFAULT_BODY_BUDGET = 1500;

/**
 * Tie-break comparator for entries that scored equal: prefer the more
 * recently `updated` memory (falling back to `created`). Undated entries
 * sort last among ties. Stable for genuinely-equal timestamps.
 */
function recencyMs(entry: MemoryEntry): number {
  const stamp = entry.updated ?? entry.created;
  if (stamp === undefined) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Select the memories most relevant to `prompt`. Scores the whole index
 * (global + project + session) with the shared scorer, takes the top-K
 * above `minScore`, and returns their ids (always) plus, when
 * `injectBodies`, the rendered bodies block.
 *
 * Returns empty `markedIds` + `null` `block` when the prompt is blank,
 * there are no memories, or nothing clears `minScore` - so the caller
 * injects nothing.
 */
export function selectRecall(
  state: MemoryState,
  prompt: string,
  getBody: (e: MemoryEntry) => string | null,
  opts: RecallOptions = {},
): RecallResult {
  const topK = opts.topK ?? DEFAULT_TOPK;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const injectBodies = opts.injectBodies ?? false;
  const bodyBudget = opts.bodyBudget ?? DEFAULT_BODY_BUDGET;
  const scorer = opts.scorer ?? searchMemories;

  const empty: RecallResult = { markedIds: [], block: null };
  const query = prompt.trim();
  if (query.length === 0) return empty;

  const entries = [...state.index.global, ...state.index.project, ...state.index.session];
  if (entries.length === 0) return empty;

  const scored = scorer(entries, getBody, query)
    .filter((s) => s.score >= minScore)
    // The scorer already sorts by score desc; re-sort to apply the
    // recency tie-break on equal scores without disturbing the order of
    // entries whose scores differ.
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : recencyMs(b.entry) - recencyMs(a.entry)))
    .slice(0, topK);

  if (scored.length === 0) return empty;

  const markedIds = scored.map((s) => s.entry.id);
  if (!injectBodies) return { markedIds, block: null };

  const sections: string[] = [];
  for (const { entry } of scored) {
    const body = getBody(entry);
    if (body === null) continue;
    const trimmed = body.trim();
    if (trimmed.length === 0) continue;
    sections.push(`### ${entry.name} (\`${entry.id}\`)\n${truncate(trimmed, bodyBudget)}`);
  }
  if (sections.length === 0) return { markedIds, block: null };

  const block = `## Relevant memory\n\n${sections.join('\n\n')}`;
  return { markedIds, block };
}
