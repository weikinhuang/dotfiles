/**
 * Cross-extension singleton tracking the currently-active persona's
 * resolved `writeRoots`, `bashAllow`, and `bashDeny` patterns.
 *
 * The `persona` extension publishes here on activate / deactivate. Other
 * extensions (notably `protected-paths` and `bash-permissions`) query
 * here so they can compose their own gates with the persona's: if a
 * persona has explicitly declared a directory as `writeRoots` or a
 * command pattern as `bashAllow`, that's a deliberate vouch and
 * downstream gates should treat the path / command as already approved
 * by the user-author of the persona file rather than prompting again.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key. Pi's extension
 * loader creates a fresh jiti instance per extension with
 * `moduleCache: false` (see `dist/core/extensions/loader.js`), so
 * importing this file from two extensions produces two independent
 * module copies and a plain module-level variable would NOT share state
 * across them. Same pattern as `bash-gate.ts` and `session-flags.ts`.
 *
 * Stored copy is defensive (every list is cloned into a frozen array)
 * so callers can't accidentally mutate the snapshot.
 */
export interface ActivePersonaSnapshot {
  readonly name: string;
  readonly resolvedWriteRoots: readonly string[];
  readonly bashAllow: readonly string[];
  readonly bashDeny: readonly string[];
}

interface ActivePersonaSlot {
  active?: ActivePersonaSnapshot;
}

const SLOT_KEY = Symbol.for('@dotfiles/pi/persona/active');

function getSlot(): ActivePersonaSlot {
  const g = globalThis as { [SLOT_KEY]?: ActivePersonaSlot };
  let slot = g[SLOT_KEY];
  if (!slot) {
    slot = {};
    g[SLOT_KEY] = slot;
  }
  return slot;
}

export interface ActivePersonaInput {
  name: string;
  resolvedWriteRoots: readonly string[];
  bashAllow?: readonly string[];
  bashDeny?: readonly string[];
}

export function setActivePersona(snapshot: ActivePersonaInput | undefined): void {
  const slot = getSlot();
  if (!snapshot) {
    slot.active = undefined;
    return;
  }
  slot.active = {
    name: snapshot.name,
    resolvedWriteRoots: Object.freeze([...snapshot.resolvedWriteRoots]),
    bashAllow: Object.freeze([...(snapshot.bashAllow ?? [])]),
    bashDeny: Object.freeze([...(snapshot.bashDeny ?? [])]),
  };
}

export function getActivePersona(): ActivePersonaSnapshot | undefined {
  return getSlot().active;
}

export function clearActivePersona(): void {
  getSlot().active = undefined;
}
