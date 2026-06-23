/**
 * Shared types for the `comfyui` extension's pure helpers.
 *
 * Kept in one module so `config.ts`, `workflow.ts`, and `api.ts` agree
 * on the config / graph / output shapes without a circular import. No
 * pi imports - everything here is plain data validated out of untrusted
 * JSON.
 */

/** A single request header injected on every ComfyUI call (HTTP + ws). */
export interface AuthHeader {
  name: string;
  value: string;
}

/**
 * Where a tunable parameter lives inside an API-format workflow graph:
 * the `node` id (the object key in the graph) and the `key` inside that
 * node's `inputs` object.
 */
export interface InputMapping {
  node: string;
  key: string;
}

/**
 * A named image slot ({@link InputMapping}) plus its role metadata. Used
 * when a workflow declares image inputs by role (`init`, `mask`,
 * `control`, …) instead of by position. A `mask` slot additionally
 * accepts a bbox synth spec (the extension rasterizes the mask) and may
 * flip its polarity.
 */
export interface RoleMapping extends InputMapping {
  /**
   * `mask` marks a slot that a `{ bbox }` synth spec may target; `image`
   * (the default) takes only a path. Drives both validation and the
   * capability matrix.
   */
  kind?: 'image' | 'mask';
  /**
   * Mask polarity for a `mask` slot: by default white = the region to
   * change, black = keep. `true` flips it for graphs whose mask node
   * expects the opposite. Ignored for non-mask slots.
   */
  invert?: boolean;
}

/**
 * A workflow's image inputs: EITHER an ordered positional list (filled by
 * the `inputImages` tool arg) OR a role-keyed map (filled by the `images`
 * tool arg). The two are mutually exclusive per workflow.
 */
export type ImageSlots = InputMapping[] | Record<string, RoleMapping>;

/** A named workflow: the API-format JSON file plus its parameter map. */
export interface WorkflowConfig {
  /** Path to the API-format workflow JSON. `~` is expanded by the caller. */
  file: string;
  /** Maps tunable names (`prompt`, `seed`, …) to their node id + input key. */
  inputs: Record<string, InputMapping>;
  /**
   * Image input slots for edit / img2img / inpaint workflows. Either:
   *
   * - an ordered `InputMapping[]` (positional): each entry is a
   *   `LoadImage`-style node id + key; the `inputImages` tool arg fills
   *   them in order, leaving unfilled trailing slots at their graph
   *   default; or
   * - a role-keyed `Record<string, RoleMapping>` (named): the `images`
   *   tool arg supplies each slot by role, and a `mask` slot can be
   *   synthesized from a bbox.
   *
   * Absent for pure text-to-image workflows. See {@link ImageSlots}.
   */
  images?: ImageSlots;
  /**
   * One-line human description of what this workflow is for (e.g. "anime /
   * illustration (booru-tag prompting)"). Surfaced in the tool + `workflow`
   * param descriptions so the model picks the right workflow. Optional.
   */
  description?: string;
  /** Short discoverability tags (e.g. `["anime", "sdxl"]`), surfaced alongside `description`. Optional. */
  tags?: string[];
  /**
   * Free-text hint describing the prompting protocol the model should send
   * for this workflow's `prompt` / `negative` (e.g. "Danbooru tags,
   * comma-separated" vs "natural language"). The main model sends prompts
   * in the workflow's native protocol; this surfaces the dialect in the
   * capability matrix. A non-trivial value also drives the
   * "recommends enhance" hint. Optional.
   */
  promptProtocol?: string;
  /**
   * Path to a per-workflow prompt-enhancer guidance doc, concatenated
   * after the global {@link ComfyuiConfig.enhanceGuidanceFile} when the
   * enhancer runs. Resolves like {@link WorkflowConfig.file} (`~` /
   * absolute / relative-to-cwd). Optional - the enhancer degrades to
   * `description` / `tags` when absent. Never blocks a render.
   */
  guidanceFile?: string;
  /**
   * Per-workflow override of the global {@link ComfyuiConfig.enhance} flag.
   * `true` enhances by default for this workflow even when the global
   * default is off (and vice versa); a per-call `enhance` arg still wins.
   * Resolution is `param ?? workflow.enhance ?? config.enhance`. Optional.
   */
  enhance?: boolean;
}

/**
 * Per-project / global generation-param defaults. Each field pre-fills
 * the matching `generate_image` param when the model omits it, so a user
 * can pin "this project renders 1024x1024 at 30 steps" without editing
 * every workflow graph. Resolution is `param ?? defaults?.X ??
 * workflow-baked value` - a default just supplies the param before the
 * graph builder injects it, so a workflow that doesn't map a given input
 * still ignores the default. All fields optional.
 */
export interface GenerationDefaults {
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  denoise?: number;
  /** Batch size; maps to the workflow's `batch` input. */
  count?: number;
  /** Negative prompt. */
  negative?: string;
}

