/**
 * Pure helpers for the edit-recovery extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * Problem: pi's `edit` tool requires `oldText` to match the file
 * verbatim (modulo a built-in fuzzy pass that handles trailing
 * whitespace, smart quotes, Unicode dashes, and special spaces).
 * Small self-hosted models paraphrase leading indentation, collapse
 * runs of whitespace, or swap tabs for spaces, so their edits fail
 * even when the INTENT is unambiguous. Without help they loop: the
 * model tries the same edit two or three times with slightly-different
 * garbage before giving up.
 *
 * What this module does: when we see pi's "Could not find ..." error,
 * re-locate the intended region by an *aggressive* whitespace-
 * insensitive match (strip all leading whitespace, collapse runs of
 * whitespace to single spaces), then hand the model the actual file
 * content at that region so it can retry with copy-pasted `oldText`.
 *
 * We also handle the duplicate-oldText case: when pi reports N
 * matches, we annotate each candidate position with a little
 * surrounding context so the model can pick a unique anchor to
 * refine the edit.
 *
 * Everything here is pure: no fs, no network. The extension reads
 * the file and passes its contents plus the parsed error structure
 * to `locateAndFormat`.
 */

// ──────────────────────────────────────────────────────────────────────
// Pi error message parsing
// ──────────────────────────────────────────────────────────────────────

export type EditFailureKind = 'not-found' | 'duplicate' | 'other';

export interface ParsedEditFailure {
  kind: EditFailureKind;
  /** 0 for single-edit errors; the N from `edits[N]` for multi. */
  editIndex: number;
  path: string;
  /** Only present for `duplicate`. */
  occurrences?: number;
}

/**
 * Best-effort parser for pi's edit-tool error messages. Returns
 * `undefined` when we don't recognize the message shape — the
 * extension then silently skips recovery for that result.
 *
 * Handles these canonical shapes emitted by
 * `@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js`:
 *
 *   - "Could not find the exact text in {path}. ..."           (single edit)
 *   - "Could not find edits[{N}] in {path}. ..."               (multi-edit)
 *   - "Found {K} occurrences of the text in {path}. ..."       (single)
 *   - "Found {K} occurrences of edits[{N}] in {path}. ..."     (multi)
 */
export function parseEditFailure(text: string): ParsedEditFailure | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  // Take the last non-empty line — pi throws with just the message,
  // but the harness may prepend partial context. The canonical error
  // is always a single line.
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return undefined;

  let m: RegExpExecArray | null;

  m = /^Could not find the exact text in (.+?)\. The old text must match/.exec(line);
  if (m?.[1]) return { kind: 'not-found', editIndex: 0, path: m[1] };

  m = /^Could not find edits\[(\d+)\] in (.+?)\. The oldText must match/.exec(line);
  if (m?.[1] && m?.[2]) return { kind: 'not-found', editIndex: Number.parseInt(m[1], 10), path: m[2] };

  m = /^Found (\d+) occurrences of the text in (.+?)\. The text must be unique/.exec(line);
  if (m?.[1] && m?.[2]) {
    return { kind: 'duplicate', editIndex: 0, path: m[2], occurrences: Number.parseInt(m[1], 10) };
  }

  m = /^Found (\d+) occurrences of edits\[(\d+)\] in (.+?)\. Each oldText/.exec(line);
  if (m?.[1] && m?.[2] && m?.[3]) {
    return {
      kind: 'duplicate',
      editIndex: Number.parseInt(m[2], 10),
      path: m[3],
      occurrences: Number.parseInt(m[1], 10),
    };
  }

  return undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Normalization
// ──────────────────────────────────────────────────────────────────────

/**
 * Mirrors pi's internal `normalizeForFuzzyMatch`. Re-implemented here
 * (not imported) to keep this module pure and testable without the pi
 * runtime. Keep in sync with
 * `@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js` if pi's
 * normalization expands.
 */
