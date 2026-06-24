/**
 * `generate_image` parameter schema for the comfyui extension. Lives under
 * `ext/` only to keep the oversized shell small; it depends on no pi
 * runtime, just TypeBox + the pure config / capability types.
 *
 * The full prop set below carries the precise TypeBox `Static` types the
 * executor relies on ({@link GenerateParams}); {@link buildGenerateParams}
 * layers in the config-derived defaults and then drops (at runtime) the
 * params no configured workflow can consume, so the model-facing tool
 * definition only advertises what is usable. Every param is optional and the
 * executor reads `params.X ?? config.X`, so dropping one is purely a schema
 * change - the static type stays complete.
 */

import { type Static, type TObject, Type } from 'typebox';

import type { WorkflowCapabilities } from '../../comfyui/describe.ts';
import type { ComfyuiConfig } from '../../comfyui/types.ts';

const maskValue = Type.Object({
  bbox: Type.Array(Type.Array(Type.Number()), {
    description: 'Normalized [x, y, w, h] rects (0-1, top-left origin), unioned for multi-region edits.',
  }),
  feather: Type.Optional(Type.Number({ description: 'Mask edge softening in px (default 0).' })),
  invert: Type.Optional(Type.Boolean({ description: 'Flip polarity (default white = region to change).' })),
});

// The boolean params whose JSON-schema `default` is config-derived carry a
// description-only schema here (defaults are type-irrelevant and layered in
// buildGenerateParams). The `workflow` description's available-list is
// likewise filled in at build time.
const PROPS = {
  prompt: Type.Optional(Type.String({ description: 'What to depict. Required unless `variationOf` reuses one.' })),
  negative: Type.Optional(Type.String({ description: 'What to avoid.' })),
  variationOf: Type.Optional(
    Type.String({
      description:
        'Reuse a prior generation id (e.g. "g3"): inherits its workflow/prompt/negative/seed/dims; any param here overrides.',
    }),
  ),
  refine: Type.Optional(
    Type.String({
      description:
        'Reuse a prior generation id as the input image for an edit workflow; set `workflow` + `prompt` to the edit. Not with `inputImages`.',
    }),
  ),
  workflow: Type.Optional(Type.String({ description: 'Workflow name (see the tool description for the list).' })),
  width: Type.Optional(Type.Number({ description: 'Output width (px).' })),
  height: Type.Optional(Type.Number({ description: 'Output height (px).' })),
  aspect: Type.Optional(
    Type.String({
      description: 'Aspect preset (e.g. "16:9", "portrait", "square") setting width/height; explicit dims win.',
    }),
  ),
  steps: Type.Optional(Type.Number({ description: 'Sampler steps.' })),
  cfg: Type.Optional(Type.Number({ description: 'CFG / guidance scale.' })),
  seed: Type.Optional(Type.Number({ description: 'Omit for random; reuse to reproduce.' })),
  denoise: Type.Optional(Type.Number({ description: 'Denoise strength 0-1 (img2img).' })),
  inputImages: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Reference image paths for img2img/edit workflows, e.g. ["~/in.png"]; filled into slots in order.',
    }),
  ),
  images: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), maskValue]), {
      description:
        'Image inputs keyed by role (init, mask, control); value is a path, or a { bbox } mask spec. Not with inputImages.',
    }),
  ),
  count: Type.Optional(Type.Number({ description: 'Batch size.' })),
  sendToModel: Type.Optional(
    Type.Boolean({ description: 'Return the image to you for analysis; false = save to disk only.' }),
  ),
  ephemeral: Type.Optional(
    Type.Boolean({
      description:
        'Show once, then drop the call+image from context (not seen on later turns); for VN/roleplay scene renders. Foreground only.',
    }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: 'Return immediately; collect later via `image_jobs`. For slow renders.' }),
  ),
  enhance: Type.Optional(
    Type.Boolean({ description: "Refine prompt+negative into the workflow's protocol via a helper agent first." }),
  ),
  autoRefine: Type.Optional(
    Type.Boolean({
      description:
        'After rendering, run a vision critic and loop corrective re-renders until the image passes or a budget is hit. Forces count=1.',
    }),
  ),
  refineCriteria: Type.Optional(
    Type.String({
      description:
        'Explicit acceptance criteria for auto-refine (e.g. "full body, facing left"); absent = derived from the prompt. Only with autoRefine.',
    }),
  ),
  context: Type.Optional(
    Type.String({
      description: 'Background for enhancement (scene/continuity) to honor without depicting. Only with enhance.',
    }),
  ),
  previewMaxDimension: Type.Optional(
    Type.Number({
      description:
        "Downscale the returned copy's longer side to this many px (saved file stays full-res) to save tokens.",
    }),
  ),
};

