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

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { expandTilde } from '../path-expand.ts';
import { isRecord } from '../shared.ts';

import type {
  AutogrowImageSlots,
  AutogrowMediaSlots,
  ComfyWorkflow,
  ImageSlots,
  InputMapping,
  RoleMapping,
  WorkflowConfig,
} from './types.ts';

/** A value injectable into a workflow node input. */
export type InjectValue = string | number | boolean;

export interface InjectResult {
  /** Deep clone of the input workflow with mapped params written in. */
  workflow: ComfyWorkflow;
  /** Human-readable problems; non-empty means do not submit the graph. */
  errors: string[];
}

/**
 * Narrow untrusted parsed JSON to a workflow graph: a non-empty object
 * whose every value is itself an object carrying an `inputs` object.
 */
export function isComfyWorkflow(value: unknown): value is ComfyWorkflow {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  if (entries.length === 0) return false;
  return entries.every((node) => isRecord(node) && isRecord((node as { inputs?: unknown }).inputs));
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
  const parsed = readJsoncOrUndefined(resolved);
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
    if (node === undefined || !isRecord(node.inputs)) {
      errors.push(`workflow has no node "${target.node}" with inputs (needed for "${name}")`);
      continue;
    }
    const transformed =
      target.transform === 'secondsToFrames24H3' && typeof value === 'number'
        ? (() => {
            const frames = Math.max(5, Math.round(value * 24));
            return frames + ((((5 - (frames % 17)) % 17) + 17) % 17);
          })()
        : value;
    node.inputs[target.key] = transformed;
    for (const sideEffect of target.alsoSet ?? []) {
      const sideNode = clone[sideEffect.node];
      if (sideNode === undefined || !isRecord(sideNode.inputs)) {
        errors.push(`workflow has no node "${sideEffect.node}" with inputs (needed for "${name}" alsoSet)`);
        continue;
      }
      sideNode.inputs[sideEffect.key] = sideEffect.value;
    }
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
    if (node === undefined || !isRecord(node.inputs)) {
      errors.push(`"${name}" -> node "${target.node}" not found in workflow`);
    }
    for (const sideEffect of target.alsoSet ?? []) {
      const sideNode = workflow[sideEffect.node];
      if (sideNode === undefined || !isRecord(sideNode.inputs)) {
        errors.push(`"${name}" alsoSet -> node "${sideEffect.node}" not found in workflow`);
      }
    }
  }
  return errors;
}

/**
 * Write each uploaded image name into its ordered slot: `names[i]` goes
 * into `targets[i].node`/`.key`. The caller guarantees `names.length <=
 * targets.length` (over-supply is rejected upstream); trailing slots with
 * no corresponding name keep their graph-baked default. Returns the same
 * `{ workflow, errors }` shape as {@link injectInputs} - one error per
 * missing / invalid target node.
 */
export function injectImageList(workflow: ComfyWorkflow, targets: InputMapping[], names: string[]): InjectResult {
  const clone = structuredClone(workflow);
  const errors: string[] = [];

  for (let i = 0; i < names.length; i++) {
    const target = targets[i];
    if (target === undefined) continue;
    const node = clone[target.node];
    if (node === undefined || !isRecord(node.inputs)) {
      errors.push(`workflow has no node "${target.node}" with inputs (needed for reference image ${i + 1})`);
      continue;
    }
    node.inputs[target.key] = names[i];
  }

  return { workflow: clone, errors };
}

/** Return a user-facing count error for an autogrow image list, if any. */
export function autogrowImageCountError(slots: AutogrowImageSlots, count: number): string | undefined {
  const min = slots.min ?? 0;
  if (count < min) return `requires at least ${min} reference image(s)`;
  if (count > slots.max) return `accepts at most ${slots.max} reference image(s)`;
  return undefined;
}

/** Return a user-facing count error for an autogrow media pipeline, if any. */
export function autogrowMediaCountError(
  slots: AutogrowMediaSlots,
  count: number,
  label: 'video' | 'audio',
): string | undefined {
  const min = slots.min ?? 0;
  if (count < min) return `requires at least ${min} reference ${label}(s)`;
  if (count > slots.max) return `accepts at most ${slots.max} reference ${label}(s)`;
  return undefined;
}

