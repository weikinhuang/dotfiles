/**
 * Edit-miss recovery for pi.
 *
 * Pi's `edit` tool requires `oldText` to match the file verbatim
 * (modulo a built-in fuzzy pass that handles trailing whitespace,
 * smart quotes, Unicode dashes, and special spaces). Small
 * self-hosted models paraphrase leading indentation, collapse
 * whitespace runs, or swap tabs for spaces, so their edits regularly
 * fail with pi's "Could not find the exact text …" error. Without
 * help they retry the same edit two or three times with
 * near-identical garbage before giving up.
 *
 * This extension hooks `tool_result` for `edit` when `isError: true`,
 * re-reads the file, and runs an *aggressive* whitespace-insensitive
 * search to re-locate the intended region. It then appends a short
 * recovery block to the tool result with:
 *
 *   - the actual file content at the located region (verbatim, with
 *     line numbers + a `>>` marker)
 *   - instructions to retry with `oldText` copy-pasted from the block
 *
 * Behavior by outcome (see `lib/node/pi/edit-recovery.ts`):
 *
 *   - exact-1       single unambiguous region found          → confident retry guidance
 *   - exact-many    multiple whitespace-equivalent regions   → tell model to disambiguate
 *   - anchor        no full-block match but the first line   → point at possible anchors
 *                   of oldText appears in the file
 *   - no-match      whitespace-insensitive search also fails → "re-read or grep first"
 *   - unreadable    file missing / too large / unreadable    → "read the file yourself"
 *
 * Composition notes:
 *
 *   - We do NOT auto-retry. Auto-retry hides the fault from
 *     `verify-before-claim` / `stall-recovery` / `todo` guardrails
 *     and masks "the model didn't understand what it was doing"
 *     failures. Surfacing the actual file content lets the model
 *     succeed on the retry without losing the honest turn shape.
 *   - We leave pi's original error content intact and APPEND the
 *     recovery block as a second text part. That keeps the output
 *     readable ("pi told me what went wrong, then said here's what
 *     was actually there") and composes cleanly with
 *     `tool-output-condenser` downstream.
 *
 * Environment:
 *   PI_EDIT_RECOVERY_DISABLED=1         skip the extension entirely
 *   PI_EDIT_RECOVERY_MAX_BYTES=<n>      max file size to scan, default 262144 (256 KB)
 *   PI_EDIT_RECOVERY_CONTEXT_LINES=<n>  lines of context above/below each candidate, default 2
 *   PI_EDIT_RECOVERY_MAX_CANDIDATES=<n> cap per-result, default 5
 *   PI_EDIT_RECOVERY_DEBUG=1            ctx.ui.notify each decision
 *   PI_EDIT_RECOVERY_TRACE=<path>       append one line per decision to <path>
 */

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { type ExtensionAPI, type ExtensionContext, isEditToolResult } from '@mariozechner/pi-coding-agent';

import { locateAndFormat, parseEditFailure } from '../../../lib/node/pi/edit-recovery.ts';

const DEFAULT_MAX_BYTES = 262_144;
const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_CANDIDATES = 5;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveFileContent(
  cwd: string,
  inputPath: string,
  maxBytes: number,
): { content: string | undefined; reason?: string } {
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    return { content: undefined, reason: 'stat failed (missing or unreadable)' };
  }
  if (size > maxBytes) {
    return { content: undefined, reason: `file too large (${size} > ${maxBytes})` };
  }
  try {
    return { content: readFileSync(absolute, 'utf8') };
  } catch {
    return { content: undefined, reason: 'read failed' };
  }
}

export default function editRecovery(pi: ExtensionAPI): void {
  if (process.env.PI_EDIT_RECOVERY_DISABLED === '1') return;

  const maxBytes = parsePositiveInt(process.env.PI_EDIT_RECOVERY_MAX_BYTES, DEFAULT_MAX_BYTES);
  const contextLines = parsePositiveInt(process.env.PI_EDIT_RECOVERY_CONTEXT_LINES, DEFAULT_CONTEXT_LINES);
  const maxCandidates = parsePositiveInt(process.env.PI_EDIT_RECOVERY_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES);
  const debug = process.env.PI_EDIT_RECOVERY_DEBUG === '1';
  const tracePath = process.env.PI_EDIT_RECOVERY_TRACE;

  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[edit-recovery] ${msg}\n`, 'utf8');
    } catch {
      /* diagnostics must never break a turn */
    }
  };

  const notify = (ctx: ExtensionContext, msg: string, level: 'info' | 'warning' | 'error' = 'info'): void => {
    if (debug) ctx.ui.notify(msg, level);
  };

  pi.on('tool_result', (event, ctx) => {
    if (!isEditToolResult(event)) return undefined;
    if (!event.isError) return undefined;

    // Pi's edit error is a single text part. Condensation doesn't kick
    // in before our hook (pi's tool output condenser is alphabetically
    // later in the dotfiles extension dir), so we get the raw error.
    const first = event.content[0];
    if (!first || first.type !== 'text') return undefined;
    const errorText = first.text;

    const parsed = parseEditFailure(errorText);
    if (!parsed) {
      trace('skip: unrecognized error shape');
      return undefined;
    }

    const input = event.input as { path?: unknown; edits?: unknown };
    const path = typeof input.path === 'string' ? input.path : undefined;
    const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : undefined;
    if (!path || !edits) {
      trace('skip: tool input missing path or edits array');
      return undefined;
    }

    // Validate the edits array shape; if malformed, bail.
    const normalizedEdits = edits
      .map((e): { oldText: string; newText: string } | undefined => {
        if (!e || typeof e !== 'object') return undefined;
        const obj = e as Record<string, unknown>;
        return typeof obj.oldText === 'string' && typeof obj.newText === 'string'
          ? { oldText: obj.oldText, newText: obj.newText }
          : undefined;
      })
      .filter((e): e is { oldText: string; newText: string } => e !== undefined);
    if (normalizedEdits.length === 0) {
      trace('skip: no valid edits in input');
      return undefined;
    }

    const { content, reason } = resolveFileContent(ctx.cwd, path, maxBytes);

    const out = locateAndFormat({
      errorText,
      edits: normalizedEdits,
      fileContent: content,
      pathForDisplay: path,
      contextLines,
      maxCandidates,
    });

    if (!out.text) {
      trace(`skip: locate produced no output (fileReason=${reason ?? 'none'})`);
      return undefined;
    }

    trace(`emit: kind=${out.kind ?? '?'} path=${path} candidates=${out.candidates?.length ?? 0}`);
    notify(ctx, `edit-recovery: ${out.kind ?? '?'} for ${path}`, 'info');

    // Append our recovery block as a second text part so pi's original
    // error stays intact at position 0. Other `tool_result` handlers
    // (tool-output-condenser) see the augmented result next.
    return {
      content: [...event.content, { type: 'text', text: `\n${out.text}` }],
    };
  });
}
