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
}

export interface SandboxWrapResult {
  /** Final shell-string to pass to `spawn`. Equal to `command` when
   *  the slot is empty (identity-wrap). */
  command: string;
  /** True when the wrapper actually rewrote the command. */
  wrapped: boolean;
}

export type SandboxWrapFn = (command: string, ctx: SandboxWrapContext) => Promise<SandboxWrapResult>;

interface SandboxWrapperSlot {
  wrap?: SandboxWrapFn;
}

const SLOT_KEY = Symbol.for('@dotfiles/pi/sandbox/wrapper');

function getSlot(): SandboxWrapperSlot {
  const g = globalThis as { [SLOT_KEY]?: SandboxWrapperSlot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = {};
    g[SLOT_KEY] = slot;
  }
  return slot;
}

/**
 * Install (or replace) the active sandbox wrapper. Safe to call on
 * every extension load - last caller wins. `sandbox.ts` clears the slot
 * on `session_shutdown` so a subsequent reload that disables the
 * sandbox via `PI_SANDBOX_DISABLED=1` takes effect.
 */
export function installSandboxWrapper(fn: SandboxWrapFn): void {
  getSlot().wrap = fn;
}

/** Remove the installed wrapper, if any. */
export function uninstallSandboxWrapper(): void {
  delete getSlot().wrap;
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
