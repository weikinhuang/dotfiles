/**
 * Config defaults + coercion + layering for the context-edit extensions.
 *
 * Only the size thresholds and the auto-collapse tunables are genuine
 * user *preferences* (not per-call data), so per AGENTS.md they get a
 * `<ext>.json` config layer in addition to env knobs. Resolution order
 * (highest first): project `.pi/<ext>.json` > user `<agentDir>/<ext>.json`
 * > env knob > built-in default.
 *
 * No pi imports - testable under `vitest` without the runtime.
 */

import { readJsonOrUndefined } from '../fs-safe.ts';
import { parseClampedPositiveInt, parseNonNegativeInt } from '../parse-env.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';

export interface TrimConfig {
  /** Minimum byte size for a text part / tool result to be offered for trimming. */
  minTextBytes: number;
  /** Snippet character cap in listings + completions. */
  snippetChars: number;
}

export interface ToolCollapseConfig {
  /** Minimum byte size for a tool result to be offered for collapsing. */
  minTextBytes: number;
  snippetChars: number;
  /** Auto-collapse tool results older than this many turns (0 = off). */
  autoAfterTurns: number;
  /** Auto-collapse only results at or above this byte size (applies when autoAfterTurns > 0). */
  autoMinBytes: number;
}

export const DEFAULT_TRIM_CONFIG: TrimConfig = {
  minTextBytes: 2048,
  snippetChars: 80,
};

export const DEFAULT_TOOL_COLLAPSE_CONFIG: ToolCollapseConfig = {
  minTextBytes: 2048,
  snippetChars: 80,
  autoAfterTurns: 0,
  autoMinBytes: 4096,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** Validate an untrusted JSON layer into a `Partial<TrimConfig>`. */
export function coerceTrimLayer(raw: unknown): Partial<TrimConfig> {
  if (!isObject(raw)) return {};
  const out: Partial<TrimConfig> = {};
  const minTextBytes = asPositiveInt(raw.minTextBytes);
  if (minTextBytes !== undefined) out.minTextBytes = minTextBytes;
  const snippetChars = asPositiveInt(raw.snippetChars);
  if (snippetChars !== undefined) out.snippetChars = snippetChars;
  return out;
}

/** Validate an untrusted JSON layer into a `Partial<ToolCollapseConfig>`. */
export function coerceToolCollapseLayer(raw: unknown): Partial<ToolCollapseConfig> {
  if (!isObject(raw)) return {};
  const out: Partial<ToolCollapseConfig> = {};
  const minTextBytes = asPositiveInt(raw.minTextBytes);
  if (minTextBytes !== undefined) out.minTextBytes = minTextBytes;
  const snippetChars = asPositiveInt(raw.snippetChars);
  if (snippetChars !== undefined) out.snippetChars = snippetChars;
  const autoAfterTurns = asNonNegativeInt(raw.autoAfterTurns);
  if (autoAfterTurns !== undefined) out.autoAfterTurns = autoAfterTurns;
  const autoMinBytes = asPositiveInt(raw.autoMinBytes);
  if (autoMinBytes !== undefined) out.autoMinBytes = autoMinBytes;
  return out;
}

/**
 * Resolve the trim config for `cwd`: env defaults (lowest), then user
 * `<agentDir>/context-trim.json`, then project `<cwd>/.pi/context-trim.json`.
 */
export function loadTrimConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): TrimConfig {
  const base: TrimConfig = {
    minTextBytes: parseClampedPositiveInt(env.PI_CONTEXT_TRIM_MIN_BYTES, DEFAULT_TRIM_CONFIG.minTextBytes, 256),
    snippetChars: parseClampedPositiveInt(env.PI_CONTEXT_TRIM_SNIPPET_CHARS, DEFAULT_TRIM_CONFIG.snippetChars, 20),
  };
  const userLayer = coerceTrimLayer(readJsonOrUndefined(piAgentPath('context-trim.json')));
  const projectLayer = coerceTrimLayer(readJsonOrUndefined(piProjectPath(cwd, 'context-trim.json')));
  return { ...base, ...userLayer, ...projectLayer };
}

/** Resolve the tool-collapse config for `cwd` with the same layering. */
export function loadToolCollapseConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ToolCollapseConfig {
  const base: ToolCollapseConfig = {
    minTextBytes: parseClampedPositiveInt(
      env.PI_TOOL_COLLAPSE_MIN_BYTES,
      DEFAULT_TOOL_COLLAPSE_CONFIG.minTextBytes,
      256,
    ),
    snippetChars: parseClampedPositiveInt(
      env.PI_TOOL_COLLAPSE_SNIPPET_CHARS,
      DEFAULT_TOOL_COLLAPSE_CONFIG.snippetChars,
      20,
    ),
    autoAfterTurns: parseNonNegativeInt(
      env.PI_TOOL_COLLAPSE_AUTO_AFTER_TURNS,
      DEFAULT_TOOL_COLLAPSE_CONFIG.autoAfterTurns,
    ),
    autoMinBytes: parseClampedPositiveInt(
      env.PI_TOOL_COLLAPSE_AUTO_MIN_BYTES,
      DEFAULT_TOOL_COLLAPSE_CONFIG.autoMinBytes,
      256,
    ),
  };
  const userLayer = coerceToolCollapseLayer(readJsonOrUndefined(piAgentPath('tool-collapse.json')));
  const projectLayer = coerceToolCollapseLayer(readJsonOrUndefined(piProjectPath(cwd, 'tool-collapse.json')));
  return { ...base, ...userLayer, ...projectLayer };
}
