/**
 * Pure config defaults + coercion + layering for the `roleplay`
 * extension.
 *
 * The shell reads JSON from disk (user global `~/.pi/agent/roleplay.json`
 * -> project local `<cwd>/.pi/roleplay.json`), feeds each layer through
 * {@link coerceConfigLayer}, then {@link mergeConfigLayers}.
 * {@link loadRoleplayConfig} does the disk wiring so the shell stays
 * thin. A missing / malformed file degrades to an empty layer.
 *
 * Phase 1 exposes only `charBudget` (the injected `## Roleplay` block
 * cap). Phase 2 adds `loreCharBudget` (the fired-lore section cap) and
 * `maxRecursion` (bounded lorebook recursion). Phase 4 adds `scanDepth`
 * (recent messages scanned for depth-injected lore in the `context`
 * event).
 *
 * No pi imports.
 */

import { readJsonOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';
import { MAX_RECURSION_CAP } from './recursion.ts';

export interface RoleplayConfig {
  /** Soft cap on the injected `## Roleplay` cast-index block, in characters. */
  charBudget: number;
  /** Soft cap on the injected fired-lore section, in characters. */
  loreCharBudget: number;
  /** Bounded lorebook recursion passes (0 = off). Clamped to `MAX_RECURSION_CAP`. */
  maxRecursion: number;
  /** Recent messages scanned for depth-injected lore in the `context` event (Phase 4). */
  scanDepth: number;
}

/** Shipped defaults - lowest config layer. Parity with memory's 3000-char cap. */
export const DEFAULT_CONFIG: RoleplayConfig = {
  charBudget: 3000,
  loreCharBudget: 3000,
  maxRecursion: 0,
  scanDepth: 10,
};

/** Floor for the injected-block budgets so a tiny value can't blank them. */
export const MIN_CHAR_BUDGET = 500;

/** Upper bound on `scanDepth` so a stray config can't scan an unbounded history. */
export const MAX_SCAN_DEPTH = 100;

/** Validate an untrusted JSON layer into a `Partial<RoleplayConfig>`. */
export function coerceConfigLayer(raw: unknown): Partial<RoleplayConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const v = raw as Record<string, unknown>;
  const out: Partial<RoleplayConfig> = {};
  if (typeof v.charBudget === 'number' && Number.isFinite(v.charBudget)) {
    out.charBudget = Math.max(MIN_CHAR_BUDGET, Math.floor(v.charBudget));
  }
  if (typeof v.loreCharBudget === 'number' && Number.isFinite(v.loreCharBudget)) {
    out.loreCharBudget = Math.max(MIN_CHAR_BUDGET, Math.floor(v.loreCharBudget));
  }
  if (typeof v.maxRecursion === 'number' && Number.isFinite(v.maxRecursion)) {
    out.maxRecursion = Math.max(0, Math.min(MAX_RECURSION_CAP, Math.floor(v.maxRecursion)));
  }
  if (typeof v.scanDepth === 'number' && Number.isFinite(v.scanDepth)) {
    out.scanDepth = Math.max(1, Math.min(MAX_SCAN_DEPTH, Math.floor(v.scanDepth)));
  }
  return out;
}

/** Merge config layers low-to-high precedence (later wins). */
export function mergeConfigLayers(...layers: Partial<RoleplayConfig>[]): RoleplayConfig {
  return Object.assign({ ...DEFAULT_CONFIG }, ...layers) as RoleplayConfig;
}

/**
 * Load the effective config: shipped defaults <- user global <- project.
 * `envCharBudget` (from `PI_ROLEPLAY_MAX_INJECTED_CHARS`) sits between the
 * defaults and the file layers so a committed project config still wins
 * over a stray shell export.
 */
export function loadRoleplayConfig(cwd: string, envCharBudget?: number): RoleplayConfig {
  const envLayer: Partial<RoleplayConfig> =
    typeof envCharBudget === 'number' ? { charBudget: Math.max(MIN_CHAR_BUDGET, envCharBudget) } : {};
  const userLayer = coerceConfigLayer(readJsonOrUndefined(piAgentPath('roleplay.json')));
  const projectLayer = coerceConfigLayer(readJsonOrUndefined(piProjectPath(cwd, 'roleplay.json')));
  return mergeConfigLayers(envLayer, userLayer, projectLayer);
}
