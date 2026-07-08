/**
 * Shared resolver for the active layered filesystem policy.
 *
 * Both `filesystem.ts` (the read/write/edit gate) and `apply-patch.ts`
 * (the per-path write gate) build the SAME two-layer policy stack -
 * user `<piAgentDir>/filesystem.json` + project `<repo>/.pi/filesystem.json`
 * - and fold the active persona's `writeRoots` into `write.allow.paths`
 * as a positive vouch. This module holds that identical layering in one
 * place.
 *
 * Pure module - no pi imports, no direct disk / global reads. The layer
 * reader and the active-persona getter are injected so the resolver is
 * unit-testable with plain fakes; the two callers pass their real
 * `readTextOrEmpty` and `getActivePersona`.
 */

import {
  type FilesystemPolicyLayer,
  type LoadFilesystemPolicyResult,
  filesystemProjectPolicyPath,
  filesystemUserPolicyPath,
  loadFilesystemPolicy,
} from './load.ts';

/** Minimal structural slice of the active-persona snapshot the resolver
 *  needs to build the `writeRoots` overlay. Matches the relevant fields
 *  of `persona/active.ts`'s `ActivePersonaSnapshot`. */
export interface ActivePersonaWriteRoots {
  name: string;
  resolvedWriteRoots: readonly string[];
}

export interface ResolveActiveFilesystemPolicyDeps {
  /** Read a policy layer file's raw contents; empty string when absent. */
  readLayer: (path: string) => string;
  /** The currently-active persona, or undefined when none is active. */
  getActivePersona: () => ActivePersonaWriteRoots | undefined;
}

/**
 * Resolve the active filesystem policy for `cwd`, folding in the active
 * persona's `writeRoots` (positive vouch into `write.allow.paths`).
 * Layer order is user then project; persona overlay merges last. Returns
 * the loaded policy plus any layer-parse warnings for the caller to
 * surface.
 */
export function resolveActiveFilesystemPolicy(
  cwd: string,
  deps: ResolveActiveFilesystemPolicyDeps,
): LoadFilesystemPolicyResult {
  const userPath = filesystemUserPolicyPath();
  const projectPath = filesystemProjectPolicyPath(cwd);
  const layers: FilesystemPolicyLayer[] = [
    { source: userPath, raw: deps.readLayer(userPath) },
    { source: projectPath, raw: deps.readLayer(projectPath) },
  ];
  const active = deps.getActivePersona();
  return loadFilesystemPolicy(layers, {
    personaOverlay:
      active && active.resolvedWriteRoots.length > 0
        ? { source: `persona:${active.name}`, paths: active.resolvedWriteRoots }
        : undefined,
  });
}
