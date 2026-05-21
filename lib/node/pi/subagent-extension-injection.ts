/**
 * Cross-extension registry of "hook-only factories" injected into
 * subagent (`runOneShotAgent`) child sessions.
 *
 * Subagents created via pi's `runOneShotAgent` load with
 * `noExtensions: true`, so the parent's `tool_call` hooks (including
 * `bash-permissions`, `filesystem`, and `sandbox`) would not fire on
 * subagent bash calls without an explicit injection. Each security-gate
 * extension calls `registerSubagentInjection(...)` on load with a
 * hook-only factory that mounts ONLY its `tool_call` handler (no
 * statusline glue, no slash commands); `subagent-spawn.ts` threads
 * those factories into the child's `DefaultResourceLoader`.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key so all jiti'd
 * module copies share state (same pattern as `bash-gate.ts`,
 * `session-flags.ts`, `persona/active.ts`).
 *
 * The factory shape is intentionally `unknown` here - the only things
 * `lib/` knows about pi extensions is "they are factories that mount
 * onto a child session." The full pi types live in
 * `@earendil-works/pi-coding-agent`, which extension-tree code consumes
 * directly. Tests use a lightweight stand-in.
 */

/** Opaque factory marker. Subagent-spawn (Phase 2) narrows this to
 *  `ExtensionFactory` when it imports the registry. */
export type SubagentExtensionFactory = (...args: unknown[]) => unknown;

export interface RegisteredSubagentInjection {
  /** Stable id - used for de-dup and `unregisterSubagentInjection`. */
  id: string;
  factory: SubagentExtensionFactory;
}

interface SubagentInjectionSlot {
  entries: RegisteredSubagentInjection[];
}

const SLOT_KEY = Symbol.for('@dotfiles/pi/subagent-extension-injection');

function getSlot(): SubagentInjectionSlot {
  const g = globalThis as { [SLOT_KEY]?: SubagentInjectionSlot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = { entries: [] };
    g[SLOT_KEY] = slot;
  }
  return slot;
}

/**
 * Register a hook-only factory by id. Re-registering the same id
 * REPLACES the previous entry (so an extension that reloads via
 * `/reload` doesn't accumulate stale factories). The order across
 * different ids is "first-registered first" - parent-side extension
 * load order, which matches how pi's `tool_call` chain runs anyway.
 */
export function registerSubagentInjection(id: string, factory: SubagentExtensionFactory): void {
  if (!id) throw new Error('registerSubagentInjection: `id` is required');
  if (typeof factory !== 'function') {
    throw new Error('registerSubagentInjection: `factory` must be a function');
  }
  const slot = getSlot();
  const existing = slot.entries.findIndex((e) => e.id === id);
  if (existing >= 0) {
    slot.entries[existing] = { id, factory };
    return;
  }
  slot.entries.push({ id, factory });
}

/** Drop one registered factory by id. Returns whether anything was
 *  removed; primarily for tests + extension `session_shutdown` hooks. */
export function unregisterSubagentInjection(id: string): boolean {
  const slot = getSlot();
  const len = slot.entries.length;
  slot.entries = slot.entries.filter((e) => e.id !== id);
  return slot.entries.length < len;
}

/**
 * Snapshot the current factory list for a child session spawn. Returns
 * a fresh array (callers can mutate freely without affecting the
 * registry).
 */
export function collectSubagentInjections(): SubagentExtensionFactory[] {
  return getSlot().entries.map((e) => e.factory);
}

/** Variant that returns the ids alongside the factories. Used by tests
 *  and `/sandbox` introspection. */
export function listSubagentInjections(): RegisteredSubagentInjection[] {
  return [...getSlot().entries];
}

/** Reset the registry - tests only. */
export function clearSubagentInjections(): void {
  getSlot().entries = [];
}
