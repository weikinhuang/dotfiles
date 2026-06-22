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
 * The `generate_image` params a workflow actually supports, in the order
 * its input map declares them, plus the image arg it accepts: `inputImages`
 * for positional slots, `images` for named roles. Used both in the
 * capability line and (potentially) to validate calls up front.
 */
export function supportedParams(wf: WorkflowConfig): string[] {
  const params = Object.keys(wf.inputs).map(toolParamName);
  if (isRoleMap(wf.images)) params.push('images');
  else if (wf.images !== undefined && wf.images.length > 0) params.push('inputImages');
  return params;
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
  const params = supportedParams(wf);
  if (params.length > 0) sections.push(`params: ${params.join(', ')}`);
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
  return names
    .map((name) => {
      const line = describeWorkflow(name, workflows[name], opts);
      return name === defaultWorkflow ? `${line} (default)` : line;
    })
    .join('\n');
}
