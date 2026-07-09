/**
 * Locate a parsed {@link Hunk}'s "old" region inside a file's current
 * content. Used by {@link applyPatch} to decide where each hunk's
 * removal / context block lives before staging the rewrite.
 *
 * Two passes:
 *
 *   1. **Exact**: line-by-line equality between the hunk's old-lines
 *      (` ` context + `-` removed) and a window of the file.
 *   2. **Whitespace-insensitive fallback**: reuses
 *      {@link normalizeAggressiveLines} + {@link findCandidates} from
 *      `edit-recovery.ts`. The plan calls these out as the canonical
 *      fuzzy primitives — keep them as the single source of truth, do
 *      not re-implement.
 *
 * Output is one of:
 *   - `{ kind: 'found', line, span }` — unique match. `line` is 1-based,
 *     `span` is the number of file lines the hunk replaces.
 *   - `{ kind: 'no-match' }` — neither exact nor fuzzy turned up a hit.
 *   - `{ kind: 'ambiguous', candidates }` — multiple equally-good
 *     matches; caller must surface a recovery block listing them.
 *
 * Pure. No I/O.
 */

import { type Candidate, findCandidates, normalizeAggressiveLines } from '../edit-recovery.ts';

import type { Hunk } from './parse.ts';

export interface LocateFound {
  kind: 'found';
  /** 1-based line where the old region starts in the file. */
  line: number;
  /** Number of file lines the hunk's old region spans. */
  span: number;
}

export interface LocateNoMatch {
  kind: 'no-match';
  /** The old-lines extracted from the hunk, for diagnostics. */
  oldLines: string[];
}

export interface LocateAmbiguous {
  kind: 'ambiguous';
  oldLines: string[];
  candidates: Candidate[];
}

export type LocateResult = LocateFound | LocateNoMatch | LocateAmbiguous;

export interface LocateOptions {
  /**
   * Begin searching at this 1-based line. Hunks within one op must
   * appear in file order, so the caller advances this past each
   * applied hunk. Defaults to 1.
   */
  searchFrom?: number;
  /** Cap on candidates returned for the ambiguous result. */
  maxCandidates?: number;
}

/**
 * Pull the "old" view of a hunk — lines that should already be present
 * in the file (context + removed). The returned strings are raw (no
 * leading marker), in file order.
 */
export function hunkOldLines(hunk: Hunk): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === ' ' || line.kind === '-') out.push(line.text);
  }
  return out;
}

/**
 * Pull the "new" view of a hunk — what should be in the file AFTER
 * the hunk is applied (context + added). In file order.
 */
export function hunkNewLines(hunk: Hunk): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === ' ' || line.kind === '+') out.push(line.text);
  }
  return out;
}

/**
 * Search `fileLines` (the file's lines as an array) for the region
 * matching `hunk`. Tries exact equality first; falls back to the
 * whitespace-insensitive matcher from `edit-recovery.ts` if no exact
 * match is found.
 */
export function locateHunk(fileLines: readonly string[], hunk: Hunk, opts: LocateOptions = {}): LocateResult {
  const oldLines = hunkOldLines(hunk);
  const searchFrom = Math.max(1, opts.searchFrom ?? 1);
  const maxCandidates = opts.maxCandidates ?? 5;

  // Empty old-side: a pure-insertion hunk. Codex's format requires at
  // least one context line, so this only happens for malformed input;
  // refuse to guess rather than silently inserting at line 1.
  if (oldLines.length === 0) {
    return { kind: 'no-match', oldLines };
  }

  // ── Exact pass ────────────────────────────────────────────────────
  const exact: number[] = [];
  for (let i = searchFrom - 1; i + oldLines.length <= fileLines.length; i++) {
    let all = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j] !== oldLines[j]) {
        all = false;
        break;
      }
    }
    if (all) exact.push(i + 1);
    if (exact.length > maxCandidates) break;
  }
  if (exact.length === 1) {
    const line = exact[0] ?? 0;
    return { kind: 'found', line, span: oldLines.length };
  }
  if (exact.length > 1) {
    return {
      kind: 'ambiguous',
      oldLines,
      candidates: exact.slice(0, maxCandidates).map((line) => ({
        startLine: line,
        endLine: line + oldLines.length - 1,
      })),
    };
  }

  // ── Whitespace-insensitive fallback ───────────────────────────────
  // Reuse the same normalize + slide pair `edit-recovery.locateAndFormat`
  // uses, so behavior stays in sync between the two tools.
  //
  // Unlike edit-recovery (which only RENDERS a snippet), this result
  // drives a real splice in apply.ts: `span` must equal the number of
  // RAW file lines the hunk replaces. `normalizeAggressiveLines` is
  // line-preserving, so keeping `normalizedOld` line-for-line with
  // `oldLines` guarantees `span === oldLines.length`. Dropping leading /
  // trailing blank lines here (as edit-recovery does for display) would
  // shorten `span` while `hunkNewLines` still carries the blank context
  // lines, duplicating them into the file - silent corruption.
  const normalizedFile = normalizeAggressiveLines(fileLines.join('\n'));
  const normalizedOld = normalizeAggressiveLines(oldLines.join('\n'));

  // Confine the fuzzy search to the same `searchFrom` window so a
  // later hunk can't jump backward into already-applied territory.
  const fuzzy: Candidate[] = [];
  for (const c of findCandidates(normalizedFile, normalizedOld)) {
    if (c.startLine < searchFrom) continue;
    fuzzy.push(c);
    if (fuzzy.length > maxCandidates) break;
  }

  if (fuzzy.length === 1) {
    const candidate = fuzzy[0];
    if (candidate) {
      return {
        kind: 'found',
        line: candidate.startLine,
        span: candidate.endLine - candidate.startLine + 1,
      };
    }
  }
  if (fuzzy.length > 1) {
    return { kind: 'ambiguous', oldLines, candidates: fuzzy.slice(0, maxCandidates) };
  }

  return { kind: 'no-match', oldLines };
}
