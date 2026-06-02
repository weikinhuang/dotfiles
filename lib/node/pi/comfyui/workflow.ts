/**
 * Pure parameter injection into an API-format ComfyUI workflow graph.
 *
 * API-format workflows are keyed by opaque node ids, and the tunable
 * values (prompt, seed, dimensions, …) live inside specific nodes'
 * `inputs` objects. {@link injectInputs} writes the caller-supplied
 * params into the nodes named by the workflow's input map, returning a
 * deep clone plus any errors (unmapped param, or a mapped node missing
 * from the graph) so the extension can surface a clear failure instead
 * of POSTing a malformed graph.
 *
 * No pi imports - testable under vitest.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { readJsonOrUndefined } from '../fs-safe.ts';
import { expandTilde } from '../path-expand.ts';

import type { ComfyWorkflow, InputMapping } from './types.ts';

/** A value injectable into a workflow node input. */
export type InjectValue = string | number;

export interface InjectResult {
  /** Deep clone of the input workflow with mapped params written in. */
  workflow: ComfyWorkflow;
  /** Human-readable problems; non-empty means do not submit the graph. */
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow untrusted parsed JSON to a workflow graph: a non-empty object
 * whose every value is itself an object carrying an `inputs` object.
 */
export function isComfyWorkflow(value: unknown): value is ComfyWorkflow {
  if (!isObject(value)) return false;
  const entries = Object.values(value);
  if (entries.length === 0) return false;
  return entries.every((node) => isObject(node) && isObject((node as { inputs?: unknown }).inputs));
}

/**
 * Read and validate a workflow file named in config. `file` is resolved
 * like every other config path: a leading `~` expands against `homedir`,
 * an absolute path is used as-is, and a relative path (`./local/wf.json`,
 * `wf/foo.json`) resolves against `cwd` (the session cwd). The file is
 * then read and narrowed with {@link isComfyWorkflow}. Returns `{ graph }`
 * on success or a human-readable `{ error }` (file missing / not a valid
 * API-format graph) so the extension can surface a clear failure instead
 * of POSTing garbage. `cwd` / `homedir` are passed in to keep the helper
 * pure.
 */
export function loadWorkflowGraph(
  file: string,
  cwd: string,
  homedir: string,
): { graph?: ComfyWorkflow; error?: string } {
  const resolved = resolve(cwd, expandTilde(file, homedir));
  if (!existsSync(resolved)) return { error: `workflow file not found: ${resolved}` };
  const parsed = readJsonOrUndefined(resolved);
  if (!isComfyWorkflow(parsed)) return { error: `workflow file is not a valid API-format graph: ${resolved}` };
  return { graph: parsed };
}

/**
 * Deep-clone `workflow` and write each defined value in `params` into
 * the node + key named by `mapping`. A param with no mapping entry, or a
 * mapping that points at a node absent from the graph, is recorded in
 * `errors` and skipped (the clone is left untouched at that slot).
 *
 * `params` values that are `undefined` are ignored, so callers can pass
 * the full param object and let omitted tool args keep the workflow
 * file's baked-in defaults.
 */
export function injectInputs(
  workflow: ComfyWorkflow,
  mapping: Record<string, InputMapping>,
  params: Record<string, InjectValue | undefined>,
): InjectResult {
  const clone = structuredClone(workflow);
  const errors: string[] = [];

  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const target = mapping[name];
    if (target === undefined) {
      errors.push(`no input mapping for "${name}" in this workflow`);
      continue;
    }
    const node = clone[target.node];
    if (node === undefined || !isObject(node.inputs)) {
      errors.push(`workflow has no node "${target.node}" with inputs (needed for "${name}")`);
      continue;
    }
    node.inputs[target.key] = value;
  }

  return { workflow: clone, errors };
}

/**
 * Check that every node referenced by `mapping` exists in `workflow`.
 * Returns one error string per dangling mapping entry; an empty array
 * means the map is consistent with the graph. Used by `/comfyui
 * workflows` to validate config without a generation round-trip.
 */
export function validateMapping(workflow: ComfyWorkflow, mapping: Record<string, InputMapping>): string[] {
  const errors: string[] = [];
  for (const [name, target] of Object.entries(mapping)) {
    const node = workflow[target.node];
    if (node === undefined || !isObject(node.inputs)) {
      errors.push(`"${name}" -> node "${target.node}" not found in workflow`);
    }
  }
  return errors;
}

/**
 * A fresh pseudo-random seed in `[0, 1e15)`. ComfyUI accepts 64-bit
 * seeds, but staying inside JS's safe-integer range keeps the value
 * round-trippable through JSON. `rand` is injectable for deterministic
 * tests.
 */
export function randomSeed(rand: () => number = Math.random): number {
  return Math.floor(rand() * 1e15);
}
