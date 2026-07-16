/**
 * Disk-layering loader for the `oai-params` extension. Reads the variant
 * definitions from `oai-params.json` (global agent dir, then project
 * `<cwd>/.pi/`, project wins by id) and resolves each variant's parent
 * against `models.json` (global then project providers, project wins per
 * provider). Malformed/missing files degrade to empty layers.
 *
 * `cwd` is injected so resolution is deterministic and unit-testable; the
 * shell passes `process.cwd()`. Agent-dir resolution honors
 * `PI_CODING_AGENT_DIR` via `piAgentPath`.
 *
 * No pi imports.
 */

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';

import { buildRegistrations } from './build-registration.ts';
import { parseVariants } from './config.ts';
import type { ParsedVariant, ProviderRegistrationSpec, VariantInjection } from './types.ts';

/**
 * Merge the `oai-params.json` maps from global then project (project
 * entries override global by id), and parse into validated variants.
 */
function loadVariants(cwd: string): { variants: ParsedVariant[]; errors: string[] } {
  const merged: Record<string, unknown> = {};
  for (const path of [piAgentPath('oai-params.json'), piProjectPath(cwd, 'oai-params.json')]) {
    const parsed = readJsoncOrUndefined(path);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    Object.assign(merged, parsed as Record<string, unknown>);
  }
  return parseVariants(merged);
}

/**
 * Merge the `providers` blocks from global then project `models.json`
 * (project overrides global per provider name).
 */
function loadProviders(cwd: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const path of [piAgentPath('models.json'), piProjectPath(cwd, 'models.json')]) {
    const parsed = readJsoncOrUndefined(path);
    if (!parsed || typeof parsed !== 'object') continue;
    const providers = (parsed as { providers?: unknown }).providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) continue;
    Object.assign(merged, providers as Record<string, unknown>);
  }
  return merged;
}

export interface LoadedVariants {
  /** All parsed variants (including any whose parent failed to resolve). */
  variants: ParsedVariant[];
  /** Provider specs to hand to `pi.registerProvider`. */
  registrations: ProviderRegistrationSpec[];
  /** Per-provider-name injection map for the request hook. */
  injections: Map<string, VariantInjection>;
  /** Human-readable config / resolution errors. */
  errors: string[];
}

/**
 * Full load: variants + resolved registrations + injection map + errors.
 */
export function loadVariantRegistrations(cwd: string): LoadedVariants {
  const { variants, errors: parseErrors } = loadVariants(cwd);
  const providers = loadProviders(cwd);
  const { registrations, injections, errors: buildErrors } = buildRegistrations(variants, providers);
  return { variants, registrations, injections, errors: [...parseErrors, ...buildErrors] };
}
