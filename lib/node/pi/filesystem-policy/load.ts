/**
 * Layered loader for the unified `<piAgentDir>/filesystem.json`
 * policy (default `~/.pi/agent/filesystem.json`, overridable via
 * `PI_CODING_AGENT_DIR`).
 *
 * Layer order (last wins per category, but additive within a category):
 *
 *   1. shipped defaults  ({@link DEFAULT_POLICY})
 *   2. user      `<piAgentDir>/filesystem.json`
 *   3. project   `<repo>/.pi/filesystem.json`
 *   4. persona   active persona's resolved `writeRoots` (merged into
 *                `write.allow.paths`; persona is a positive vouch)
 *
 * Pure module - no pi imports - so it's directly unit-testable. Callers
 * pass in raw file contents (already read via fs / pi) plus an optional
 * persona overlay; this module parses, validates, and merges.
 */

import { parseJsonc } from '../jsonc.ts';
import { isRecord } from '../shared.ts';

import {
  type FilesystemPolicy,
  type FilesystemPolicyWarning,
  type PartialFilesystemPolicy,
  type PartialRules,
  DEFAULT_POLICY,
  emptyPolicy,
  mergePolicies,
} from './schema.ts';

export interface FilesystemPolicyLayer {
  /** Source label (filename, env name, persona name) used in warnings. */
  source: string;
  /** Raw layer contents. Empty/blank string is skipped without warning. */
  raw: string;
}

export interface PersonaWriteRootsOverlay {
  source: string;
  /** Resolved-absolute paths from the active persona's `writeRoots`. */
  paths: readonly string[];
}

export interface LoadFilesystemPolicyOptions {
  /** Skip the shipped defaults - tests use this to start from empty. */
  includeDefaults?: boolean;
  /** Active persona's resolved writeRoots, merged into `write.allow.paths`. */
  personaOverlay?: PersonaWriteRootsOverlay;
  /** Session-only write-allow paths granted by the "Allow once"
   *  branch of the reactive filesystem-ask dialog. Merged into
   *  `write.allow.paths` after the persona overlay so the next
   *  `wrapWithSandbox` picks them up without touching any on-disk
   *  config file. Cleared at session end. */
  sessionWriteAllowPaths?: readonly string[];
}

export interface LoadFilesystemPolicyResult {
  policy: FilesystemPolicy;
  warnings: FilesystemPolicyWarning[];
}

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

function validateRules(
  source: string,
  scope: string,
  raw: unknown,
  warnings: FilesystemPolicyWarning[],
): PartialRules | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push({ source, reason: `\`${scope}\` must be an object (dropped)` });
    return undefined;
  }

  const out: PartialRules = {};
  for (const field of ['basenames', 'segments', 'paths'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      warnings.push({
        source,
        reason: `\`${scope}.${field}\` must be an array of strings (dropped)`,
      });
      continue;
    }
    const arr = value as unknown[];
    const filtered: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item !== 'string') {
        warnings.push({
          source,
          reason: `\`${scope}.${field}[${i}]\` is not a string (dropped)`,
        });
        continue;
      }
      filtered.push(item);
    }
    out[field] = filtered;
  }
  return out;
}

function validateLayer(layer: FilesystemPolicyLayer): {
  partial: PartialFilesystemPolicy;
  warnings: FilesystemPolicyWarning[];
} {
  const warnings: FilesystemPolicyWarning[] = [];
  const partial: PartialFilesystemPolicy = {};

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

  if (!isRecord(parsed)) {
    warnings.push({
      source: layer.source,
      reason: 'expected a JSON object at top level',
    });
    return { partial, warnings };
  }

  if (parsed.read !== undefined) {
    if (!isRecord(parsed.read)) {
      warnings.push({ source: layer.source, reason: '`read` must be an object' });
    } else {
      partial.read = {
        deny: validateRules(layer.source, 'read.deny', parsed.read.deny, warnings),
        allow: validateRules(layer.source, 'read.allow', parsed.read.allow, warnings),
      };
    }
  }

  if (parsed.write !== undefined) {
    if (!isRecord(parsed.write)) {
      warnings.push({ source: layer.source, reason: '`write` must be an object' });
    } else {
      partial.write = {
        allow: validateRules(layer.source, 'write.allow', parsed.write.allow, warnings),
        deny: validateRules(layer.source, 'write.deny', parsed.write.deny, warnings),
      };
    }
  }

  return { partial, warnings };
}

// ──────────────────────────────────────────────────────────────────────
// Public loader
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse, validate, and merge a stack of policy layers. Layers are
 * additive within a category - a project layer that adds
 * `read.deny.basenames: ['*.pem']` does NOT clobber the user layer's
 * `read.deny.basenames: ['secrets.yml']`. To remove a default, change
 * the default itself; v1 has no per-layer "minus" operator.
 */
export function loadFilesystemPolicy(
  layers: FilesystemPolicyLayer[],
  options: LoadFilesystemPolicyOptions = {},
): LoadFilesystemPolicyResult {
  const { includeDefaults = true, personaOverlay, sessionWriteAllowPaths } = options;
  const warnings: FilesystemPolicyWarning[] = [];

  const partials: PartialFilesystemPolicy[] = [];
  if (includeDefaults) partials.push(DEFAULT_POLICY);

  for (const layer of layers) {
    const v = validateLayer(layer);
    warnings.push(...v.warnings);
    partials.push(v.partial);
  }

  if (personaOverlay && personaOverlay.paths.length > 0) {
    partials.push({
      write: { allow: { paths: [...personaOverlay.paths] } },
    });
  }

  if (sessionWriteAllowPaths && sessionWriteAllowPaths.length > 0) {
    partials.push({
      write: { allow: { paths: [...sessionWriteAllowPaths] } },
    });
  }

  const policy = partials.length === 0 ? emptyPolicy() : mergePolicies(...partials);

  return { policy, warnings };
}
