/**
 * Disk-layering loaders for the `llama-thinking-budget` extension: read
 * pi's per-level `thinkingBudgets` from `settings.json` and each provider's
 * `thinkingBudgetInjection` from `models.json`, global first then project
 * (project wins). Malformed / missing files degrade to an empty layer.
 *
 * `cwd` is injected so resolution is deterministic and unit-testable; the
 * shell passes `process.cwd()`.
 *
 * No pi imports.
 */

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';

import { parseBudgets, parseInjection } from './config.ts';
import type { InjectionConfig, Level } from './types.ts';

/**
 * Merge pi's `thinkingBudgets` setting from the global agent `settings.json`
 * and the project `<cwd>/.pi/settings.json` (project overlaid last).
 */
export function loadSettingsBudgets(cwd: string): Partial<Record<Level, number>> {
  // Project-local overrides global; parse global first, then overlay project.
  const merged: Partial<Record<Level, number>> = {};
  for (const path of [piAgentPath('settings.json'), piProjectPath(cwd, 'settings.json')]) {
    const parsed = readJsoncOrUndefined(path);
    if (!parsed || typeof parsed !== 'object') continue;
    const tb = (parsed as { thinkingBudgets?: unknown }).thinkingBudgets;
    Object.assign(merged, parseBudgets(tb));
  }
  return merged;
}

/**
 * Collect the opted-in providers keyed by name from the global agent
 * `models.json` and the project `<cwd>/.pi/models.json` (project wins).
 */
export function loadProviderInjections(cwd: string): Map<string, InjectionConfig> {
  const out = new Map<string, InjectionConfig>();
  // Global first, then project - project wins by being applied last.
  for (const path of [piAgentPath('models.json'), piProjectPath(cwd, 'models.json')]) {
    const parsed = readJsoncOrUndefined(path);
    if (!parsed || typeof parsed !== 'object') continue;
    const providers = (parsed as { providers?: Record<string, unknown> }).providers;
    if (!providers || typeof providers !== 'object') continue;
    for (const [providerName, providerCfg] of Object.entries(providers)) {
      if (!providerCfg || typeof providerCfg !== 'object') continue;
      const injection = parseInjection((providerCfg as Record<string, unknown>).thinkingBudgetInjection);
      if (injection) out.set(providerName, injection);
    }
  }
  return out;
}
