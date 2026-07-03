/**
 * Device-local ComfyUI workflow registry for avatar sprite generation.
 *
 * `avatar-ref/workflows.json` maps model names to API-format workflow files
 * plus input-node bindings. Pure helpers - no pi imports or network I/O
 * beyond reading JSON from disk.
 *
 * Each entry's `file` is resolved against `cwd` (the repo root when tools run
 * from there), NOT against the registry file's own directory - matching
 * `DEFAULT_REGISTRY_PATH`. Author `file` paths repo-root-relative (e.g.
 * `avatar-ref/anima.api.json`), or absolute / `~`-prefixed.
 */

import { resolve } from 'node:path';

import { readJsoncOrUndefined } from '../../../../lib/node/pi/fs-safe.ts';
import { expandTilde } from '../../../../lib/node/pi/path-expand.ts';
import { loadWorkflowGraph, validateMapping } from '../../../../lib/node/pi/comfyui/workflow.ts';

import type { ComfyWorkflow, InputMapping } from '../../../../lib/node/pi/comfyui/types.ts';

/** Tunable parameter names injectable into avatar ComfyUI workflows. */
export const WORKFLOW_PARAMS = [
  'prompt',
  'negative',
  'seed',
  'steps',
  'cfg',
  'denoise',
  'width',
  'height',
  'image',
  'batch',
] as const;

export type WorkflowParam = (typeof WORKFLOW_PARAMS)[number];

/**
 * How a workflow consumes the canonical hero image:
 * - `generate`: pure txt2img, no image input.
 * - `edit`: img2img that edits the source - frame 0 edits the hero, later frames
 *   edit that state's frame 0 (chained).
 * - `reference`: fresh generation conditioned on the hero as a style/identity
 *   reference (e.g. IPAdapter) - the same hero is fed into every cell, no chaining.
 */
export type WorkflowRole = 'generate' | 'edit' | 'reference';

export interface AvatarWorkflowEntry {
  /** Path to the API-format workflow JSON (`~` expands against homedir). */
  file: string;
  role: WorkflowRole;
  inputs: Partial<Record<WorkflowParam, InputMapping>>;
}

export type AvatarWorkflowRegistry = Record<string, AvatarWorkflowEntry>;

/** Default registry path when running tools from the repo root. */
export const DEFAULT_REGISTRY_PATH = 'avatar-ref/workflows.json';

const KNOWN_PARAMS = new Set<string>(WORKFLOW_PARAMS);

export interface ValidatedWorkflow {
  name: string;
  entry: AvatarWorkflowEntry;
  graph: ComfyWorkflow;
}

export interface RegistryValidationResult {
  workflows: ValidatedWorkflow[];
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRole(value: unknown): WorkflowRole | undefined {
  return value === 'generate' || value === 'edit' || value === 'reference' ? value : undefined;
}

function asInputMapping(value: unknown): InputMapping | undefined {
  if (!isObject(value)) return undefined;
  const node = asString(value.node);
  const key = asString(value.key);
  if (node === undefined || key === undefined || node.length === 0 || key.length === 0) return undefined;
  return { node, key };
}

function asInputs(value: unknown): Partial<Record<WorkflowParam, InputMapping>> | undefined {
  if (!isObject(value)) return undefined;
  const out: Partial<Record<WorkflowParam, InputMapping>> = {};
  for (const [name, raw] of Object.entries(value)) {
    const mapping = asInputMapping(raw);
    if (mapping === undefined) continue;
    if (!KNOWN_PARAMS.has(name)) continue;
    out[name as WorkflowParam] = mapping;
  }
  return out;
}

function asWorkflowEntry(value: unknown): AvatarWorkflowEntry | undefined {
  if (!isObject(value)) return undefined;
  const file = asString(value.file);
  const role = asRole(value.role);
  const inputs = asInputs(value.inputs);
  if (file === undefined || file.length === 0 || role === undefined || inputs === undefined) return undefined;
  return { file, role, inputs };
}

/**
 * Coerce untrusted parsed JSON into a registry, dropping malformed entries.
 */
export function parseRegistry(raw: unknown): AvatarWorkflowRegistry {
  if (!isObject(raw)) return {};
  const out: AvatarWorkflowRegistry = {};
  for (const [name, entryRaw] of Object.entries(raw)) {
    const entry = asWorkflowEntry(entryRaw);
    if (entry !== undefined) out[name] = entry;
  }
  return out;
}

function validateRoleInputs(name: string, entry: AvatarWorkflowEntry): string[] {
  const hasImage = entry.inputs.image !== undefined;
  if ((entry.role === 'edit' || entry.role === 'reference') && !hasImage) {
    return [`"${name}": ${entry.role} role requires an "image" input mapping`];
  }
  if (entry.role === 'generate' && hasImage) {
    return [`"${name}": generate role must not declare an "image" input mapping`];
  }
  return [];
}

function validateInputKeys(name: string, entry: AvatarWorkflowEntry): string[] {
  const errors: string[] = [];
  if (!isObject(entry.inputs)) return errors;
  for (const key of Object.keys(entry.inputs)) {
    if (!KNOWN_PARAMS.has(key)) {
      errors.push(`"${name}": unknown input param "${key}"`);
    }
  }
  return errors;
}

/**
 * Validate one registry entry: role/image contract, load its workflow graph,
 * and check that every mapped node exists in that graph.
 */
export function validateRegistryEntry(
  name: string,
  entry: AvatarWorkflowEntry,
  cwd: string,
  homedir: string,
): { workflow?: ValidatedWorkflow; errors: string[] } {
  const errors = [...validateRoleInputs(name, entry), ...validateInputKeys(name, entry)];
  if (errors.length > 0) return { errors };

  const loaded = loadWorkflowGraph(entry.file, cwd, homedir);
  if (loaded.error !== undefined) {
    return { errors: [`"${name}": ${loaded.error}`] };
  }
  const graph = loaded.graph;
  if (graph === undefined) {
    return { errors: [`"${name}": workflow graph missing after load`] };
  }

  const mapping = entry.inputs as Record<string, InputMapping>;
  const mappingErrors = validateMapping(graph, mapping).map((msg) => `"${name}": ${msg}`);
  if (mappingErrors.length > 0) return { errors: mappingErrors };

  return { workflow: { name, entry, graph }, errors: [] };
}

/**
 * Read and validate every entry in a registry file. Returns successfully
 * validated workflows plus human-readable errors for anything that fails.
 */
export function loadAndValidateRegistry(file: string, cwd: string, homedir: string): RegistryValidationResult {
  const resolved = resolve(cwd, expandTilde(file, homedir));
  const parsed = readJsoncOrUndefined(resolved);
  const registry = parseRegistry(parsed);
  const workflows: ValidatedWorkflow[] = [];
  const errors: string[] = [];

  if (parsed === undefined) {
    return { workflows, errors: [`workflow registry not found or invalid JSON: ${resolved}`] };
  }

  for (const [name, entry] of Object.entries(registry)) {
    const result = validateRegistryEntry(name, entry, cwd, homedir);
    if (result.workflow !== undefined) workflows.push(result.workflow);
    errors.push(...result.errors);
  }

  return { workflows, errors };
}