function nextNumericNodeId(workflow: ComfyWorkflow): number {
  let max = 0;
  for (const id of Object.keys(workflow)) {
    if (/^\d+$/.test(id)) max = Math.max(max, Number(id));
  }
  return max + 1;
}

/**
 * Expand a cloneable loader template into exactly one image-producing node
 * per uploaded name, then connect those nodes to a numbered dotted-input
 * family such as `images.image_1`, `images.image_2`, and so on.
 */
export function injectAutogrowImageList(
  workflow: ComfyWorkflow,
  slots: AutogrowImageSlots,
  names: string[],
): InjectResult {
  const clone = structuredClone(workflow);
  const errors: string[] = [];
  const countError = autogrowImageCountError(slots, names.length);
  if (countError !== undefined) return { workflow: clone, errors: [countError] };

  const template = clone[slots.loader.node];
  if (template === undefined || !isRecord(template.inputs)) {
    errors.push(`workflow has no loader node "${slots.loader.node}" with inputs`);
  }
  const target = clone[slots.target.node];
  if (target === undefined || !isRecord(target.inputs)) {
    errors.push(`workflow has no autogrow target node "${slots.target.node}" with inputs`);
  }
  if (errors.length > 0 || template === undefined || target === undefined) return { workflow: clone, errors };

  const indexBase = slots.target.indexBase ?? 1;
  for (const key of Object.keys(target.inputs ?? {})) {
    if (!key.startsWith(slots.target.keyPrefix)) continue;
    const suffix = key.slice(slots.target.keyPrefix.length);
    if (/^\d+$/.test(suffix)) delete target.inputs?.[key];
  }

  if (names.length === 0) {
    delete clone[slots.loader.node];
  } else {
    let nextId = nextNumericNodeId(clone);
    for (let i = 0; i < names.length; i++) {
      const nodeId = i === 0 ? slots.loader.node : String(nextId++);
      const loader = i === 0 ? template : structuredClone(template);
      if (!isRecord(loader.inputs)) {
        errors.push(`workflow loader node "${slots.loader.node}" has invalid inputs`);
        break;
      }
      loader.inputs[slots.loader.key] = names[i];
      clone[nodeId] = loader;
      target.inputs![`${slots.target.keyPrefix}${i + indexBase}`] = [nodeId, slots.loader.output ?? 0];
    }
  }

  return { workflow: clone, errors };
}

/** Validate every template/source/target node in an autogrow media pipeline. */
export function validateAutogrowMediaSlots(
  workflow: ComfyWorkflow,
  slots: AutogrowMediaSlots,
  label: 'video' | 'audio',
): string[] {
  const errors: string[] = [];
  for (const id of slots.templates) {
    const node = workflow[id];
    if (node === undefined || !isRecord(node.inputs)) {
      errors.push(`${label} template -> node "${id}" not found in workflow`);
    }
  }
  for (const output of slots.outputs) {
    const target = workflow[output.target.node];
    if (target === undefined || !isRecord(target.inputs)) {
      errors.push(`${label} target -> node "${output.target.node}" not found in workflow`);
    }
  }
  return errors;
}

function rewriteTemplateLinks(inputs: Record<string, unknown>, ids: Map<string, string>): void {
  for (const [key, value] of Object.entries(inputs)) {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') continue;
    const replacement = ids.get(value[0]);
    if (replacement !== undefined) inputs[key] = [replacement, value[1]];
  }
}

/**
 * Clone a loader/adapter template group once per uploaded media file and
 * connect each configured source output to its numbered target family.
 */
