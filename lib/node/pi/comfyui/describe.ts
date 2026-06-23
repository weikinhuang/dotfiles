/**
 * Pure discoverability rendering for the `comfyui` extension: turn each
 * configured workflow into a one-line capability summary the model reads
 * in the `generate_image` tool / `workflow` param descriptions.
 *
 * The line tells the model three things it otherwise learns only by
 * trial and error: what the workflow is for (`description` / `tags`),
 * which `generate_image` params it actually maps (so the model stops
 * passing args that error), and the prompting protocol it expects
 * (`promptProtocol`, e.g. booru tags vs natural language) plus whether
 * the prompt enhancer is recommended for it.
 *
 * No pi imports - testable under vitest.
 */

import { isRoleMap } from './workflow.ts';

import type { WorkflowConfig } from './types.ts';

/**
 * Workflow input-map keys are the internal tunable names; the model-facing
 * `generate_image` param of the same concept differs for one key: the
 * graph's `batch` maps to the tool's `count`. Everything else is 1:1.
 */
function toolParamName(inputKey: string): string {
  return inputKey === 'batch' ? 'count' : inputKey;
}

/**
 * The tunable scalar/text `generate_image` params a workflow maps, in the
 * order its input map declares them (no image arg). This is the set the
 * base/delta matrix compares against; image inputs are reported separately
 * as role names / reference-slot counts.
 */
export function tunableParams(wf: WorkflowConfig): string[] {
  return Object.keys(wf.inputs).map(toolParamName);
}

/**
 * The `generate_image` params a workflow actually supports, in the order
 * its input map declares them, plus the image arg it accepts: `inputImages`
 * for positional slots, `images` for named roles. Used both in the
 * capability line and (potentially) to validate calls up front.
 */
export function supportedParams(wf: WorkflowConfig): string[] {
  const params = tunableParams(wf);
  if (isRoleMap(wf.images)) params.push('images');
  else if (wf.images !== undefined && wf.images.length > 0) params.push('inputImages');
  return params;
}

/**
 * The tunable params common to EVERY configured workflow, in the order the
 * first workflow declares them. The base/delta matrix lists these once in a
 * header line so each per-workflow line only carries its extras. Empty when
 * there are no workflows or the workflows share no tunable param.
 */
export function commonParams(workflows: Record<string, WorkflowConfig>): string[] {
  const names = Object.keys(workflows);
  if (names.length === 0) return [];
  const lists = names.map((n) => tunableParams(workflows[n]));
  const [first, ...rest] = lists;
  return first.filter((p) => rest.every((list) => list.includes(p)));
}

/**
 * The image roles a workflow accepts, rendered for the capability line,
 * e.g. `init, mask (mask), control`. A `mask`-kind slot is tagged so the
 * model knows it can pass a bbox there. Empty for positional / text-to-image
 * workflows.
 */
export function imageRoleNames(wf: WorkflowConfig): string[] {
  if (!isRoleMap(wf.images)) return [];
  return Object.entries(wf.images).map(([role, slot]) => (slot.kind === 'mask' ? `${role} (mask)` : role));
}

/**
 * Whether the prompt enhancer is worth recommending for a workflow: true
 * when it declares a `promptProtocol` that is anything other than plain
 * natural language. A tag-based protocol (booru, comma-separated, …)
 * benefits from the enhancer translating a loose prompt into the right
 * shape; a natural-language protocol does not need it.
 */
export function recommendsEnhance(promptProtocol: string | undefined): boolean {
  if (promptProtocol === undefined) return false;
  const trimmed = promptProtocol.trim();
  if (trimmed.length === 0) return false;
  return !/natural\s*language/i.test(trimmed);
}

/** Rendering options shared by {@link describeWorkflow} / {@link describeWorkflows}. */
export interface DescribeOptions {
  /**
   * Append a "recommends enhance" hint for workflows whose `promptProtocol`
   * is non-trivial (see {@link recommendsEnhance}). Off by default so the
   * hint is only surfaced once the prompt enhancer is actually wired in.
   */
  enhanceHint?: boolean;
  /**
   * Params already stated in a shared header line (see {@link commonParams}).
   * When set, the per-workflow line drops these and shows only its extras as
   * `+a, b`, so the matrix doesn't repeat the common set on every line.
   */
  baseParams?: string[];
}

/**
 * One-line capability summary for a single named workflow, e.g.
 * `anima: anime / illustration [anime, sdxl] | params: prompt, negative,
 * seed, steps, cfg, count | protocol: Danbooru tags, comma-separated |
 * recommends enhance`. Sections are omitted when empty so a bare
 * text-to-image workflow stays short. The trailing enhance hint is shown
 * only when `opts.enhanceHint` is set.
 */
