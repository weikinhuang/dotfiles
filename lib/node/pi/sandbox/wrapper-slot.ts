/**
 * Cross-extension sandbox wrapper slot.
 *
 * `sandbox.ts` (Phase 3) intercepts the built-in `bash` tool via
 * `pi.on('tool_call')` and rewrites `event.input.command` to wrap it
 * in `srt`. Extensions that spawn bash-equivalent subprocesses through
 * a different tool (`bg_bash` is the only one today) wouldn't go
 * through that interceptor and would bypass the kernel sandbox.
 *
 * This module exposes a tiny contract, mirroring `bash-gate.ts`:
 *
 *   - `installSandboxWrapper(fn)` - sandbox.ts registers its wrapper
 *     on extension load.
 *   - `requestSandboxWrap(command, ctx)` - bg-bash.ts (Phase 4) calls
 *     this before spawning the detached child.
 *   - `releaseSandboxWrap(result)` - every caller that got a
 *     `wrapped: true` result MUST call this exactly once after the
 *     wrapped command has exited (or will never run). It balances
 *     ASRT's per-wrap bookkeeping (`cleanupAfterCommand()` decrements
 *     the active-sandbox count that gates Linux mount-point cleanup)
 *     and releases the dangerous-file stub refcount. Skipping it leaks
 *     mount points + stubs until session end; calling it for a command
 *     that was never wrapped would let ASRT delete mount points another
 *     still-running sandbox depends on, so the installed release
 *     function ignores unknown / already-released handles.
 *
 * When no wrapper is installed (sandbox extension disabled, deps
 * missing, unsupported platform), the helper returns the command
 * unchanged - identity-wrap. That keeps `bg_bash` working when the
 * sandbox extension hasn't loaded.
 *
 * Pi's extension loader creates a fresh jiti instance per extension
 * with `moduleCache: false`, so two extensions importing this file
 * normally produce two independent module copies. We anchor the slot
 * on `globalThis` behind a `Symbol.for()` key so both copies see the
 * same installed function. Same pattern as `bash-gate.ts` and
 * `session-flags.ts`.
 */

/** Loose structural shape of pi's `ExtensionContext`, kept minimal so
 *  this module doesn't have to import from `@earendil-works/*`. */
export interface SandboxWrapContext {
  hasUI: boolean;
  cwd: string;
  /** Abort signal for the wrap itself (ASRT's Linux glob walk honors
   *  it). Optional - callers without one just don't get early abort. */
  signal?: AbortSignal;
}

/**
 * Decision the caller should honor when `wrapped` is false:
 *
 *   `identity` (default) - run the command as supplied.
 *   `warn`               - run unwrapped but surface `reason` to the user.
 *   `block`              - refuse to run the command (the wrap was REQUIRED
 *                          and failed, typically PI_SANDBOX_DEFAULT=block).
 *
 * Callers that ignore this field will silently downgrade `block` to
 * `identity`, defeating PI_SANDBOX_DEFAULT=block for the channel they own.
 */
export type SandboxWrapAction = 'identity' | 'warn' | 'block';

export interface SandboxWrapResult {
  /** Final shell-string to pass to `spawn`. Equal to `command` when
   *  the slot is empty (identity-wrap) or when `action !== 'identity'`. */
  command: string;
  /** True when the wrapper actually rewrote the command. When false,
   *  consult `action` to decide whether to run, warn, or block. */
  wrapped: boolean;
  /** Action the caller should take when `wrapped` is false. Omitted
   *  (treat as `'identity'`) on the happy path. */
  action?: SandboxWrapAction;
  /** Human-readable rationale to surface in notifications or block
   *  reasons. Always paired with `action !== 'identity'`. */
  reason?: string;
  /** Snapshot of the dangerous-file stub paths the wrapper touched
   *  (created or adopted via the EEXIST path) for THIS wrap. The
   *  `tool_call` hook stashes this on `event.input` via
   *  {@link stashCreatedStubs} so the matching `tool_result` hook can
   *  decrement their refcount and unlink the ones whose count drops
   *  to zero. Only set when `wrapped === true`. */
  createdStubs?: readonly string[];
  /** Opaque, unguessable per-wrap id handed to ASRT as `commandId`, so
   *  violations recorded while the command runs are attributed to it
   *  and {@link releaseSandboxWrap} can release exactly this wrap.
   *  Only set when `wrapped === true`. */
  commandId?: string;
}

/** The subset of a {@link SandboxWrapResult} needed to release a wrap. */
export interface SandboxWrapHandle {
  commandId?: string;
  createdStubs?: readonly string[];
}

export type SandboxWrapFn = (command: string, ctx: SandboxWrapContext) => Promise<SandboxWrapResult>;
export type SandboxReleaseFn = (handle: SandboxWrapHandle) => void;

import { createGlobalSlot } from '../global-slot.ts';

interface SandboxWrapperSlot {
  wrap?: SandboxWrapFn;
  release?: SandboxReleaseFn;
}

const getSlot = createGlobalSlot<SandboxWrapperSlot>('@dotfiles/pi/sandbox/wrapper', () => ({}));

/**
 * Install (or replace) the active sandbox wrapper. Safe to call on
 * every extension load - last caller wins. `sandbox.ts` clears the slot
 * on `session_shutdown` so a subsequent reload that disables the
 * sandbox via `PI_SANDBOX_DISABLED=1` takes effect.
 */
export function installSandboxWrapper(fn: SandboxWrapFn, release?: SandboxReleaseFn): void {
  const slot = getSlot();
  slot.wrap = fn;
  if (release) slot.release = release;
  else delete slot.release;
}

/** Remove the installed wrapper, if any. */
export function uninstallSandboxWrapper(): void {
  const slot = getSlot();
  delete slot.wrap;
  delete slot.release;
}

/** Is a wrapper currently installed? Primarily for tests + introspection. */
export function isSandboxWrapperInstalled(): boolean {
  return typeof getSlot().wrap === 'function';
}

/**
 * Ask the installed wrapper to rewrite `command`. When no wrapper is
 * installed we return `{ command, wrapped: false }` - identity wrap.
 * See module docstring for the reasoning.
 */
export async function requestSandboxWrap(command: string, ctx: SandboxWrapContext): Promise<SandboxWrapResult> {
  const wrap = getSlot().wrap;
  if (!wrap) return { command, wrapped: false };
  return wrap(command, ctx);
}

/**
 * Release a wrap previously returned by {@link requestSandboxWrap}.
 * No-op when the result was not wrapped, carries no `commandId`, or no
 * wrapper is installed (the sandbox extension tears everything down
 * itself on shutdown). Never throws.
 */
export function releaseSandboxWrap(handle: SandboxWrapHandle & { wrapped?: boolean }): void {
  if (handle.wrapped === false || !handle.commandId) return;
  const release = getSlot().release;
  if (!release) return;
  try {
    release(handle);
  } catch {
    // Best-effort bookkeeping; never break the caller's exit path.
  }
}
