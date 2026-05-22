/**
 * Tokenize a Codex-format patch string into a structured {@link Patch}.
 *
 * The format (Codex's own, not unified-diff):
 *
 * ```text
 * *** Begin Patch
 * *** Update File: path/to/file.ts
 * @@
 *  unchanged context line
 * -removed line
 * +added line
 *  unchanged context line
 * *** End Patch
 * ```
 *
 * Op kinds:
 *
 *   - `*** Update File: <path>` — one or more `@@` hunks.
 *   - `*** Add File: <path>` — body is `+`-prefixed lines; concatenated
 *     into the new file content.
 *   - `*** Delete File: <path>` — no body.
 *   - `*** Move File: <path> -> <new-path>` — optional `@@` hunks
 *     against the OLD path. Single op per D5 in `plans/pi-cc-parity.md`.
 *
 * Strictness contract:
 *
 *   - The four sentinel markers (`*** Begin Patch`, `*** End Patch`,
 *     and the per-op headers above) are matched exactly modulo
 *     trailing whitespace. A typo like `**Begin Patch` is an error.
 *   - Hunk lines must be context (` `), removed (`-`), or added (`+`).
 *     A wholly-empty line inside a hunk is treated as a blank context
 *     line (Codex's convention — the leading space is easy to lose).
 *   - On malformed input, the parser bails with a structured
 *     {@link ParseError} that includes the 1-based input line number
 *     and a short message describing what was expected.
 *
 * No I/O. Pure function from input string to result.
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type HunkLineKind = ' ' | '-' | '+';

export interface HunkLine {
  kind: HunkLineKind;
  text: string;
}

export interface Hunk {
  lines: HunkLine[];
}

export interface UpdateFileOp {
  type: 'update';
  path: string;
  hunks: Hunk[];
}

export interface AddFileOp {
  type: 'add';
  path: string;
  content: string;
}

export interface DeleteFileOp {
  type: 'delete';
  path: string;
}

export interface MoveFileOp {
  type: 'move';
  from: string;
  to: string;
  hunks: Hunk[];
}

export type Op = UpdateFileOp | AddFileOp | DeleteFileOp | MoveFileOp;

export interface Patch {
  ops: Op[];
}

export interface ParseError {
  /** 1-based line number in the input string. */
  line: number;
  message: string;
}

export type ParseResult = { patch: Patch } | { error: ParseError };

// ──────────────────────────────────────────────────────────────────────
// Marker recognition
// ──────────────────────────────────────────────────────────────────────

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
// Marker prefixes are matched without the trailing space because the
// header line is rtrim-ed before comparison (so `*** Update File: \t`
// still matches). The path after the colon is sliced + trimmed below.
const UPDATE_PREFIX = '*** Update File:';
const ADD_PREFIX = '*** Add File:';
const DELETE_PREFIX = '*** Delete File:';
const MOVE_PREFIX = '*** Move File:';
const MOVE_SEPARATOR = ' -> ';
const HUNK_HEADER = '@@';

/** Strip only trailing whitespace; preserves leading whitespace which
 *  is load-bearing for hunk context lines. */
function rtrim(line: string): string {
  return line.replace(/[ \t\r]+$/, '');
}

function isOpHeader(line: string): boolean {
  return (
    line.startsWith(UPDATE_PREFIX) ||
    line.startsWith(ADD_PREFIX) ||
    line.startsWith(DELETE_PREFIX) ||
    line.startsWith(MOVE_PREFIX) ||
    line === END_PATCH
  );
}

function err(line: number, message: string): ParseResult {
  return { error: { line, message } };
}

function truncateForMessage(line: string): string {
  if (line.length <= 60) return line;
  return `${line.slice(0, 57)}...`;
}

// ──────────────────────────────────────────────────────────────────────
// Hunk / Add body parsing
// ──────────────────────────────────────────────────────────────────────

interface HunksOk {
  hunks: Hunk[];
  next: number;
}

interface HunksErr {
  error: ParseError;
}

function parseHunks(rawLines: readonly string[], start: number): HunksOk | HunksErr {
  const hunks: Hunk[] = [];
  let i = start;

  while (i < rawLines.length) {
    const raw = rawLines[i] ?? '';
    const trimmed = rtrim(raw);

    // Stop at the next op header or end-of-patch marker.
    if (isOpHeader(trimmed)) break;

    if (trimmed !== HUNK_HEADER) {
      return {
        error: {
          line: i + 1,
          message: `expected "@@" hunk header or next op header, got "${truncateForMessage(trimmed)}"`,
        },
      };
    }

    // Consume the `@@` line.
    i++;
    const lines: HunkLine[] = [];

    while (i < rawLines.length) {
      const bodyRaw = rawLines[i] ?? '';
      const bodyTrimmed = rtrim(bodyRaw);

      if (bodyTrimmed === HUNK_HEADER) break;
      if (isOpHeader(bodyTrimmed)) break;

      if (bodyRaw.length === 0) {
        // Blank line inside hunk: treat as an empty context line. This
        // matters because editors / model output frequently strip the
        // leading single space from a blank context row.
        lines.push({ kind: ' ', text: '' });
        i++;
        continue;
      }

      const prefix = bodyRaw[0];
      if (prefix !== ' ' && prefix !== '-' && prefix !== '+') {
        return {
          error: {
            line: i + 1,
            message: `expected hunk line prefixed with " ", "-", or "+", got "${truncateForMessage(bodyRaw)}"`,
          },
        };
      }
      lines.push({ kind: prefix, text: bodyRaw.slice(1) });
      i++;
    }

    if (lines.length === 0) {
      return {
        error: {
          line: i,
          message: 'empty "@@" hunk — at least one context / removed / added line is required',
        },
      };
    }

    hunks.push({ lines });
  }

  return { hunks, next: i };
}

