/**
 * Read-without-limit-nudge extension for pi.
 *
 * When the LLM calls `read` on a large file without `offset` / `limit`,
 * append a short steer reminding it that `rg -n` (or `read` with a
 * window) is usually the better first move. Does not block or auto-
 * retry — the current read still succeeds; we just surface the
 * better pattern for the NEXT call.
 *
 * Signal sources:
 *
 *   1. Preferred: `details.truncation.totalLines` / `.totalBytes` on
 *      pi's own `ReadToolDetails`. Pi only populates `truncation` when
 *      it actually truncated or the user's `limit` stopped early. So
 *      this branch mostly fires on the "you got truncated, next time
 *      be targeted" case — which is the strongest signal.
 *
 *   2. Fallback: when pi didn't populate truncation (file fits within
 *      default 2000-line / 50KB caps), we count lines directly from
 *      the read result content (pi already gave them to us) and
 *      `statSync` the file for byte size — no second disk read.
 *
 * Decision logic lives in
 * `lib/node/pi/read-limit-nudge.ts` and is unit-tested under
 * `vitest` without pulling in the pi runtime.
 *
 * Composition:
 *   - Appends a SECOND text part to the tool result, leaving pi's
 *     original content untouched at index 0. Composes with
 *     `read-reread-detector` (which also appends) and with
 *     `tool-output-condenser` (which rewrites only the first text
 *     part).
 *
 * Environment:
 *   PI_READ_LIMIT_NUDGE_DISABLED=1     skip the extension entirely
 *   PI_READ_LIMIT_NUDGE_MIN_LINES=N    nudge when totalLines ≥ N
 *                                      (default 400)
 *   PI_READ_LIMIT_NUDGE_MIN_BYTES=N    nudge when totalBytes ≥ N
 *                                      (default 20480 = 20KB)
 *   PI_READ_LIMIT_NUDGE_DEBUG=1        ctx.ui.notify on every decision
 *   PI_READ_LIMIT_NUDGE_TRACE=<path>   append one line per decision
 */

import { appendFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { type ExtensionAPI, type ExtensionContext, isReadToolResult } from '@mariozechner/pi-coding-agent';
import {
  classifyRead,
  DEFAULT_MIN_BYTES,
  DEFAULT_MIN_LINES,
  type TruncationLike,
} from '../../../lib/node/pi/read-limit-nudge.ts';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function displayPath(abs: string, cwd: string): string {
  if (!isAbsolute(abs)) return abs;
  const rel = relative(cwd, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..')) return abs;
  return rel;
}

export default function readWithoutLimitNudge(pi: ExtensionAPI): void {
  if (process.env.PI_READ_LIMIT_NUDGE_DISABLED === '1') return;

  const minLines = parsePositiveInt(process.env.PI_READ_LIMIT_NUDGE_MIN_LINES, DEFAULT_MIN_LINES);
  const minBytes = parsePositiveInt(process.env.PI_READ_LIMIT_NUDGE_MIN_BYTES, DEFAULT_MIN_BYTES);
  const debug = process.env.PI_READ_LIMIT_NUDGE_DEBUG === '1';
  const tracePath = process.env.PI_READ_LIMIT_NUDGE_TRACE;

  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[read-limit-nudge] ${msg}\n`, 'utf8');
    } catch {
      /* never break a turn */
    }
  };

  const notify = (ctx: ExtensionContext, msg: string): void => {
    if (debug && ctx.hasUI) ctx.ui.notify(msg, 'info');
  };

  pi.on('tool_result', (event, ctx) => {
    if (!isReadToolResult(event)) return undefined;
    if (event.isError) return undefined;

    const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
    const rawPath = typeof input.path === 'string' ? input.path : undefined;
    if (!rawPath) return undefined;
    const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    const offset = typeof input.offset === 'number' ? input.offset : undefined;
    const limit = typeof input.limit === 'number' ? input.limit : undefined;

    // Prefer pi's own truncation report. It carries the authoritative
    // total line count when present. If absent, we still know the file
    // fit under pi's default cap — in that case we count lines from the
    // result content (pi already gave them to us) and fall back to
    // `statSync` for byte size.
    let truncation: TruncationLike;
    const piTrunc = event.details?.truncation;
    if (piTrunc) {
      truncation = {
        totalLines: piTrunc.totalLines,
        totalBytes: piTrunc.totalBytes,
        truncated: piTrunc.truncated,
      };
    } else {
      // Count lines from the first text part of event.content. That's the
      // file content pi just served to the model — avoids a second read.
      // `split('\n').length` overcounts by one for text that ends in a
      // newline (the common case); correct for that so the threshold
      // compares against the real line count.
      let totalLines: number | undefined;
      const first = event.content[0];
      if (first && first.type === 'text' && typeof first.text === 'string') {
        const text = first.text;
        if (text.length === 0) totalLines = 0;
        else totalLines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      }
      let totalBytes: number | undefined;
      try {
        totalBytes = statSync(abs).size;
      } catch {
        trace(`skip: stat failed path=${abs}`);
        return undefined;
      }
      truncation = { totalLines, totalBytes, truncated: false };
    }

    const decision = classifyRead(
      { displayPath: displayPath(abs, ctx.cwd), offset, limit, truncation },
      { minLines, minBytes },
    );

    if (decision.kind === 'skip') {
      trace(`skip reason=${decision.reason} path=${abs}`);
      return undefined;
    }

    trace(`nudge reason=${decision.reason} path=${abs}`);
    notify(ctx, `read-limit-nudge: ${decision.reason} for ${abs}`);

    return {
      content: [...event.content, { type: 'text', text: `\n${decision.nudge}` }],
    };
  });
}
