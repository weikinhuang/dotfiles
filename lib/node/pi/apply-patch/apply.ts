/**
 * Take a parsed {@link Patch} and a `readFile` callback, validate every
 * op against the current filesystem snapshot, and return either a
 * write plan or the collected per-op errors. All-or-nothing: if even
 * one op fails (existence check, hunk-locate, plan conflict, …) the
 * whole patch is rejected and the caller writes nothing.
 *
 * No I/O. The caller is responsible for reading file contents (passed
 * in via `readFile`) and for performing the rename / write / delete
 * operations described by the returned plan. Keeping I/O at the edges
 * lets the extension shell wire the same plan through `filesystem`
 * policy gates that `write` / `edit` already enforce.
 *
 * The returned `errors` array collects EVERY failing op (and every
 * failing hunk within an op), not just the first — the caller can
 * surface a single recovery block per failure so the model can fix
 * them all in one retry.
 */

import { formatRecoveryBlock } from './format-recovery.ts';
import { hunkNewLines, locateHunk, type LocateResult } from './locate.ts';
import type { Hunk, Patch } from './parse.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface WritePlan {
  /** Path → new file content. Includes the target of any move. */
  writes: Map<string, string>;
  /** Paths to remove. */
  deletes: Set<string>;
  /** Old path → new path. Move semantics: rename, then write target. */
  moves: Map<string, string>;
}

export interface PerOpError {
  /** 0-based op index within the patch. */
  opIndex: number;
  /** Human-readable summary. */
  message: string;
  /**
   * Recovery block formatted by {@link formatRecoveryBlock}. Present
   * when the error stems from a hunk-locate failure; the caller can
   * append this to the tool result.
   */
  recovery?: string;
}

export type ApplyResult = { plan: WritePlan } | { errors: PerOpError[] };

export type ReadFile = (path: string) => string | null;

// ──────────────────────────────────────────────────────────────────────
// Line split / join
// ──────────────────────────────────────────────────────────────────────

/**
 * Split file content into lines, preserving the trailing-empty
 * sentinel that signals "the file ended with a newline". This pairs
 * with {@link joinLines} so round-tripping a file through an empty
 * patch is byte-identical (modulo CRLF → LF normalization).
 */
function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Hunk application
// ──────────────────────────────────────────────────────────────────────

interface HunkFailure {
  hunkIndex: number;
  failure: Exclude<LocateResult, { kind: 'found' }>;
  /**
   * File lines as they appeared at the moment of the failed locate
   * (after any prior hunks in this op had been applied). Used by the
   * recovery formatter to render the snippet against the right state.
   */
  fileLinesAtFailure: string[];
}

interface HunkSuccess {
  content: string;
}

interface HunkErrors {
  errors: HunkFailure[];
}

function describeFailure(failure: Exclude<LocateResult, { kind: 'found' }>): string {
  if (failure.kind === 'no-match') return 'did not match any region of the file';
  return `matched ${failure.candidates.length} regions of the file (ambiguous)`;
}

function applyHunks(content: string, hunks: readonly Hunk[]): HunkSuccess | HunkErrors {
  let lines = splitLines(content);
  let searchFrom = 1;
  const failures: HunkFailure[] = [];

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];
    if (!hunk) continue;
    const loc = locateHunk(lines, hunk, { searchFrom });
    if (loc.kind !== 'found') {
      failures.push({ hunkIndex, failure: loc, fileLinesAtFailure: lines.slice() });
      // Continue to collect every hunk's failure rather than bailing
      // on the first — gives the caller a full picture in one retry.
      continue;
    }
    const newLines = hunkNewLines(hunk);
    lines = [...lines.slice(0, loc.line - 1), ...newLines, ...lines.slice(loc.line - 1 + loc.span)];
    searchFrom = loc.line + newLines.length;
  }

  if (failures.length > 0) return { errors: failures };
  return { content: joinLines(lines) };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────

