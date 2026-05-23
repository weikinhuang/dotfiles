/**
 * Read-reread-detector extension for pi.
 *
 * Small self-hosted models (qwen3-30B-A3B, gpt-oss-20B, …) regularly
 * `read` the same file 3–5 times across a single task - once to orient,
 * again after forgetting, again on a follow-up. `loop-breaker` catches
 * only IDENTICAL repeats (same `(toolName, input)` hash 3× in a row).
 * This extension catches the broader case: same file, same contents,
 * possibly different slice, spread across turns.
 *
 * Mechanism:
 *
 *   1. On every successful `read` result we stat the file and record
 *      its `(absPath, mtimeMs, size)` signature plus the
 *      offset/limit the model asked for and the current turn number.
 *
 *   2. On the NEXT `read` of the same path we classify it:
 *        - first-time        → record + pass through
 *        - same-slice        → nudge: "you already read this slice N
 *                              turns ago; use scratchpad for carry-over"
 *        - different-slice   → softer nudge suggesting `rg` or
 *                              scratchpad carry-over
 *        - changed (mtime/size differ) → silent, record the new sig
 *
 * Composition:
 *   - Complements `loop-breaker` (which catches unchanged inputs within
 *     a short window, across any tool).
 *   - Composes with `tool-output-condenser`: we append our nudge as an
 *     extra text part; the condenser operates on the first text part
 *     only.
 *   - Does NOT mutate `event.isError`, so `verify-before-claim` +
 *     `stall-recovery` stay oblivious.
 *
 * Environment:
 *   PI_READ_REREAD_DISABLED=1     skip the extension entirely
 *   PI_READ_REREAD_MAX_ENTRIES=N  cap on tracked files (default 256)
 *   PI_READ_REREAD_DEBUG=1        ctx.ui.notify every decision
 *   PI_READ_REREAD_TRACE=<path>   append one line per decision to <path>
 */

import { isAbsolute, resolve } from 'node:path';

import { type ExtensionAPI, isReadToolResult } from '@earendil-works/pi-coding-agent';

import { safeStatSync } from '../../../lib/node/pi/fs-safe.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { displayPath } from '../../../lib/node/pi/path-display.ts';
import { type FileSignature, formatNudge, ReadHistory, type RereadProbe } from '../../../lib/node/pi/read-reread.ts';
import { makeDiagnostics } from '../../../lib/node/pi/recovery-diagnostics.ts';

const DEFAULT_MAX_ENTRIES = 256;

export default function readRereadDetector(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_READ_REREAD_DISABLED)) return;

  const maxEntries = parsePositiveInt(process.env.PI_READ_REREAD_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
  const { trace, notify } = makeDiagnostics({
    label: 'read-reread',
    tracePath: process.env.PI_READ_REREAD_TRACE,
    debug: envTruthy(process.env.PI_READ_REREAD_DEBUG),
  });

  let history = new ReadHistory(maxEntries);
  let turn = 0;

  pi.on('session_start', () => {
    history = new ReadHistory(maxEntries);
    turn = 0;
  });

  // Any real user input starts a fresh turn for "N turns ago" accounting.
  // Extension-synthesized messages do NOT bump - they're part of the same
  // logical turn the model is thinking through.
  pi.on('input', (event) => {
    if (event.source === 'extension') return;
    turn++;
  });

  pi.on('tool_result', (event, ctx) => {
    if (!isReadToolResult(event)) return undefined;
    if (event.isError) return undefined; // only care about successful reads

    const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
    const rawPath = typeof input.path === 'string' ? input.path : undefined;
    if (!rawPath) return undefined;
    const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

    const s = safeStatSync(abs);
    if (!s) {
      trace(`skip: stat failed path=${abs}`);
      return undefined;
    }

    const sig: FileSignature = { path: abs, mtimeMs: s.mtimeMs, size: s.size };
    const offset = typeof input.offset === 'number' ? input.offset : undefined;
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const probe: RereadProbe = { sig, offset, limit, turn };

    const decision = history.classify(probe);
    trace(`decision=${decision.kind} path=${abs} offset=${offset ?? '-'} limit=${limit ?? '-'} turn=${turn}`);

    // Always update history with the latest read (even if we're nudging).
    history.record(probe);

    if (decision.kind !== 'same-slice' && decision.kind !== 'different-slice') {
      return undefined;
    }

    const nudge = formatNudge({
      displayPath: displayPath(abs, ctx.cwd),
      decision,
      currentTurn: turn,
    });

    notify(ctx, `read-reread: ${decision.kind} for ${abs}`);

    return {
      content: [...event.content, { type: 'text', text: `\n${nudge}` }],
    };
  });

  pi.on('session_shutdown', () => {
    history.clear();
  });
}
