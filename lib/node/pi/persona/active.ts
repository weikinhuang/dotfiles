/**
 * Cross-extension singleton tracking the currently-active persona's
 * resolved `writeRoots`.
 *
 * The `persona` extension publishes here on activate / deactivate. Other
 * extensions (notably `protected-paths`) query here so they can compose
 * their own gates with the persona's: if a persona has explicitly
 * declared a directory as `writeRoots`, that's a deliberate vouch and
 * downstream gates should treat the path as already approved by the
 * user-author of the persona file rather than prompting again.
 *
 * Why a module-level singleton instead of an event / context channel:
 * pi extensions live in the same Node process and currently have no
 * supported cross-extension communication primitive. A singleton in a
 * shared `lib/node/pi/` module is the smallest thing that works and
 * stays unit-testable. Tests should call `clearActivePersona()` between
 * cases to avoid bleed.
 *
 * Stored copy is defensive (`resolvedWriteRoots` is cloned into a
 * frozen array) so callers can't accidentally mutate the snapshot.
 */
export interface ActivePersonaSnapshot {
  readonly name: string;
  readonly resolvedWriteRoots: readonly string[];
}

let active: ActivePersonaSnapshot | undefined;

export function setActivePersona(snapshot: { name: string; resolvedWriteRoots: readonly string[] } | undefined): void {
  if (!snapshot) {
    active = undefined;
    return;
  }
  active = {
    name: snapshot.name,
    resolvedWriteRoots: Object.freeze([...snapshot.resolvedWriteRoots]),
  };
}

export function getActivePersona(): ActivePersonaSnapshot | undefined {
  return active;
}

export function clearActivePersona(): void {
  active = undefined;
}
