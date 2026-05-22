/**
 * Format a per-op recovery block for `apply_patch` when a hunk fails
 * to locate (`no-match` or `ambiguous`). Mirrors the visual style of
 * `edit-recovery.ts`'s `locateAndFormat`: numbered lines, `>>` markers,
 * a small context window, and a `findAnchorCandidates` fallback when
 * even the fuzzy match misses.
 *
 * Each call returns one block; the caller concatenates blocks across
 * failing ops to produce the full error message.
 *
 * Pure. No I/O.
 */

import { type Candidate, findAnchorCandidates, formatSnippet, normalizeAggressiveLines } from '../edit-recovery.ts';

import type { LocateAmbiguous, LocateNoMatch } from './locate.ts';

export interface FormatRecoveryInput {
  /** Heading label, e.g. `Update File: foo.ts` or `Move File: a -> b`. */
  opLabel: string;
  /** 0-based op index within the patch. */
  opIndex: number;
  /** 0-based hunk index within the op. */
  hunkIndex: number;
  /** The locate failure to render. */
  failure: LocateNoMatch | LocateAmbiguous;
  /** Path shown in the recovery prose. */
  pathForDisplay: string;
  /** Raw file lines (already split). */
  fileLines: readonly string[];
  /** Lines of context around each candidate. Default 2. */
  contextLines?: number;
  /** Cap on rendered candidates. Default 5. */
  maxCandidates?: number;
}

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_CANDIDATES = 5;

function heading(input: FormatRecoveryInput): string {
  return `apply-patch op[${input.opIndex}] (${input.opLabel}), hunk[${input.hunkIndex}]`;
}

function snippetBlock(
  fileLines: readonly string[],
  candidate: Candidate,
  contextLines: number,
): { lineRange: string; snippet: string } {
  const lineRange =
    candidate.startLine === candidate.endLine
      ? `line ${candidate.startLine}`
      : `lines ${candidate.startLine}-${candidate.endLine}`;
  const snippet = formatSnippet(fileLines, candidate, { contextLines });
  return { lineRange, snippet };
}

/**
 * Render a recovery block for a single failed hunk. Returns a string
 * suitable for concatenation into a tool-result error message; ends
 * without a trailing newline so the caller controls block separation.
 */
export function formatRecoveryBlock(input: FormatRecoveryInput): string {
  const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const head = heading(input);

  if (input.failure.kind === 'ambiguous') {
    const cs = input.failure.candidates.slice(0, maxCandidates);
    const blocks = cs.map((c) => {
      const { lineRange, snippet } = snippetBlock(input.fileLines, c, contextLines);
      return `At ${lineRange}:\n\`\`\`\n${snippet}\n\`\`\``;
    });
    return (
      `${head}: The hunk's old-side matches ${cs.length} regions in ${input.pathForDisplay} (whitespace-insensitive). ` +
      `Add one or two more context lines to the hunk so the target is unique:\n\n` +
      blocks.join('\n\n')
    );
  }

  // no-match
  const oldText = input.failure.oldLines.join('\n');
  const normalizedFile = normalizeAggressiveLines(input.fileLines.join('\n'));
  const normalizedOld = normalizeAggressiveLines(oldText);
  const anchors = findAnchorCandidates(normalizedFile, normalizedOld, maxCandidates);

  if (anchors.length > 0) {
    const blocks = anchors.map((c) => {
      const { snippet } = snippetBlock(input.fileLines, c, contextLines);
      return `Near line ${c.startLine}:\n\`\`\`\n${snippet}\n\`\`\``;
    });
    return (
      `${head}: No region in ${input.pathForDisplay} matched the hunk's old-side even with whitespace ignored. ` +
      `The first line of the hunk does appear here — the intended region may be close:\n\n` +
      blocks.join('\n\n') +
      `\n\nIf the target is one of these, rewrite the hunk's context against the lines shown. ` +
      `Otherwise re-\`read\` ${input.pathForDisplay} before retrying.`
    );
  }

  return (
    `${head}: No region in ${input.pathForDisplay} matched the hunk's old-side. ` +
    `Re-\`read\` the file or \`grep\` for a shorter anchor before retrying.`
  );
}
