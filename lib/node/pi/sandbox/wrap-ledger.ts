/**
 * Per-wrap bookkeeping for the sandbox extension.
 *
 * Every successful `SandboxManager.wrapWithSandbox()` call has two
 * side effects that must be undone exactly once, after the wrapped
 * command exits:
 *
 *   1. ASRT increments an internal active-sandbox count on Linux.
 *      `cleanupAfterCommand()` decrements it and, at zero, deletes the
 *      host-side mount points bwrap created for absent deny paths.
 *      Deleting a mount point while another bwrap is still running
 *      detaches that sandbox's bind mount, so the deny stops applying
 *      inside it. Calling `cleanupAfterCommand()` for a command that was
 *      never wrapped is therefore unsafe, and never calling it leaks
 *      mount points for the rest of the session.
 *   2. The extension bumps a refcount for each dangerous-file stub it
 *      pre-created for the wrap (see `stub-refcount.ts`).
 *
 * The ledger keys each wrap by its ASRT `commandId` so a release is
 * applied at most once, and only for a wrap that actually happened -
 * whichever channel (bash tool_result, bg-bash job exit, subagent
 * tool_result) ends up releasing it.
 *
 * Pure module - no pi imports - so it's unit-testable under vitest.
 */

import { decStubRefs, incStubRefs } from './stub-refcount.ts';

export interface WrapLedger {
  /** commandId -> stubs the wrap touched. Presence = wrap in flight. */
  inflight: Map<string, readonly string[]>;
  /** Shared stub refcount (see `stub-refcount.ts`). */
  stubRefs: Map<string, number>;
}

export function createWrapLedger(): WrapLedger {
  return { inflight: new Map(), stubRefs: new Map() };
}

/** Record a successful wrap. Re-recording an id is a no-op so a stray
 *  duplicate can't double-count the stub refs. */
export function recordWrap(ledger: WrapLedger, commandId: string, stubs: readonly string[]): void {
  if (ledger.inflight.has(commandId)) return;
  const snapshot = Object.freeze([...stubs]);
  ledger.inflight.set(commandId, snapshot);
  incStubRefs(ledger.stubRefs, snapshot);
}

export interface ReleaseOutcome {
  /** True when `commandId` was in flight and is now released. The
   *  caller must call ASRT's `cleanupAfterCommand()` exactly when this
   *  is true. */
  released: boolean;
  /** Stub paths whose refcount dropped to zero - safe to unlink. */
  stubsToRemove: string[];
}

/** Release a wrap recorded by {@link recordWrap}. Unknown or
 *  already-released ids return `{ released: false }`. */
export function releaseWrap(ledger: WrapLedger, commandId: string | undefined): ReleaseOutcome {
  if (!commandId) return { released: false, stubsToRemove: [] };
  const stubs = ledger.inflight.get(commandId);
  if (stubs === undefined) return { released: false, stubsToRemove: [] };
  ledger.inflight.delete(commandId);
  return { released: true, stubsToRemove: decStubRefs(ledger.stubRefs, stubs) };
}

/** Drop everything (session shutdown). Returns every stub path that was
 *  still referenced so the caller can unlink them. */
export function drainWrapLedger(ledger: WrapLedger): string[] {
  const stubs = [...ledger.stubRefs.keys()];
  ledger.inflight.clear();
  ledger.stubRefs.clear();
  return stubs;
}