function piFuzzyNormalize(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

/**
 * Aggressive per-line normalize: apply pi's fuzzy normalize, then
 * strip leading whitespace and collapse runs of any whitespace to
 * single spaces. Used purely for LOCATING the intended region — the
 * extension's output still shows the file's raw bytes verbatim so
 * the model can paste them into the retry.
 *
 * Returns an array of normalized lines (no trailing `\n` on each).
 */
export function normalizeAggressiveLines(text: string): string[] {
  return piFuzzyNormalize(text)
    .split('\n')
    .map((line) => line.replace(/^\s+/, '').replace(/\s+/g, ' '));
}

/**
 * Collapse an entire string to a single normalized line using the
 * same aggressive rules, with all newlines converted to single
 * spaces. Useful as a shortcut when `oldText` is a one-liner.
 */
export function normalizeAggressiveFlat(text: string): string {
  return normalizeAggressiveLines(text).join(' ').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────────────────────────────
// Candidate location
// ──────────────────────────────────────────────────────────────────────

export interface Candidate {
  /** 1-based start line in the file. */
  startLine: number;
  /** 1-based end line (inclusive). */
  endLine: number;
}

/**
 * Slide `normalizedOld` across `normalizedFile` line-by-line; return
 * every starting line (1-based) where all old-lines match. Skips
 * wholly-empty windows (both sides all blank).
 */
export function findCandidates(normalizedFile: readonly string[], normalizedOld: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  if (normalizedOld.length === 0) return out;
  // Special-case single-line oldText against a multi-line file: also
  // support match against a substring of a file line for completeness.
  // Keep behavior conservative — we still prefer full-line equality.
  for (let i = 0; i + normalizedOld.length <= normalizedFile.length; i++) {
    let all = true;
    for (let j = 0; j < normalizedOld.length; j++) {
      if (normalizedFile[i + j] !== normalizedOld[j]) {
        all = false;
        break;
      }
    }
    if (all) {
      out.push({ startLine: i + 1, endLine: i + normalizedOld.length });
    }
  }
  return out;
}

/**
 * Fallback when exact multi-line match fails: return every line in
 * the file whose normalized text equals the FIRST non-empty line of
 * the normalized oldText. The extension shows these as "anchor"
 * candidates — "we couldn't match the full block but here are lines
 * that might be the start of the target".
 *
 * Returns candidates sorted by file position. The end-line of each
 * candidate is the anchor line (1 line wide) so the caller can
 * render a context window around it.
 */
export function findAnchorCandidates(
  normalizedFile: readonly string[],
  normalizedOld: readonly string[],
  max = 5,
): Candidate[] {
  const anchor = normalizedOld.find((l) => l.length > 0);
  if (!anchor) return [];
  const out: Candidate[] = [];
  for (let i = 0; i < normalizedFile.length && out.length < max; i++) {
    if (normalizedFile[i] === anchor) out.push({ startLine: i + 1, endLine: i + 1 });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Snippet rendering
// ──────────────────────────────────────────────────────────────────────

export interface SnippetOptions {
  /** Lines of context before/after the candidate region. Default 2. */
  contextLines?: number;
  /** Maximum total lines rendered per snippet. Default 40. */
  maxLines?: number;
}

/**
 * Render a snippet of the file with 1-based line numbers and a
 * marker (`>>`) on the candidate region. Non-candidate context
 * lines use a two-space prefix so the block stays easy to scan.
 */
export function formatSnippet(
  rawFileLines: readonly string[],
  candidate: Candidate,
  opts: SnippetOptions = {},
): string {
  const context = opts.contextLines ?? 2;
  const maxLines = opts.maxLines ?? 40;
  const fromLine = Math.max(1, candidate.startLine - context);
  const toLine = Math.min(rawFileLines.length, candidate.endLine + context);
  const rendered: string[] = [];
  // Compute the gutter width from the largest line number we'll show.
  const gutterWidth = String(toLine).length;
  for (let l = fromLine; l <= toLine; l++) {
    const marker = l >= candidate.startLine && l <= candidate.endLine ? '>>' : '  ';
    const num = String(l).padStart(gutterWidth, ' ');
    rendered.push(`${marker} ${num} │ ${rawFileLines[l - 1] ?? ''}`);
    if (rendered.length >= maxLines) {
      rendered.push(`   … (snippet truncated at ${maxLines} lines)`);
      break;
    }
  }
  return rendered.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// End-to-end
// ──────────────────────────────────────────────────────────────────────

export interface RecoveryInput {
  /** The raw error text emitted by pi's edit tool. */
  errorText: string;
  /** The full `edits` array from the tool call's input. */
  edits: readonly { oldText: string; newText: string }[];
  /**
   * Raw file content as read from disk. When undefined the caller
   * couldn't read the file (missing, too large, permissions) — we
   * still emit the parsed error + short guidance.
   */
  fileContent?: string;
  /** Path to show in the recovery message. */
  pathForDisplay: string;
  /** Snippet context. */
  contextLines?: number;
  /** Cap candidates so the snippet block doesn't explode. */
  maxCandidates?: number;
}

export interface RecoveryOutput {
  /**
   * Markdown-ish recovery block to append to the tool result. When
   * `undefined`, the caller should emit nothing — either the error
   * wasn't recognizable or nothing useful was found.
   */
  text: string | undefined;
  /** Populated only when text is defined. Tagged metadata for tests / logging. */
  kind?: 'exact-1' | 'exact-many' | 'anchor' | 'unreadable' | 'no-match';
  candidates?: Candidate[];
}

function labelFor(parsed: ParsedEditFailure, total = parsed.editIndex + 1): string {
  return total > 1 || parsed.editIndex > 0 ? `edits[${parsed.editIndex}].oldText` : 'oldText';
}

function formatSingle(
  parsed: ParsedEditFailure,
  path: string,
  c: Candidate,
  rawLines: readonly string[],
  contextLines: number | undefined,
): string {
  const label = labelFor(parsed);
  const snippet = formatSnippet(rawLines, c, { contextLines });
  const lineRange = c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}–${c.endLine}`;
  return (
    `edit-recovery: A whitespace-insensitive search found the intended region at ${lineRange} of ${path}:\n\n` +
    `\`\`\`\n${snippet}\n\`\`\`\n\n` +
    `Retry with \`${label}\` copied verbatim (including its original indentation and whitespace) from the block above.`
  );
}

function formatMany(
  parsed: ParsedEditFailure,
  path: string,
  cs: readonly Candidate[],
  rawLines: readonly string[],
  contextLines: number | undefined,
): string {
  const label = labelFor(parsed);
  const blocks = cs.map((c) => {
    const snippet = formatSnippet(rawLines, c, { contextLines });
    const lineRange = c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}–${c.endLine}`;
    return `At ${lineRange}:\n\`\`\`\n${snippet}\n\`\`\``;
  });
  // Keep wording separate from the `path` arg so we don't accidentally
  // rely on the message shape in tests.
  void path;
  const noun = parsed.kind === 'duplicate' ? 'exact matches' : 'equally-good matches';
  return (
    `edit-recovery: The file has ${cs.length} ${noun} for \`${label}\` (whitespace-insensitive). ` +
    `Pick the intended one by extending \`${label}\` with one or two nearby lines that make it unique:\n\n` +
    blocks.join('\n\n')
  );
}

function formatAnchors(
  parsed: ParsedEditFailure,
  path: string,
  cs: readonly Candidate[],
  rawLines: readonly string[],
  contextLines: number | undefined,
): string {
  const label = labelFor(parsed);
  const blocks = cs.map((c) => {
    const snippet = formatSnippet(rawLines, c, { contextLines });
    return `Near line ${c.startLine}:\n\`\`\`\n${snippet}\n\`\`\``;
  });
  return (
    `edit-recovery: No block in ${path} matched the whole \`${label}\` even with whitespace ignored. ` +
    `The first line of your oldText does appear here, though — the target may be close:\n\n` +
    blocks.join('\n\n') +
    `\n\nIf the target is one of these regions, copy \`${label}\` verbatim from the block. Otherwise use \`read\` or \`grep\` to locate it before retrying.`
  );
}

function formatNoMatch(parsed: ParsedEditFailure, path: string): string {
  const label = labelFor(parsed);
  return (
    `edit-recovery: Whitespace-insensitive search also failed in ${path}. ` +
    `\`${label}\` may not exist in the file at all — re-\`read\` the file or \`grep\` for a shorter anchor before retrying.`
  );
}

function formatUnreadable(parsed: ParsedEditFailure, path: string): string {
  const label = labelFor(parsed);
  return (
    `edit-recovery: Could not re-read ${path} to help locate \`${label}\` (file missing, too large, or unreadable). ` +
    `Use \`read\` on the file yourself and retry the edit with copy-pasted text.`
  );
}

export function locateAndFormat(input: RecoveryInput): RecoveryOutput {
  const parsed = parseEditFailure(input.errorText);
  if (!parsed) return { text: undefined };
  const edit = input.edits[parsed.editIndex];
  if (!edit) return { text: undefined };
  if (input.fileContent === undefined) {
    return {
      text: formatUnreadable(parsed, input.pathForDisplay),
      kind: 'unreadable',
    };
  }

  const normalizedOld = normalizeAggressiveLines(edit.oldText)
    // Drop leading / trailing wholly-empty lines — matching is already
    // lenient about blank lines and they only widen the window.
    .filter((line, i, arr) => !(line === '' && (i === 0 || i === arr.length - 1)));
  const normalizedFile = normalizeAggressiveLines(input.fileContent);
  const rawFileLines = input.fileContent.split(/\r?\n/);
  const maxCandidates = input.maxCandidates ?? 5;

  const exact = findCandidates(normalizedFile, normalizedOld).slice(0, maxCandidates);
  if (exact.length === 1) {
    const first = exact[0];
    if (first) {
      return {
        text: formatSingle(parsed, input.pathForDisplay, first, rawFileLines, input.contextLines),
        kind: 'exact-1',
        candidates: exact,
      };
    }
  }
  if (exact.length > 1) {
    return {
      text: formatMany(parsed, input.pathForDisplay, exact, rawFileLines, input.contextLines),
      kind: 'exact-many',
      candidates: exact,
    };
  }

  const anchors = findAnchorCandidates(normalizedFile, normalizedOld, maxCandidates);
  if (anchors.length > 0) {
    return {
      text: formatAnchors(parsed, input.pathForDisplay, anchors, rawFileLines, input.contextLines),
      kind: 'anchor',
      candidates: anchors,
    };
  }

  return {
    text: formatNoMatch(parsed, input.pathForDisplay),
    kind: 'no-match',
  };
}
