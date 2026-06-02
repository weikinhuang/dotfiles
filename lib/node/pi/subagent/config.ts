/**
 * Pure config defaults + coercion + layering for the `subagent`
 * extension.
 *
 * Three knobs, all previously env-only, are now also settable per-project
 * (`<cwd>/.pi/subagent.json`) and per-user (`<piAgentDir>/subagent.json`):
 *
 *   - `model`       global model override (`provider/id`) applied to every
 *                   child when the per-call `modelOverride` is omitted.
 *                   Env: `PI_SUBAGENT_MODEL`. Undefined = inherit from the
 *                   agent definition / parent.
 *   - `maxTurns`    global ceiling on a dispatch's turn count. Acts as the
 *                   `envCap` fed to `resolveMaxTurns`, so it caps both the
 *                   agent default and a per-call `maxTurns`. Env:
 *                   `PI_SUBAGENT_MAX_TURNS`. Undefined = no global cap.
 *   - `concurrency` max concurrent children. Env: `PI_SUBAGENT_CONCURRENCY`.
 *                   Built-in 4, clamped to [1, 8].
 *
 * Resolution order (lowest -> highest): built-in default -> env knob ->
 * user global -> project local. The per-call param (`modelOverride`,
 * `maxTurns`) still wins over all of these in the extension handler.
 *
 * {@link loadSubagentConfig} does the disk wiring; reads go through
 * {@link readJsonOrUndefined} so a missing / malformed file degrades to
 * an empty layer. No pi imports - unit-tested under vitest.
 */

import { readJsonOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';

/** Concurrency clamp, matching the prior `envConcurrency()` bounds. */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;

/** Fully-resolved `subagent` config (built-in + env + user + project). */
export interface SubagentConfig {
  /** Global model override (`provider/id`); undefined = inherit. */
  model?: string;
  /** Global max-turns ceiling; undefined = no cap. */
  maxTurns?: number;
  /** Max concurrent children, clamped to [1, 8]. */
  concurrency: number;
}

/** Built-in defaults, used as the lowest config layer. */
export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  concurrency: 4,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Validate an untrusted parsed JSON layer into a `Partial<SubagentConfig>`,
 * dropping any field with the wrong type. `concurrency` is NOT clamped
 * here (so a layer's intent survives merge); the clamp is applied once on
 * the final resolved value in {@link mergeSubagentConfigLayers}.
 */
export function coerceSubagentConfigLayer(raw: unknown): Partial<SubagentConfig> {
  if (!isObject(raw)) return {};
  const out: Partial<SubagentConfig> = {};

  const model = asNonEmptyString(raw.model);
  if (model !== undefined) out.model = model;

  const maxTurns = asPositiveInt(raw.maxTurns);
  if (maxTurns !== undefined) out.maxTurns = maxTurns;

  const concurrency = asPositiveInt(raw.concurrency);
  if (concurrency !== undefined) out.concurrency = concurrency;

  return out;
}

/** Parse an env string to a positive integer, or undefined when missing / invalid. */
function envPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Build the env layer from the existing `PI_SUBAGENT_*` knobs. A
 * set-but-invalid value is dropped (falls through to the built-in).
 */
export function subagentEnvLayer(env: NodeJS.ProcessEnv = process.env): Partial<SubagentConfig> {
  const out: Partial<SubagentConfig> = {};

  const model = asNonEmptyString(env.PI_SUBAGENT_MODEL);
  if (model !== undefined) out.model = model;

  const maxTurns = envPositiveInt(env.PI_SUBAGENT_MAX_TURNS);
  if (maxTurns !== undefined) out.maxTurns = maxTurns;

  const concurrency = envPositiveInt(env.PI_SUBAGENT_CONCURRENCY);
  if (concurrency !== undefined) out.concurrency = concurrency;

  return out;
}

/**
 * Layer `overrides` over {@link DEFAULT_SUBAGENT_CONFIG} in priority order
 * (lowest first). Every field is replaced wholesale by a layer that sets
 * it; the final `concurrency` is clamped to [{@link MIN_CONCURRENCY},
 * {@link MAX_CONCURRENCY}].
 */
export function mergeSubagentConfigLayers(...overrides: Partial<SubagentConfig>[]): SubagentConfig {
  const result: SubagentConfig = { ...DEFAULT_SUBAGENT_CONFIG };
  for (const layer of overrides) {
    if (layer.model !== undefined) result.model = layer.model;
    if (layer.maxTurns !== undefined) result.maxTurns = layer.maxTurns;
    if (layer.concurrency !== undefined) result.concurrency = layer.concurrency;
  }
  result.concurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, result.concurrency));
  return result;
}

/**
 * Load the fully-resolved config for `cwd`, layering built-in defaults
 * (lowest) under the `PI_SUBAGENT_*` env knobs, then the user-global
 * `<piAgentDir>/subagent.json`, then the project-local
 * `<cwd>/.pi/subagent.json` (highest). `env` is injectable for tests.
 */
export function loadSubagentConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): SubagentConfig {
  const envLayer = subagentEnvLayer(env);
  const userLayer = coerceSubagentConfigLayer(readJsonOrUndefined(piAgentPath('subagent.json')));
  const projectLayer = coerceSubagentConfigLayer(readJsonOrUndefined(piProjectPath(cwd, 'subagent.json')));
  return mergeSubagentConfigLayers(envLayer, userLayer, projectLayer);
}
