/**
 * Pure helpers for the shipped built-in ComfyUI workflow manifest
 * (`config/pi/comfyui/builtin-workflows.json`).
 *
 * The manifest declares every shipped graph with the same `WorkflowConfig`
 * shape a user `comfyui.json` uses, plus a curated `defaultSet`. A selection
 * (from the `builtinWorkflows` config key or `PI_COMFYUI_WORKFLOWS`) picks
 * which entries are exposed: workflow names and the group aliases `default`,
 * `all`, and `none`.
 *
 * No I/O here: the config loader reads + coerces the manifest, then calls
 * these helpers.
 */

import { isAbsolute, join } from 'node:path';

import type { WorkflowConfig } from './types.ts';

/** The coerced built-in manifest. */
export interface BuiltinManifest {
  /** Preferred default workflow when the built-ins are the only workflows. */
  defaultWorkflow?: string;
  /** Names exposed by the `default` group. */
  defaultSet: string[];
  /** Every shipped workflow, keyed by name, with paths already resolved. */
  workflows: Record<string, WorkflowConfig>;
}

export interface BuiltinSelection {
  workflows: Record<string, WorkflowConfig>;
  /** Selection tokens that match neither a group nor a manifest workflow. */
  unknown: string[];
}

/**
 * Normalize a raw selection (a comma-separated string or a string array)
 * into trimmed, non-empty tokens. Returns `undefined` for anything else,
 * including a blank string, so an unset or empty env var means "not set".
 */
export function parseBuiltinSelection(raw: unknown): string[] | undefined {
  let parts: unknown[];
  if (typeof raw === 'string') parts = raw.split(',');
  else if (Array.isArray(raw)) parts = raw;
  else return undefined;
  const tokens = parts
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (tokens.length === 0) return typeof raw === 'string' ? undefined : [];
  return tokens;
}

/**
 * Resolve a manifest-relative path against the manifest directory. `~` and
 * absolute paths are kept as-is so they still resolve the usual way.
 */
export function resolveManifestPath(path: string, dir: string): string {
  if (path.startsWith('~') || isAbsolute(path)) return path;
  return join(dir, path);
}

/** Resolve every path-valued field of each workflow against `dir`. */
export function resolveManifestWorkflows(
  workflows: Record<string, WorkflowConfig>,
  dir: string,
): Record<string, WorkflowConfig> {
  const out: Record<string, WorkflowConfig> = {};
  for (const [name, wf] of Object.entries(workflows)) {
    const resolved: WorkflowConfig = { ...wf, file: resolveManifestPath(wf.file, dir) };
    if (wf.guidanceFile !== undefined) resolved.guidanceFile = resolveManifestPath(wf.guidanceFile, dir);
    if (wf.refineGuidanceFile !== undefined)
      resolved.refineGuidanceFile = resolveManifestPath(wf.refineGuidanceFile, dir);
    out[name] = resolved;
  }
  return out;
}

function pruneRefineWith(wf: WorkflowConfig, selected: ReadonlySet<string>): WorkflowConfig {
  if (wf.refineWith === undefined) return wf;
  const kept = Object.fromEntries(
    Object.entries(wf.refineWith).filter(([, target]) => typeof target === 'string' && selected.has(target)),
  );
  const rest: WorkflowConfig = { ...wf };
  delete rest.refineWith;
  return Object.keys(kept).length > 0 ? { ...rest, refineWith: kept } : rest;
}

/**
 * Expand selection tokens against the manifest. Order follows the manifest
 * so the tool description is stable regardless of token order. `none`
 * contributes nothing; it only matters as an explicit "no built-ins" value.
 *
 * A selected workflow's `refineWith` keeps only companions that are also
 * selected, so a partial selection never advertises unreachable channels.
 */
export function selectBuiltinWorkflows(manifest: BuiltinManifest, tokens: readonly string[]): BuiltinSelection {
  const wanted = new Set<string>();
  const unknown: string[] = [];
  for (const token of tokens) {
    if (token === 'none') continue;
    if (token === 'all') {
      for (const name of Object.keys(manifest.workflows)) wanted.add(name);
    } else if (token === 'default') {
      for (const name of manifest.defaultSet) if (name in manifest.workflows) wanted.add(name);
    } else if (token in manifest.workflows) {
      wanted.add(token);
    } else {
      unknown.push(token);
    }
  }

  const workflows: Record<string, WorkflowConfig> = {};
  for (const [name, wf] of Object.entries(manifest.workflows)) {
    if (!wanted.has(name)) continue;
    workflows[name] = pruneRefineWith(wf, wanted);
  }
  return { workflows, unknown };
}

/**
 * Pick the default workflow among the selected built-ins: the manifest's
 * preferred default when selected, else the first selected name.
 */
export function pickBuiltinDefault(
  manifest: BuiltinManifest,
  selected: Record<string, WorkflowConfig>,
): string | undefined {
  if (manifest.defaultWorkflow !== undefined && manifest.defaultWorkflow in selected) return manifest.defaultWorkflow;
  return Object.keys(selected)[0];
}