export function injectAutogrowMediaList(
  workflow: ComfyWorkflow,
  slots: AutogrowMediaSlots,
  names: string[],
  label: 'video' | 'audio',
): InjectResult {
  const clone = structuredClone(workflow);
  const countError = autogrowMediaCountError(slots, names.length, label);
  if (countError !== undefined) return { workflow: clone, errors: [countError] };
  const errors = validateAutogrowMediaSlots(clone, slots, label);
  if (errors.length > 0) return { workflow: clone, errors };

  for (const output of slots.outputs) {
    const target = clone[output.target.node];
    for (const key of Object.keys(target.inputs ?? {})) {
      if (!key.startsWith(output.target.keyPrefix)) continue;
      if (/^\d+$/.test(key.slice(output.target.keyPrefix.length))) delete target.inputs?.[key];
    }
  }

  const originals = new Map(slots.templates.map((id) => [id, clone[id]]));
  let nextId = nextNumericNodeId(clone);
  for (const id of slots.templates) delete clone[id];

  for (let i = 0; i < names.length; i++) {
    const ids = new Map<string, string>();
    for (const templateId of slots.templates) ids.set(templateId, i === 0 ? templateId : String(nextId++));
    for (const templateId of slots.templates) {
      const node = structuredClone(originals.get(templateId));
      if (node === undefined || !isRecord(node.inputs)) continue;
      rewriteTemplateLinks(node.inputs, ids);
      clone[ids.get(templateId)!] = node;
    }
    const loaderId = ids.get(slots.loader.node)!;
    clone[loaderId].inputs![slots.loader.key] = names[i];
    for (const output of slots.outputs) {
      const target = clone[output.target.node];
      const sourceId = ids.get(output.source.node)!;
      const index = i + (output.target.indexBase ?? 1);
      target.inputs![`${output.target.keyPrefix}${index}`] = [sourceId, output.source.output ?? 0];
    }
  }

  return { workflow: clone, errors: [] };
}

/**
 * Check that every image slot referenced by `images` exists in
 * `workflow`. Sibling of {@link validateMapping} for the ordered
 * `WorkflowConfig.images` list; one error per dangling target.
 */
export function validateImageMappings(workflow: ComfyWorkflow, images: InputMapping[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const target = images[i];
    const node = workflow[target.node];
    if (node === undefined || !isRecord(node.inputs)) {
      errors.push(`image ${i + 1} -> node "${target.node}" not found in workflow`);
    }
  }
  return errors;
}

/**
 * Whether a workflow's `images` declaration is the role-keyed form (vs the
 * positional `InputMapping[]`). `undefined` (no image slots) is not a role
 * map. Used to branch the upload + inject paths.
 */
/** Whether a workflow declares a runtime-sized positional image list. */
export function isAutogrowImageSlots(images: ImageSlots | undefined): images is AutogrowImageSlots {
  return images !== undefined && !Array.isArray(images) && images.mode === 'autogrow';
}

export function isRoleMap(images: ImageSlots | undefined): images is Record<string, RoleMapping> {
  return images !== undefined && !Array.isArray(images) && !isAutogrowImageSlots(images);
}

/**
 * Write each pre-uploaded image name into its named role's node/key.
 * `uploadedByRole` is keyed by the same role names as `roleMap` (the
 * shell resolves paths / synthesizes masks and uploads them first). A role
 * present in `uploadedByRole` but absent from `roleMap`, or a mapped node
 * missing from the graph, is recorded in `errors` and skipped. Sibling of
 * {@link injectImageList} for the role-keyed form.
 */
export function injectImageRoles(
  workflow: ComfyWorkflow,
  roleMap: Record<string, RoleMapping>,
  uploadedByRole: Record<string, string>,
): InjectResult {
  const clone = structuredClone(workflow);
  const errors: string[] = [];

  for (const [role, name] of Object.entries(uploadedByRole)) {
    const target = roleMap[role];
    if (target === undefined) {
      errors.push(`no image role "${role}" in this workflow`);
      continue;
    }
    const node = clone[target.node];
    if (node === undefined || !isRecord(node.inputs)) {
      errors.push(`workflow has no node "${target.node}" with inputs (needed for image role "${role}")`);
      continue;
    }
    node.inputs[target.key] = name;
  }

  return { workflow: clone, errors };
}

/**
 * Check that every node referenced by a role map exists in `workflow`.
 * Sibling of {@link validateImageMappings} for the role-keyed form; one
 * error per dangling role target.
 */