/** Fully-resolved extension config (defaults + user + project layers). */
export interface ComfyuiConfig {
  /** ComfyUI server origin, e.g. `http://127.0.0.1:8188`. */
  baseUrl: string;
  /** Optional auth header sent on every request; value supports `${ENV}`. */
  authHeader?: AuthHeader;
  /** Hard cap on a single generation before it is aborted (ms). */
  timeoutMs: number;
  /** Directory (relative to cwd) where generated PNGs are written. */
  saveDir: string;
  /** Name of the workflow used when the tool call omits `workflow`. */
  defaultWorkflow: string;
  /**
   * Whether the generated image is returned in the tool result (and so
   * fed back to the model on the next turn). When `false`, the image is
   * still saved to disk but the result is text-only - no image tokens
   * enter the model's context. A per-call `sendToModel` arg overrides it.
   */
  sendToModel: boolean;
  /**
   * Whether a generation is rendered as an *ephemeral* scene by default:
   * the image is shown inline in the terminal for the turn it is
   * generated, but the whole `generate_image` call + image is collapsed
   * out of the model's context (this turn's continuation and every later
   * turn) so it never costs persistent context tokens and the model never
   * re-reads it. The image block still rides in the tool result (the TUI
   * renders from it); a `context`-hook overlay strips it from the provider
   * payload, so the `sendToModel` / vision gate is moot for an ephemeral
   * render. Off by default. A per-call `ephemeral` arg overrides it.
   * Applies to foreground renders only (a `background` job returns no
   * image to collapse).
   */
  ephemeral: boolean;
  /**
   * Whether a generation is submitted as a background job by default
   * (returning the job id immediately instead of waiting for the render).
   * When `false`, the call blocks until the image is ready. A per-call
   * `background` arg overrides it.
   */
  background: boolean;
  /**
   * Whether background jobs are polled off-turn and their PNGs fetched
   * to {@link saveDir} automatically the moment the render finishes,
   * without waiting for an `image_jobs` collect. The file lands on disk
   * either way; auto-download cannot push the image into the model's
   * context (only a model-invoked `collect` can do that). On by default.
   */
  autoDownload: boolean;
  /**
   * How often (ms) the background auto-download timer polls `/history`
   * for each running job. Only meaningful when {@link autoDownload} is
   * on. Clamped to a sane floor by the loader.
   */
  pollIntervalMs: number;
  /**
   * Optional generation-param defaults applied before the per-call
   * params and the workflow-baked graph values. See
   * {@link GenerationDefaults}.
   */
  defaults?: GenerationDefaults;
  /**
   * Whether the agent-driven prompt enhancer runs by default. When on,
   * `generate_image` refines the positive + negative into the workflow's
   * native protocol via a one-shot subagent before submitting. Off by
   * default; a per-call `enhance` arg overrides it, and
   * `PI_COMFYUI_DISABLE_ENHANCE` hard-disables it.
   */
  enhance: boolean;
  /**
   * Optional model spec (`provider/model-id`) for the enhancer subagent.
   * Absent → the enhancer inherits the active session model. Lets a user
   * point enhancement at a cheaper model than the main agent.
   */
  enhanceModel?: string;
  /**
   * Max characters of recent conversation auto-captured and handed to the
   * enhancer as background scene context (continuity the calling model did
   * not pass in the `context` arg). `0` / absent → off (the enhancer sees
   * only the prompt + any manual `context`). Lets the enhancer enrich an
   * already-formatted prompt with scene detail. Costs extra input tokens
   * per enhance call on the inherited model, so it is opt-in.
   */
  enhanceContextChars?: number;
  /**
   * Optional wall-clock cap (ms) for a single enhancer run. Absent →
   * 30000. Raise it when the enhancer inherits a slow model and aborts
   * with `timed out after …ms` before producing JSON.
   */
  enhanceTimeoutMs?: number;
  /**
   * Optional path to a global prompt-enhancer guidance doc, concatenated
   * before any per-workflow {@link WorkflowConfig.guidanceFile}. Resolves
   * like a workflow `file` (`~` / absolute / relative-to-cwd).
   */
  enhanceGuidanceFile?: string;
  /**
   * Optional cap (px) on the longer side of the image COPY fed back to the
   * model. The file written to {@link saveDir} is always full resolution;
   * only the inline tool-result block is downscaled, since image token
   * cost scales with pixel dimensions. Absent / `0` = send full-res. A
   * per-call `previewMaxDimension` arg overrides it; only still raster
   * images are resized (animated / non-image outputs pass through).
   */
  previewMaxDimension?: number;
  /** Named workflows keyed by the name the model passes to the tool. */
  workflows: Record<string, WorkflowConfig>;
}

/** A generated-image reference as ComfyUI reports it in `/history`. */
export interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

/** One node in an API-format workflow graph. */
export interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}

/** An API-format workflow graph: node id -> node. */
export type ComfyWorkflow = Record<string, ComfyNode>;
