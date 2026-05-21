/**
 * Layered loader for `~/.pi/sandbox.json` /
 * `<repo>/.pi/sandbox.json`. Layer order:
 *
 *   1. shipped defaults  ({@link DEFAULT_SANDBOX_CONFIG})
 *   2. user      `~/.pi/sandbox.json`
 *   3. project   `<repo>/.pi/sandbox.json`
 *   4. env-var overlay (`PI_SANDBOX_NESTED`, `PI_SANDBOX_WEAKER_NET`,
 *      `PI_SANDBOX_EXTRA_ALLOW_DOMAIN`)
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 * Callers read files through fs/pi and pass raw strings in.
 */

import { parseJsonc } from '../jsonc.ts';
import { isPlainObject } from '../util.ts';

import {
  type PartialSandboxConfig,
  type SandboxConfig,
  type SandboxConfigWarning,
  mergeSandboxConfigs,
} from './config-schema.ts';

export interface SandboxConfigLayer {
  /** Source label used in warnings. */
  source: string;
  /** Raw layer contents. Empty/blank string is skipped without warning. */
  raw: string;
}

/** Subset of `process.env` consulted for env-var overrides. Tests pass
 *  a stub here so they don't have to mutate the real `process.env`. */
export interface SandboxConfigEnv {
  PI_SANDBOX_NESTED?: string;
  PI_SANDBOX_WEAKER_NET?: string;
  PI_SANDBOX_EXTRA_ALLOW_DOMAIN?: string;
}

export interface LoadSandboxConfigResult {
  config: SandboxConfig;
  warnings: SandboxConfigWarning[];
}

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

function validateLayer(layer: SandboxConfigLayer): {
  partial: PartialSandboxConfig;
  warnings: SandboxConfigWarning[];
} {
  const warnings: SandboxConfigWarning[] = [];
  const partial: PartialSandboxConfig = {};

  if (layer.raw.trim().length === 0) return { partial, warnings };

  let parsed: unknown;
  try {
    parsed = parseJsonc(layer.raw);
  } catch (e) {
    warnings.push({
      source: layer.source,
      reason: e instanceof Error ? e.message : String(e),
    });
    return { partial, warnings };
  }

  if (!isPlainObject(parsed)) {
    warnings.push({
      source: layer.source,
      reason: 'expected a JSON object at top level',
    });
    return { partial, warnings };
  }

  for (const top of ['network', 'unixSockets', 'flags'] as const) {
    const v = parsed[top];
    if (v === undefined) continue;
    if (!isPlainObject(v)) {
      warnings.push({
        source: layer.source,
        reason: `\`${top}\` must be an object (dropped)`,
      });
      continue;
    }
    // Pass through verbatim - the merge step does the per-field type
    // checks and emits warnings for mis-shaped scalars / arrays.
    (partial as Record<string, unknown>)[top] = v;
  }

  return { partial, warnings };
}

// ──────────────────────────────────────────────────────────────────────
// Env-var overlay
// ──────────────────────────────────────────────────────────────────────

/**
 * Tiny dotenv-style truthy check: `1`, `true`, `yes`, `on`
 * (case-insensitive). Empty / unset values are NOT truthy. Anything
 * else returns false (matching plan section 6's env-var convention).
 */
function envTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envOverlay(env: SandboxConfigEnv): PartialSandboxConfig {
  const partial: PartialSandboxConfig = {};

  if (env.PI_SANDBOX_NESTED !== undefined || env.PI_SANDBOX_WEAKER_NET !== undefined) {
    partial.flags = {
      weakerNestedSandbox: envTruthy(env.PI_SANDBOX_NESTED),
      weakerNetworkIsolation: envTruthy(env.PI_SANDBOX_WEAKER_NET),
    };
  }

  if (env.PI_SANDBOX_EXTRA_ALLOW_DOMAIN) {
    const domains = env.PI_SANDBOX_EXTRA_ALLOW_DOMAIN.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (domains.length > 0) {
      partial.network = { allow: domains };
    }
  }

  return partial;
}

// ──────────────────────────────────────────────────────────────────────
// Public loader
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse, validate, and merge a stack of sandbox-config layers. Returns
 * a fully-resolved {@link SandboxConfig} plus per-layer warnings.
 *
 * Layers are processed in order; arrays accumulate, booleans use
 * last-wins. The shipped defaults are always the lowest layer (set
 * `mergeSandboxConfigs` directly if you need to start from empty).
 */
export function loadSandboxConfig(layers: SandboxConfigLayer[], env: SandboxConfigEnv = {}): LoadSandboxConfigResult {
  const validated = layers.map(validateLayer);
  const layerWarnings = validated.flatMap((v) => v.warnings);

  const stack: { source: string; partial: PartialSandboxConfig }[] = layers.map((l, i) => ({
    source: l.source,
    partial: validated[i].partial,
  }));

  const overlay = envOverlay(env);
  const overlayHasAnything =
    overlay.flags !== undefined || overlay.network !== undefined || overlay.unixSockets !== undefined;
  if (overlayHasAnything) {
    stack.push({ source: '<env>', partial: overlay });
  }

  const merged = mergeSandboxConfigs(stack);
  return {
    config: merged.config,
    warnings: [...layerWarnings, ...merged.warnings],
  };
}