/** Full prop record shape - the static type the executor reads. */
type GenerateProps = typeof PROPS;

/** Static param type for the `generate_image` tool body (all optional). */
export type GenerateParams = Static<TObject<GenerateProps>>;

/**
 * Build the `generate_image` TypeBox schema: layer the config-derived
 * defaults onto the boolean params + the workflow-list description, then
 * prune params no configured workflow can consume so the model-facing
 * definition only advertises usable args. The returned schema is typed as
 * the full {@link GenerateProps} object (dropped keys are runtime-only), so
 * the executor's param type is complete.
 */
export function buildGenerateParams(
  registrationConfig: ComfyuiConfig,
  caps: WorkflowCapabilities,
  enhanceAvailableAtReg: boolean,
  refineAvailableAtReg: boolean,
): TObject<GenerateProps> {
  const workflowList = Object.keys(registrationConfig.workflows).join(', ') || '(none)';
  const props: GenerateProps = { ...PROPS };
  // Layer in the config-derived defaults + the workflow-list description.
  props.workflow = Type.Optional(
    Type.String({ description: `One of: ${workflowList}. Default ${registrationConfig.defaultWorkflow}.` }),
  );
  props.sendToModel = Type.Optional(
    Type.Boolean({
      default: registrationConfig.sendToModel,
      description: 'Return the image to you for analysis; false = save to disk only.',
    }),
  );
  props.ephemeral = Type.Optional(
    Type.Boolean({
      default: registrationConfig.ephemeral,
      description:
        'Show once, then drop the call+image from context (not seen on later turns); for VN/roleplay scene renders. Foreground only.',
    }),
  );
  props.background = Type.Optional(
    Type.Boolean({
      default: registrationConfig.background,
      description: 'Return immediately; collect later via `image_jobs`. For slow renders.',
    }),
  );
  props.enhance = Type.Optional(
    Type.Boolean({
      default: registrationConfig.enhance,
      description: "Refine prompt+negative into the workflow's protocol via a helper agent first.",
    }),
  );
  props.autoRefine = Type.Optional(
    Type.Boolean({
      default: registrationConfig.autoRefine,
      description:
        'After rendering, run a vision critic and loop corrective re-renders until the image passes or a budget is hit. Forces count=1.',
    }),
  );

  const mapsParam = (p: string): boolean => caps.params.has(p);
  // Casting to a loose record keeps the precise `GenerateProps` (and thus
  // the executor's param types) while letting us delete keys at runtime;
  // the schema TypeBox builds reflects only the surviving keys.
  const dropProp = (key: string): void => {
    delete (props as Record<string, unknown>)[key];
  };
  for (const p of ['negative', 'width', 'height', 'steps', 'cfg', 'seed', 'denoise', 'count']) {
    if (!mapsParam(p)) dropProp(p);
  }
  if (!caps.dimensions) dropProp('aspect');
  if (!caps.imageInput) dropProp('refine');
  if (!caps.positionalImages) dropProp('inputImages');
  if (!caps.roleImages) {
    dropProp('images');
  } else if (!caps.maskRole) {
    // Role workflows without a mask slot take only file paths, so drop the
    // bbox-mask object from the `images` value union.
    (props as Record<string, unknown>).images = Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: 'Image inputs keyed by role (init, control); value is a file path. Not with inputImages.',
      }),
    );
  }
  if (!enhanceAvailableAtReg) {
    dropProp('enhance');
    dropProp('context');
  }
  // autoRefine + refineCriteria surface only when the comfyui-critic agent is
  // installed and not env-disabled (mirrors the enhance gating); at runtime
  // the loop still no-ops gracefully when no vision model resolves.
  if (!refineAvailableAtReg) {
    dropProp('autoRefine');
    dropProp('refineCriteria');
  }
  return Type.Object(props);
}