export function describeWorkflow(name: string, wf: WorkflowConfig, opts: DescribeOptions = {}): string {
  const parts: string[] = [];
  if (wf.description !== undefined && wf.description.length > 0) parts.push(wf.description);
  if (wf.tags !== undefined && wf.tags.length > 0) parts.push(`[${wf.tags.join(', ')}]`);

  const head = parts.length > 0 ? `${name}: ${parts.join(' ')}` : name;

  const sections: string[] = [head];
  const base = opts.baseParams;
  if (base !== undefined) {
    const extras = tunableParams(wf).filter((p) => !base.includes(p));
    if (extras.length > 0) sections.push(`+${extras.join(', ')}`);
  } else {
    const params = supportedParams(wf);
    if (params.length > 0) sections.push(`params: ${params.join(', ')}`);
  }
  const roles = imageRoleNames(wf);
  if (roles.length > 0) {
    sections.push(`roles: ${roles.join(', ')}`);
  } else {
    const slots = Array.isArray(wf.images) ? wf.images.length : 0;
    if (slots > 0) sections.push(`${slots} reference image${slots === 1 ? '' : 's'}`);
  }
  if (wf.promptProtocol !== undefined && wf.promptProtocol.length > 0) {
    sections.push(`protocol: ${wf.promptProtocol}`);
  }
  if (opts.enhanceHint && recommendsEnhance(wf.promptProtocol)) sections.push('recommends enhance');

  return sections.join(' | ');
}

/**
 * Multi-line capability matrix for every configured workflow, one
 * {@link describeWorkflow} line per entry. `defaultWorkflow` is marked so
 * the model knows which one a call with no `workflow` arg uses. Returns a
 * neutral note when there are no workflows.
 */
export function describeWorkflows(
  workflows: Record<string, WorkflowConfig>,
  defaultWorkflow: string,
  opts: DescribeOptions = {},
): string {
  const names = Object.keys(workflows);
  if (names.length === 0) return '(no workflows configured)';
  // Factor the params shared by every workflow into one header line so each
  // per-workflow line only carries its extras (`+denoise, width, height`).
  // Only worth it with more than one workflow and a non-empty common set.
  const base = names.length > 1 ? commonParams(workflows) : [];
  const lineOpts: DescribeOptions = base.length > 0 ? { ...opts, baseParams: base } : opts;
  const lines = names.map((name) => {
    const line = describeWorkflow(name, workflows[name], lineOpts);
    return name === defaultWorkflow ? `${line} (default)` : line;
  });
  if (base.length > 0) lines.unshift(`All workflows accept: ${base.join(', ')}.`);
  return lines.join('\n');
}

/**
 * Image-input + param capabilities aggregated across every configured
 * workflow, used by the extension to register only the `generate_image`
 * params some workflow can actually consume (a pure-text-to-image setup
 * never carries `inputImages` / `images` / mask params, etc.).
 */
export interface WorkflowCapabilities {
  /** Union of tunable params mapped by at least one workflow. */
  params: Set<string>;
  /** Some workflow maps BOTH width and height (so `aspect` is meaningful). */
  dimensions: boolean;
  /** Some workflow declares positional image slots (`inputImages`). */
  positionalImages: boolean;
  /** Some workflow declares a role-keyed image map (`images`). */
  roleImages: boolean;
  /** Some role map has a `mask`-kind slot (so bbox/feather/invert apply). */
  maskRole: boolean;
  /** Some workflow accepts any image input (so `refine` can feed one). */
  imageInput: boolean;
}

export function workflowCapabilities(workflows: Record<string, WorkflowConfig>): WorkflowCapabilities {
  const caps: WorkflowCapabilities = {
    params: new Set<string>(),
    dimensions: false,
    positionalImages: false,
    roleImages: false,
    maskRole: false,
    imageInput: false,
  };
  for (const wf of Object.values(workflows)) {
    for (const p of tunableParams(wf)) caps.params.add(p);
    if (wf.inputs.width !== undefined && wf.inputs.height !== undefined) caps.dimensions = true;
    if (isRoleMap(wf.images)) {
      caps.roleImages = true;
      caps.imageInput = true;
      if (Object.values(wf.images).some((slot) => slot.kind === 'mask')) caps.maskRole = true;
    } else if (wf.images !== undefined && wf.images.length > 0) {
      caps.positionalImages = true;
      caps.imageInput = true;
    }
  }
  return caps;
}
