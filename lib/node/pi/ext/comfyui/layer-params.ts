/**
 * Pure parameter-layering for the `generate_image` executor, extracted
 * from generate.ts so the precedence rules are testable in isolation.
 *
 * Lives under `ext/` (not pure `lib/node/pi/comfyui/`) only because it
 * references the {@link GenerateParams} TypeBox type, which is defined in
 * the sibling `params.ts`; the function itself imports no pi runtime.
 *
 * Resolution order per field is `per-call param ?? aspect-derived ??
 * reuse (variationOf) ?? config defaults`, with the workflow-baked graph
 * value as the final fallback (the graph builder only injects params that
 * are present, so an unset field simply isn't overridden).
 */

import type { GenerationRecord } from '../../comfyui/generations.ts';
import type { GenerationDefaults } from '../../comfyui/types.ts';
import type { GenerateParams } from './params.ts';

/** {@link GenerateParams} after layering: the prompt is always resolved. */
export type ResolvedGenerateParams = GenerateParams & { prompt: string };

export interface LayerParamsInput {
  /** The raw per-call params. */
  params: GenerateParams;
  /** The positive prompt to render (post-enhancement, else the call's prompt). */
  prompt: string;
  /** Negative produced by the enhancer, when it ran; replaces the baseline. */
  enhancedNegative?: string;
  /** Baseline negative resolved before enhancement (`param ?? reuse ?? defaults`). */
  baselineNegative?: string;
  /** Prior render inherited via `variationOf` (seed / dims fallback). */
  reuse?: Pick<GenerationRecord, 'seed' | 'width' | 'height'>;
  /** Aspect-preset-derived dimensions, when an `aspect` was given. */
  aspectDims?: { width: number; height: number };
  /** Config `defaults` block. */
  defaults?: GenerationDefaults;
  /** True when the workflow uses named image roles (positional inputImages are dropped). */
  roleMode: boolean;
  /** A `refine` source image path, fed as the sole positional input in non-role mode. */
  refineImage?: string;
}

/**
 * Layer the config `defaults` (and any aspect-derived dimensions) under
 * the per-call params, returning the fully-resolved param object the graph
 * builder consumes. Explicit per-call `width`/`height` still beat `aspect`.
 */
export function layerGenerationParams(input: LayerParamsInput): ResolvedGenerateParams {
  const { params, reuse, aspectDims, defaults: d, roleMode, refineImage } = input;
  return {
    ...params,
    prompt: input.prompt,
    negative: input.enhancedNegative ?? input.baselineNegative,
    seed: params.seed ?? reuse?.seed,
    width: params.width ?? aspectDims?.width ?? reuse?.width ?? d?.width,
    height: params.height ?? aspectDims?.height ?? reuse?.height ?? d?.height,
    steps: params.steps ?? d?.steps,
    cfg: params.cfg ?? d?.cfg,
    denoise: params.denoise ?? d?.denoise,
    count: params.count ?? d?.count,
    // Positional refine feeds inputImages[0]; in role mode the prior render
    // goes into the `init` role instead (handled by the caller), so
    // inputImages stays empty.
    inputImages: roleMode ? undefined : refineImage !== undefined ? [refineImage] : params.inputImages,
  };
}
