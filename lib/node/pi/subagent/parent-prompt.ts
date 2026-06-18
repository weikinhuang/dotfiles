/**
 * Cross-extension bridge that lets a spawned subagent's security gates
 * (`bash-permissions`, `filesystem`) prompt the PARENT session's
 * interactive UI for approval, instead of silently falling through to
 * the non-interactive default (`PI_*_DEFAULT`, normally deny).
 *
 * The problem this solves: subagent child sessions are created with
 * `createAgentSession` and never get a UI context wired in, so
 * `ctx.hasUI` is `false` inside the child. The injected gate handlers
 * therefore can't show their own approval dialog. This bridge routes
 * the child's approval request to the parent's UI (the parent IS
 * interactive), labelled with which subagent is asking, and serializes
 * concurrent requests so parallel children prompt one at a time.
 *
 * Wiring:
 *   - The `subagent` extension publishes the parent UI on
 *     `session_start` (`setParentPromptUI`) and registers each child's
 *     identity keyed by the child session id around spawn
 *     (`registerChildPromptIdentity`).
 *   - The gate extensions, on a `!ctx.hasUI` tool call, call
 *     `resolveParentPrompt(sessionId)`; when it returns a target they
 *     prompt that UI inside `runSerialPrompt(...)`.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key (via
 * `createGlobalSlot`) for the same reason as `active-agent.ts` /
 * `bash-gate.ts`: pi's extension loader gives each extension its own
 * jiti module copy (`moduleCache: false`), so plain module-level state
 * would NOT be shared across the publishing extension and the consuming
 * gate extensions.
 *
 * Pure module - no pi imports. The parent UI is stored as a structural
 * slice (`ParentPromptUI`) so this stays vitest-able without the pi
 * runtime.
 */

import { createGlobalSlot } from '../global-slot.ts';

/**
 * Structural slice of pi's `ExtensionUIContext` that the bridge needs.
 * Method shapes are a subset of pi's (extra optional params on pi's
 * side are assignable), so publishing `ctx.ui` satisfies this.
 */
export interface ParentPromptUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error' | 'success'): void;
}

/** Identity of a spawned subagent child, used to label the prompt. */
export interface ChildPromptIdentity {
  /** Agent type name (e.g. `explore`). */
  agent: string;
  /** Short handle (e.g. `sub_explore_1`). */
  handle: string;
  /** Where the agent definition came from. */
  source?: 'global' | 'user' | 'project';
}

interface ParentPromptSlot {
  /** Parent interactive UI, or undefined when no parent UI is available
   *  (headless `pi -p`, or the feature is disabled). */
  ui?: ParentPromptUI;
  /** childSessionId -> identity, for every live subagent child. */
  children: Map<string, ChildPromptIdentity>;
  /** Promise chain serializing concurrent prompts to the parent UI. */
  queue: Promise<unknown>;
}

const getSlot = createGlobalSlot<ParentPromptSlot>('@dotfiles/pi/subagent/parent-prompt', () => ({
  children: new Map<string, ChildPromptIdentity>(),
  queue: Promise.resolve(),
}));

/**
 * Publish (or clear) the parent's interactive UI. The `subagent`
 * extension calls this with `ctx.ui` on `session_start` when the parent
 * has a UI and the feature is enabled, and with `undefined` on
 * `session_shutdown` (or when disabled / headless).
 */
export function setParentPromptUI(ui: ParentPromptUI | undefined): void {
  getSlot().ui = ui;
}

/** Whether a parent UI is currently published. */
export function hasParentPromptUI(): boolean {
  return getSlot().ui !== undefined;
}

/** Register a subagent child so its gate calls can be routed + labelled. */
export function registerChildPromptIdentity(sessionId: string, identity: ChildPromptIdentity): void {
  if (!sessionId) return;
  getSlot().children.set(sessionId, identity);
}

/** Drop a child's registration (call when the child run settles). */
export function unregisterChildPromptIdentity(sessionId: string): void {
  if (!sessionId) return;
  getSlot().children.delete(sessionId);
}

/** Drop every child registration (session shutdown / reload). */
export function clearChildPromptIdentities(): void {
  getSlot().children.clear();
}

/** Human-readable requester label prefixed onto the approval dialog. */
export function formatRequesterLabel(identity: ChildPromptIdentity): string {
  const src = identity.source ? `, ${identity.source}` : '';
  return `subagent ${identity.agent} (${identity.handle}${src})`;
}

/**
 * Resolve the parent-prompt target for a tool call coming from a
 * (UI-less) session. Returns the parent UI + a requester label only
 * when BOTH a parent UI is published AND `sessionId` names a registered
 * subagent child. Returns `undefined` otherwise - callers fall back to
 * their existing non-UI default (block / allow).
 */
export function resolveParentPrompt(
  sessionId: string | undefined,
): { ui: ParentPromptUI; requester: string } | undefined {
  const slot = getSlot();
  if (!slot.ui || !sessionId) return undefined;
  const identity = slot.children.get(sessionId);
  if (!identity) return undefined;
  return { ui: slot.ui, requester: formatRequesterLabel(identity) };
}

/**
 * Run `fn` after every previously-enqueued prompt has settled, so
 * concurrent subagents prompt the single parent UI one at a time. A
 * rejected prompt does not break the chain - the next queued prompt
 * still runs.
 */
export function runSerialPrompt<T>(fn: () => Promise<T>): Promise<T> {
  const slot = getSlot();
  const run = slot.queue.then(fn, fn);
  // Keep the chain alive regardless of this prompt's outcome.
  slot.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Reset the whole slot - tests only. */
export function resetParentPromptForTest(): void {
  const slot = getSlot();
  slot.ui = undefined;
  slot.children.clear();
  slot.queue = Promise.resolve();
}
