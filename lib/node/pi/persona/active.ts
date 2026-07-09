/**
 * Cross-extension singleton tracking the currently-active persona's
 * resolved `writeRoots`, `bashAllow`, and `bashDeny` patterns.
 *
 * The `persona` extension publishes here on activate / deactivate. Other
 * extensions (notably `filesystem` and `bash-permissions`) query
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
  /** True when this persona opted into the roleplay extension (`roleplay: true`). */
  readonly roleplay: boolean;
  /** Cast slug override for the roleplay store; defaults to the persona name. */
  readonly cast?: string;
  /** Character names / ids whose full sheets fold into the scene block. */
  readonly characters?: readonly string[];
  /** The character the human plays; announced + folded last in the scene block. */
  readonly pov?: string;
  /** Greeting lines surfaced via `/persona opener`. */
  readonly openers?: readonly string[];
  /** Standing author's note injected at conversational depth by the roleplay extension. */
  readonly authorNote?: string;
  /** Depth (messages from the end) for `authorNote`. Default applied by the consumer. */
  readonly authorNoteDepth?: number;
}

import { createGlobalSlot } from '../global-slot.ts';

interface ActivePersonaSlot {
  active?: ActivePersonaSnapshot;
}

const getSlot = createGlobalSlot<ActivePersonaSlot>('@dotfiles/pi/persona/active', () => ({}));

export interface ActivePersonaInput {
  name: string;
  resolvedWriteRoots: readonly string[];
  bashAllow?: readonly string[];
  bashDeny?: readonly string[];
  roleplay?: boolean;
  cast?: string;
  characters?: readonly string[];
  pov?: string;
  openers?: readonly string[];
  authorNote?: string;
  authorNoteDepth?: number;
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
    roleplay: snapshot.roleplay ?? false,
    cast: snapshot.cast,
    characters: snapshot.characters ? Object.freeze([...snapshot.characters]) : undefined,
    pov: snapshot.pov,
    openers: snapshot.openers ? Object.freeze([...snapshot.openers]) : undefined,
    authorNote: snapshot.authorNote,
    authorNoteDepth: snapshot.authorNoteDepth,
  };
}

export function getActivePersona(): ActivePersonaSnapshot | undefined {
  return getSlot().active;
}

export function clearActivePersona(): void {
  getSlot().active = undefined;
}
