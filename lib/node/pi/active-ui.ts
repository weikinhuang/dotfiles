/**
 * Cross-extension parent-UI singleton.
 *
 * `SandboxAskCallback` (the network-permission prompt fired by ASRT
 * when a sandboxed bash hits an un-allowlisted domain) lives on the
 * parent's `SandboxManager`. When the bash call originates inside a
 * subagent session, the callback's `ctx.ui.select` would otherwise
 * see the child's `hasUI: false` and dead-end. This slot publishes
 * the parent session's `ctx.ui` so subagent-triggered prompts can
 * surface in the parent's terminal.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key (same pattern
 * as `bash-gate.ts`, `session-flags.ts`, `persona/active.ts`).
 *
 * The shape of `ctx.ui` is reproduced structurally so this module
 * doesn't have to import from `@earendil-works/*`.
 */

export interface UIBridge {
  hasUI: boolean;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error' | 'success'): void;
}

interface ActiveUISlot {
  ui?: UIBridge;
}

const SLOT_KEY = Symbol.for('@dotfiles/pi/active-ui');

function getSlot(): ActiveUISlot {
  const g = globalThis as { [SLOT_KEY]?: ActiveUISlot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = {};
    g[SLOT_KEY] = slot;
  }
  return slot;
}

/**
 * Publish the parent session's UI bridge. Safe to call repeatedly -
 * last writer wins. Extensions invoke this on `before_agent_start`
 * and on the first `tool_call` that fires for the parent session.
 */
export function publishActiveUI(ui: UIBridge): void {
  getSlot().ui = ui;
}

/** Read the parent session's UI bridge, if any extension has
 *  published one yet. */
export function getActiveUI(): UIBridge | undefined {
  return getSlot().ui;
}

/** Drop the published UI; the next read returns undefined. The
 *  sandbox extension does this on `session_shutdown` so a subsequent
 *  reload doesn't hold a stale bridge. */
export function clearActiveUI(): void {
  delete getSlot().ui;
}

/**
 * Read the parent UI but only if it has an interactive frontend
 * (`hasUI: true`). Returns undefined when the parent itself is `-p`
 * mode. Used by `SandboxAskCallback` so non-UI parents fall through
 * to `PI_SANDBOX_NETWORK_DEFAULT` instead of awaiting on a select
 * that nothing can answer.
 */
export function getInteractiveActiveUI(): UIBridge | undefined {
  const ui = getSlot().ui;
  if (!ui) return undefined;
  return ui.hasUI ? ui : undefined;
}
