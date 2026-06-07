/**
 * Cross-extension singleton tracking the currently-active roleplay cast
 * (and, later, the POV character). The `roleplay` extension publishes
 * here on `session_start` / cast switch / shutdown; `persona` and
 * `avatar` can read it to drive cast-aware behaviour.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key for the same
 * reason `persona/active.ts` is: pi's extension loader gives each
 * extension its own jiti instance with `moduleCache: false`, so a plain
 * module-level variable would NOT be shared across extensions.
 *
 * Pure module - no pi imports.
 */

import { createGlobalSlot } from '../global-slot.ts';

export interface ActiveRoleplaySnapshot {
  readonly cast: string;
  /** POV / player character id, when one is declared (Phase 5). */
  readonly pov?: string;
}

interface ActiveRoleplaySlot {
  active?: ActiveRoleplaySnapshot;
}

const getSlot = createGlobalSlot<ActiveRoleplaySlot>('@dotfiles/pi/roleplay/active', () => ({}));

export function setActiveRoleplay(snapshot: ActiveRoleplaySnapshot | undefined): void {
  const slot = getSlot();
  slot.active = snapshot ? { cast: snapshot.cast, pov: snapshot.pov } : undefined;
}

export function getActiveRoleplay(): ActiveRoleplaySnapshot | undefined {
  return getSlot().active;
}

export function clearActiveRoleplay(): void {
  getSlot().active = undefined;
}