export function applyPatch(patch: Patch, readFile: ReadFile): ApplyResult {
  const errors: PerOpError[] = [];
  const writes = new Map<string, string>();
  const deletes = new Set<string>();
  const moves = new Map<string, string>();

  // Track every path that this patch has already laid claim to, so a
  // second op touching the same path produces a clean plan-conflict
  // error instead of silently clobbering the first op's intent.
  const claimed = new Set<string>();

  for (let opIndex = 0; opIndex < patch.ops.length; opIndex++) {
    const op = patch.ops[opIndex];
    if (!op) continue;

    switch (op.type) {
      case 'add': {
        if (claimed.has(op.path)) {
          errors.push({ opIndex, message: `Add File: ${op.path} conflicts with an earlier op in this patch.` });
          break;
        }
        const existing = readFile(op.path);
        if (existing !== null) {
          errors.push({
            opIndex,
            message: `Add File: ${op.path} already exists; refusing to overwrite (use "*** Update File:" instead).`,
          });
          break;
        }
        writes.set(op.path, op.content);
        claimed.add(op.path);
        break;
      }

      case 'delete': {
        if (claimed.has(op.path)) {
          errors.push({ opIndex, message: `Delete File: ${op.path} conflicts with an earlier op in this patch.` });
          break;
        }
        const existing = readFile(op.path);
        if (existing === null) {
          errors.push({ opIndex, message: `Delete File: ${op.path} does not exist.` });
          break;
        }
        deletes.add(op.path);
        claimed.add(op.path);
        break;
      }

      case 'update': {
        if (claimed.has(op.path)) {
          errors.push({ opIndex, message: `Update File: ${op.path} conflicts with an earlier op in this patch.` });
          break;
        }
        const existing = readFile(op.path);
        if (existing === null) {
          errors.push({ opIndex, message: `Update File: ${op.path} does not exist.` });
          break;
        }
        const result = applyHunks(existing, op.hunks);
        if ('errors' in result) {
          for (const f of result.errors) {
            errors.push({
              opIndex,
              message: `Update File: ${op.path}: hunk[${f.hunkIndex}] ${describeFailure(f.failure)}.`,
              recovery: formatRecoveryBlock({
                opLabel: `Update File: ${op.path}`,
                opIndex,
                hunkIndex: f.hunkIndex,
                failure: f.failure,
                pathForDisplay: op.path,
                fileLines: f.fileLinesAtFailure,
              }),
            });
          }
          break;
        }
        writes.set(op.path, result.content);
        claimed.add(op.path);
        break;
      }

      case 'move': {
        if (claimed.has(op.from)) {
          errors.push({ opIndex, message: `Move File: ${op.from} conflicts with an earlier op in this patch.` });
          break;
        }
        if (claimed.has(op.to)) {
          errors.push({ opIndex, message: `Move File: target ${op.to} conflicts with an earlier op in this patch.` });
          break;
        }
        if (op.from === op.to) {
          errors.push({ opIndex, message: `Move File: <from> and <to> must differ (got ${op.from}).` });
          break;
        }
        const existing = readFile(op.from);
        if (existing === null) {
          errors.push({ opIndex, message: `Move File: source ${op.from} does not exist.` });
          break;
        }
        const toExisting = readFile(op.to);
        if (toExisting !== null) {
          errors.push({ opIndex, message: `Move File: target ${op.to} already exists; refusing to overwrite.` });
          break;
        }

        let newContent = existing;
        if (op.hunks.length > 0) {
          const result = applyHunks(existing, op.hunks);
          if ('errors' in result) {
            for (const f of result.errors) {
              errors.push({
                opIndex,
                message: `Move File: ${op.from} -> ${op.to}: hunk[${f.hunkIndex}] ${describeFailure(f.failure)}.`,
                recovery: formatRecoveryBlock({
                  opLabel: `Move File: ${op.from} -> ${op.to}`,
                  opIndex,
                  hunkIndex: f.hunkIndex,
                  failure: f.failure,
                  // Hunks for Move File apply against the OLD path content per D5.
                  pathForDisplay: op.from,
                  fileLines: f.fileLinesAtFailure,
                }),
              });
            }
            break;
          }
          newContent = result.content;
        }

        moves.set(op.from, op.to);
        writes.set(op.to, newContent);
        claimed.add(op.from);
        claimed.add(op.to);
        break;
      }

      default: {
        // Exhaustive over the Op union. If a new variant is added
        // without a matching case, this surfaces it at compile time.
        const _exhaustive: never = op;
        void _exhaustive;
      }
    }
  }

  if (errors.length > 0) return { errors };
  return { plan: { writes, deletes, moves } };
}
