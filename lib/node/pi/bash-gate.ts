/**
 * Cross-extension bash approval gate.
 *
 * `bash-permissions.ts` already intercepts the built-in `bash` tool via
 * `pi.on('tool_call')`, walking the command through a layered allow /
 * deny / hardcoded-deny / session-auto pipeline and prompting the user
 * when needed. Extensions that run bash-equivalent payloads under a
 * different tool name (e.g. `bg_bash`) wouldn't go through that
 * interceptor and would bypass the user's policy entirely.
 *
 * This module exposes a tiny contract:
 *
 *   - `installBashGate(fn)` - called once by `bash-permissions.ts` on
 *     load to register its gating function.
 *   - `requestBashApproval(command, ctx)` - called by any other
 *     extension that wants to run bash, before spawning the process.
 *
 * When no gate is installed (i.e. `PI_BASH_PERMISSIONS_DISABLED=1` or
 * the user hasn't deployed the permissions extension at all), the
 * helper returns `{ allowed: true }`. That matches the built-in `bash`
 * tool's behavior in the same scenario - if bash-permissions is off,
 * both tools are equally ungated.
 *
 * Because pi's extension loader creates a fresh jiti instance per
 * extension (with `moduleCache: false`), importing this file from two
 * extensions produces two independent module copies. We anchor the
 * slot on `globalThis` behind a `Symbol.for()` key so both copies see
 * the same installed function. Same pattern as `session-flags.ts`.
 */

// Narrow structural shape of what the gate needs from an
// `ExtensionContext`. Typed loosely so this module doesn't have to
// import from `@earendil-works/pi-coding-agent` (which keeps it testable
// under vitest without the pi runtime).
export interface BashGateContext {
  hasUI: boolean;
  cwd: string;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, level?: 'info' | 'warning' | 'error' | 'success'): void;
  };
}

export type BashGateDecision = { allowed: true } | { allowed: false; reason: string };

export type BashGateFn = (command: string, ctx: BashGateContext) => Promise<BashGateDecision>;

interface BashGateSlot {
  gate?: BashGateFn;
}

const SLOT_KEY = Symbol.for('@dotfiles/pi/bash-gate');

function getSlot(): BashGateSlot {
  const g = globalThis as { [SLOT_KEY]?: BashGateSlot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = {};
    g[SLOT_KEY] = slot;
  }
  return slot;
}

/**
 * Install (or replace) the active gate function. Safe to call on every
 * extension load - the last caller wins. `bash-permissions.ts` clears
 * the slot on `session_shutdown` so a subsequent reload that disables
 * the gate via `PI_BASH_PERMISSIONS_DISABLED=1` takes effect.
 */
export function installBashGate(fn: BashGateFn): void {
  getSlot().gate = fn;
}

/** Remove the installed gate, if any. */
export function uninstallBashGate(): void {
  delete getSlot().gate;
}

/** Is a gate currently installed? Primarily for tests + introspection. */
export function isBashGateInstalled(): boolean {
  return typeof getSlot().gate === 'function';
}

/**
 * Ask the installed gate to approve `command`. When no gate is
 * installed we return `{ allowed: true }` - see module docstring for
 * the reasoning.
 */
export async function requestBashApproval(command: string, ctx: BashGateContext): Promise<BashGateDecision> {
  const gate = getSlot().gate;
  if (!gate) return { allowed: true };
  return gate(command, ctx);
}
