/**
 * Per-wrap size diagnostic for the sandbox.ts E2BIG investigation.
 *
 * Background: bwrap can fail with E2BIG when the rendered argv +
 * environment exceeds `MAX_ARG_STRLEN` (Linux's per-argument cap,
 * 128KB on x86_64). The cap is hit in practice when our deny-list
 * compiler emits enough literal paths that the rendered argv crosses
 * the threshold. This logger records the input vs output size of
 * every wrap call when the env-var is set, plus the rule-list counts,
 * so a failed wrap can be correlated with deny-list bloat.
 *
 * Activation:
 *   PI_SANDBOX_E2BIG_DEBUG=/path/to/log     log to that path
 *   PI_SANDBOX_E2BIG_DEBUG=1                log to /tmp/sandbox-e2big.log
 *   (unset)                                 no-op
 *
 * Pure module: pi-free, depends only on `node:fs`. Best-effort -
 * an EIO during the append never breaks the wrap.
 */

import { appendFileSync } from 'node:fs';

/** Subset of the resolved ASRT config the logger inspects. */
export interface E2bigAsrtConfigShape {
  filesystem?: {
    denyRead?: unknown[];
    denyWrite?: unknown[];
    allowWrite?: unknown[];
  };
}

/** Snapshot of the runtime-state fields the logger reads. Keeping the
 *  shape narrow lets `sandbox.ts` pass `{ wrapsAttempted, lastResolved }`
 *  without leaking the full RuntimeState type into lib. */
export interface E2bigRuntimeSnapshot {
  /** Counter for how many wrap attempts we've made this session. */
  wrapsAttempted: number;
  /** Most-recently-resolved ASRT config (may be undefined before the
   *  first reconfigure pass). */
  lastResolvedAsrtConfig: unknown;
}

/**
 * Log a single line for one wrap call to `PI_SANDBOX_E2BIG_DEBUG` if
 * set. No-op when the env var is unset. Format:
 *
 *   <iso-timestamp> call=<n> in=<bytes> out=<bytes> \\
 *     denyRead=<count> denyWrite=<count> allowWrite=<count> \\
 *     pid=<pid> inHead="<first 80 chars of command>"
 *
 * Best-effort: any append failure is swallowed.
 */
export function logE2bigWrap(snapshot: E2bigRuntimeSnapshot, input: string, output: string): void {
  const raw = process.env.PI_SANDBOX_E2BIG_DEBUG;
  if (!raw) return;
  const path = raw === '1' ? '/tmp/sandbox-e2big.log' : raw;
  const fs = (snapshot.lastResolvedAsrtConfig as E2bigAsrtConfigShape | undefined)?.filesystem;
  const denyRead = Array.isArray(fs?.denyRead) ? fs.denyRead.length : -1;
  const denyWrite = Array.isArray(fs?.denyWrite) ? fs.denyWrite.length : -1;
  const allowWrite = Array.isArray(fs?.allowWrite) ? fs.allowWrite.length : -1;
  const inHead = input.replace(/\s+/g, ' ').slice(0, 80);
  const line =
    `${new Date().toISOString()} call=${snapshot.wrapsAttempted} ` +
    `in=${input.length} out=${output.length} ` +
    `denyRead=${denyRead} denyWrite=${denyWrite} allowWrite=${allowWrite} ` +
    `pid=${process.pid} inHead=${JSON.stringify(inHead)}\n`;
  try {
    appendFileSync(path, line);
  } catch {
    // Best-effort - any IO failure is non-fatal.
  }
}