interface AddBodyOk {
  content: string;
  next: number;
}

function parseAddBody(rawLines: readonly string[], start: number): AddBodyOk | HunksErr {
  const body: string[] = [];
  let i = start;
  while (i < rawLines.length) {
    const raw = rawLines[i] ?? '';
    const trimmed = rtrim(raw);
    if (isOpHeader(trimmed)) break;

    if (raw.length === 0) {
      // Blank line in an Add File body — treat as a blank line in the
      // new file. This is a small tolerance; strict Codex would expect
      // a literal "+" on its own line.
      body.push('');
      i++;
      continue;
    }
    if (!raw.startsWith('+')) {
      return {
        error: {
          line: i + 1,
          message: `expected "+"-prefixed line in "*** Add File:" body, got "${truncateForMessage(raw)}"`,
        },
      };
    }
    body.push(raw.slice(1));
    i++;
  }

  if (body.length === 0) {
    return {
      error: {
        line: i + 1,
        message: '"*** Add File:" body must contain at least one "+"-prefixed line',
      },
    };
  }

  return { content: body.join('\n'), next: i };
}

// ──────────────────────────────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse a Codex-format patch string. Returns `{ patch }` on success or
 * `{ error: { line, message } }` on the first structural problem.
 */
export function parsePatch(input: string): ParseResult {
  const rawLines = input.split(/\r?\n/);
  // Tolerate a trailing newline (very common) by ignoring the empty
  // tail it produces — but only that single trailing empty line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  if (rawLines.length === 0) {
    return err(1, `expected "${BEGIN_PATCH}"`);
  }

  let i = 0;

  // *** Begin Patch ***
  if (rtrim(rawLines[i] ?? '') !== BEGIN_PATCH) {
    return err(i + 1, `expected "${BEGIN_PATCH}"`);
  }
  i++;

  const ops: Op[] = [];

  while (i < rawLines.length) {
    const rawHeader = rtrim(rawLines[i] ?? '');

    if (rawHeader === END_PATCH) {
      // End of patch. Trailing junk after this line is an error.
      i++;
      while (i < rawLines.length) {
        if (rtrim(rawLines[i] ?? '') !== '') {
          return err(i + 1, `unexpected content after "${END_PATCH}"`);
        }
        i++;
      }
      return { patch: { ops } };
    }

    if (rawHeader.startsWith(UPDATE_PREFIX)) {
      const path = rawHeader.slice(UPDATE_PREFIX.length).trim();
      if (path.length === 0) {
        return err(i + 1, `"${UPDATE_PREFIX}" requires a path`);
      }
      i++;
      const result = parseHunks(rawLines, i);
      if ('error' in result) return { error: result.error };
      if (result.hunks.length === 0) {
        return err(i + 1, `"${UPDATE_PREFIX} ${path}" requires at least one "@@" hunk`);
      }
      ops.push({ type: 'update', path, hunks: result.hunks });
      i = result.next;
      continue;
    }

    if (rawHeader.startsWith(ADD_PREFIX)) {
      const path = rawHeader.slice(ADD_PREFIX.length).trim();
      if (path.length === 0) {
        return err(i + 1, `"${ADD_PREFIX}" requires a path`);
      }
      i++;
      const result = parseAddBody(rawLines, i);
      if ('error' in result) return { error: result.error };
      ops.push({ type: 'add', path, content: result.content });
      i = result.next;
      continue;
    }

    if (rawHeader.startsWith(DELETE_PREFIX)) {
      const path = rawHeader.slice(DELETE_PREFIX.length).trim();
      if (path.length === 0) {
        return err(i + 1, `"${DELETE_PREFIX}" requires a path`);
      }
      i++;
      ops.push({ type: 'delete', path });
      continue;
    }

    if (rawHeader.startsWith(MOVE_PREFIX)) {
      const body = rawHeader.slice(MOVE_PREFIX.length);
      const sepAt = body.indexOf(MOVE_SEPARATOR);
      if (sepAt < 0) {
        return err(i + 1, `"${MOVE_PREFIX}" requires "<from> -> <to>"`);
      }
      const from = body.slice(0, sepAt).trim();
      const to = body.slice(sepAt + MOVE_SEPARATOR.length).trim();
      if (from.length === 0 || to.length === 0) {
        return err(i + 1, `"${MOVE_PREFIX}" requires non-empty <from> and <to>`);
      }
      i++;
      const result = parseHunks(rawLines, i);
      if ('error' in result) return { error: result.error };
      ops.push({ type: 'move', from, to, hunks: result.hunks });
      i = result.next;
      continue;
    }

    if (rawHeader === HUNK_HEADER) {
      return err(i + 1, `unexpected "@@" hunk header before any "*** Update File: " / "*** Move File: " op`);
    }

    if (rawHeader === '') {
      // Tolerate blank lines between ops.
      i++;
      continue;
    }

    return err(
      i + 1,
      `unexpected line "${truncateForMessage(rawHeader)}" — expected one of "*** Update File: ", "*** Add File: ", "*** Delete File: ", "*** Move File: ", or "${END_PATCH}"`,
    );
  }

  // Reached EOF without an `*** End Patch` marker.
  return err(rawLines.length, `missing "${END_PATCH}"`);
}