export function validateImageRoleMap(workflow: ComfyWorkflow, roleMap: Record<string, RoleMapping>): string[] {
  const errors: string[] = [];
  for (const [role, target] of Object.entries(roleMap)) {
    const node = workflow[target.node];
    if (node === undefined || !isRecord(node.inputs)) {
      errors.push(`role "${role}" -> node "${target.node}" not found in workflow`);
    }
  }
  return errors;
}

/** Validate the loader and target nodes for an autogrow declaration. */
export function validateAutogrowImageSlots(workflow: ComfyWorkflow, slots: AutogrowImageSlots): string[] {
  const errors: string[] = [];
  const loader = workflow[slots.loader.node];
  if (loader === undefined || !isRecord(loader.inputs)) {
    errors.push(`autogrow loader -> node "${slots.loader.node}" not found in workflow`);
  }
  const target = workflow[slots.target.node];
  if (target === undefined || !isRecord(target.inputs)) {
    errors.push(`autogrow target -> node "${slots.target.node}" not found in workflow`);
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

/**
 * Validate every configured workflow for the `/comfyui workflows`
 * operator command: load each graph from disk and check its input mapping
 * against the actual nodes, returning one `✓`/`✗` line per workflow.
 * Pure of the pi runtime (fs reads only) so it is unit-testable; the shell
 * just hands the result to `ctx.ui.notify`.
 *
 * A failed load reports the loader error; a mapping that references a
 * missing node reports the validation errors; otherwise the line lists the
 * mapped input names. Returns a placeholder when no workflows exist.
 */
/**
 * One `⚠` line per {@link WorkflowConfig.refineWith} entry whose companion is
 * not a configured workflow. Pure string assembly used by
 * {@link formatWorkflowValidation}; returns an empty array when the map is
 * absent or every companion resolves.
 */
export function refineWithWarnings(
  name: string,
  refineWith: WorkflowConfig['refineWith'],
  workflows: Record<string, WorkflowConfig>,
): string[] {
  if (refineWith === undefined) return [];
  const warnings: string[] = [];
  for (const [channel, target] of Object.entries(refineWith)) {
    if (typeof target !== 'string' || target.length === 0) continue;
    if (!(target in workflows)) {
      warnings.push(`⚠ ${name}: refineWith.${channel} -> "${target}" is not a configured workflow`);
    }
  }
  return warnings;
}

export function formatWorkflowValidation(workflows: Record<string, WorkflowConfig>, cwd: string, home: string): string {
  const lines: string[] = [];
  for (const [name, wf] of Object.entries(workflows)) {
    const loaded = loadWorkflowGraph(wf.file, cwd, home);
    if (loaded.error || !loaded.graph) {
      lines.push(`✗ ${name}: ${loaded.error ?? 'load failed'}`);
      continue;
    }
    const imageErrors = isAutogrowImageSlots(wf.images)
      ? validateAutogrowImageSlots(loaded.graph, wf.images)
      : isRoleMap(wf.images)
        ? validateImageRoleMap(loaded.graph, wf.images)
        : validateImageMappings(loaded.graph, wf.images ?? []);
    const videoErrors = wf.videos ? validateAutogrowMediaSlots(loaded.graph, wf.videos, 'video') : [];
    const audioErrors = wf.audios ? validateAutogrowMediaSlots(loaded.graph, wf.audios, 'audio') : [];
    const errors = [...validateMapping(loaded.graph, wf.inputs), ...imageErrors, ...videoErrors, ...audioErrors];
    const inputs = Object.keys(wf.inputs).join(', ') || '(none)';
    lines.push(errors.length > 0 ? `✗ ${name}: ${errors.join('; ')}` : `✓ ${name}: ${inputs}`);
    // Warn (don't fail) when an auto-refine companion names a workflow that is
    // not configured: the channel is silently off the table at runtime, so a
    // typo'd `refineWith` target would otherwise be invisible.
    for (const warning of refineWithWarnings(name, wf.refineWith, workflows)) lines.push(warning);
  }
  return lines.join('\n') || 'no workflows configured';
}
