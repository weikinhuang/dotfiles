/**
 * Shared wiring for the comfyui auto-refine loop, used by BOTH entry
 * points: the `autoRefine` flag on `generate_image` (refine a fresh
 * render) and the standalone `/comfyui refine <gX>` command (refine an
 * existing gallery render). Lives under `ext/` because it stitches the
 * pure refine engine ({@link ../../comfyui/refine.ts}) to the network
 * render primitives ({@link ../../comfyui/client.ts}); it imports no pi
 * runtime, so the loop stays unit-testable with an injected `renderAction`.
 *
 * Two pieces:
 *
 * 1. {@link renderViaWorkflow} - the corrective-render primitive: build the
 *    workflow graph from a (possibly modified) param set, submit it, wait
 *    for the image, fetch + save it, and return a {@link RenderedImage}.
 *    Used for every reroll / revise_prompt re-render (and, later, the
 *    companion channels).
 * 2. {@link runRefinePass} - the refiner-aware loop driver: it wraps the
 *    `comfyui-critic` refiner as the `critique` half and the injected
 *    `renderAction` as the `render` half, threads the available-action
 *    hint, surfaces per-round progress, and delegates the actual reducer
 *    to the pure {@link runRefineLoop}.
 */

import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  buildInjectedGraph,
  type Conn,
  createWaker,
  fetchAndSave,
  type ImageBlockTransform,
  openProgressSocket,
  submitPrompt,
  waitForImages,
} from '../../comfyui/client.ts';
import { regionToBbox } from '../../comfyui/mask.ts';
import {
  ALWAYS_AVAILABLE_CHANNELS,
  COMPANION_CHANNELS,
  type CritiqueRequest,
  type RefineAction,
  type RefineChannel,
  type Refiner,
  type RefineContext,
  type RefineLoopResult,
  runRefineLoop,
} from '../../comfyui/refine.ts';
import type { RefineWith, RoleMapping, WorkflowConfig } from '../../comfyui/types.ts';
import { isRoleMap } from '../../comfyui/workflow.ts';
import { resolveRoleImages, type RoleImageInput } from './images.ts';
import type { ResolvedGenerateParams } from './layer-params.ts';

/**
 * The companion-backed channels as a membership set, derived from the pure
 * module's single {@link COMPANION_CHANNELS} definition so the two never drift.
 */
const COMPANION_CHANNEL_SET = new Set<RefineChannel>(COMPANION_CHANNELS);

/**
 * Gaussian feather (sigma, px) applied to the auto-refine inpaint mask. The
 * critic names only a COARSE region, so a hard-edged rectangle can leave a
 * tonal seam where the masked boundary crosses a high-contrast edge (a
 * hairline, an outline). A modest feather ramps the `SetLatentNoiseMask`
 * denoise strength at the boundary so the repaint blends. Applied only on the
 * synthesized refine mask - an explicit user `images:{mask:{bbox}}` call keeps
 * its hard edge (default `feather` 0) for predictable, deliberate masking.
 */
const REFINE_MASK_FEATHER_PX = 12;

/**
 * Built-in fallback mapping from the critic's semantic `detect` keyword to the
 * Ultralytics detector model filename a `detailer` companion's
 * `UltralyticsDetectorProvider` loads. The critic emits only these four
 * keywords (see `comfyui-critic.md`); the adetailer repo has no dedicated eyes
 * model, so `eyes` reuses the face detector (it re-renders the whole face
 * crop). A companion workflow's optional `detectModels` overrides any entry.
 */
const DEFAULT_DETECT_MODELS: Readonly<Record<string, string>> = {
  hand: 'bbox/hand_yolov8s.pt',
  face: 'bbox/face_yolov8m.pt',
  eyes: 'bbox/face_yolov8m.pt',
  person: 'segm/person_yolov8m-seg.pt',
};

/**
 * Translate a critic `detect` keyword into the detector model filename to
 * inject into the companion's `UltralyticsDetectorProvider`. Falls back to the
 * keyword itself when neither the workflow's `detectModels` nor the built-in
 * defaults know it, so a graph author can wire a custom detector by filename.
 */
function resolveDetectModel(detect: string, wf: WorkflowConfig): string {
  return wf.detectModels?.[detect] ?? DEFAULT_DETECT_MODELS[detect] ?? detect;
}

/**
 * Companion-only inputs the refine loop injects into a repair workflow that a
 * normal render never carries: a grounder target phrase (`ground`) and a
 * detector class (`detailer`). A companion graph that uses them maps `target`
 * / `detect` in its input map; the source t2i workflows leave both unset.
 */
export interface RefineExtraInputs {
  target?: string;
  detect?: string;
  /** The critic's free-form corrective instruction (`img2img` / `inpaint`). */
  instruction?: string;
}

/** One landed render the loop carries around: its block, path, and render params. */
export interface RenderedImage {
  /** The inline multimodal image block for the tool result / TUI. */
  block: { type: 'image'; data: string; mimeType: string };
  /** Absolute path the PNG was written to. */
  savedPath: string;
  /** Seed used for this render, when known. */
  seed?: number;
  /** Positive prompt this render used (post-enhancement / post-revision). */
  prompt: string;
  /** Negative prompt this render used, when any. */
  negative?: string;
  /** Resolved output width, when the workflow maps one. */
  width?: number;
  /** Resolved output height, when the workflow maps one. */
  height?: number;
}

/**
 * Build a workflow graph from `params`, submit it, wait for the single
 * image, fetch + save it, and return the landed {@link RenderedImage}.
 * Throws on a bad workflow / submit error (the loop's `render` is wrapped
 * so a throw aborts that round rather than the whole generation). Under
 * auto-refine `count` is pinned to 1, so the first saved image is the one.
 */
export async function renderViaWorkflow(deps: {
  conn: Conn;
  wf: WorkflowConfig;
  name: string;
  cwd: string;
  params: ResolvedGenerateParams & RefineExtraInputs;
  roleImages?: Record<string, string>;
  signal: AbortSignal;
  report: (text: string) => void;
  /** Directory the rendered PNG is written to. */
  saveDir: string;
  /** Stream progress over the websocket when set (foreground only). */
  streamProgress?: boolean;
  previewTransform?: ImageBlockTransform;
}): Promise<RenderedImage> {
  const { conn, wf, name, cwd, params, roleImages, signal, report } = deps;
  const clientId = randomUUID();
  const prep = await buildInjectedGraph(conn, wf, name, params, cwd, homedir(), report, signal, roleImages);
  if (prep.error || !prep.graph) throw new Error(prep.error ?? 'failed to prepare workflow');
  const promptId = await submitPrompt(conn, prep.graph, clientId, signal);
  const waker = createWaker();
  const socket = openProgressSocket(conn, clientId, promptId, deps.streamProgress ? report : undefined, signal, waker);
  try {
    const refs = await waitForImages(conn, promptId, signal, waker);
    const saved = await fetchAndSave(conn, refs, deps.saveDir, signal, deps.previewTransform);
    const first = saved[0];
    if (first === undefined) throw new Error('render produced no image');
    return {
      block: first.block,
      savedPath: first.savedPath,
      seed: prep.seed,
      prompt: params.prompt,
      ...(params.negative !== undefined ? { negative: params.negative } : {}),
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.height !== undefined ? { height: params.height } : {}),
    };
  } finally {
    try {
      socket?.close();
    } catch {
      /* already closing */
    }
  }
}

/** Apply a refine action to a base param set, producing the next render's params. */
export function applyRefineAction(base: ResolvedGenerateParams, action: RefineAction): ResolvedGenerateParams {
  const next: ResolvedGenerateParams = { ...base };
  if (action.type === 'reroll') {
    // A fresh roll: drop the seed so the graph builder randomizes again.
    next.seed = undefined;
  } else if (action.type === 'revise_prompt') {
    if (action.prompt !== undefined) next.prompt = action.prompt;
    if (action.negative !== undefined) next.negative = action.negative;
    // The critic decides whether to also reroll alongside the prompt change.
    if (action.newSeed === true) next.seed = undefined;
  }
  // Companion channels (img2img / inpaint / detailer / ground) never reach
  // this primitive: they route to a different workflow with a freshly built
  // role-image set, handled by `renderRefineAction`.
  return next;
}

/**
 * Everything {@link renderRefineAction} needs to route one corrective render:
 * the source (t2i) workflow + its render #0 params for reroll / revise_prompt,
 * the full configured-workflow map + the source's `refineWith` companions for
 * the companion channels, and the shared connection / output plumbing.
 */
export interface RefineRenderDeps {
  conn: Conn;
  cwd: string;
  saveDir: string;
  signal: AbortSignal;
  report: (text: string) => void;
  /** Stream progress over the websocket when set (foreground only). */
  streamProgress?: boolean;
  previewTransform?: ImageBlockTransform;
  /** The source text-to-image workflow + name (reroll / revise_prompt). */
  sourceWf: WorkflowConfig;
  sourceName: string;
  /** Render #0's fully-resolved params, cloned + modified per action. */
  baseParams: ResolvedGenerateParams;
  /** Role uploads from render #0, reused verbatim by reroll / revise_prompt. */
  sourceRoleImages?: Record<string, string>;
  /** Every configured workflow, for companion lookup by name. */
  workflows: Record<string, WorkflowConfig>;
  /** The source workflow's companion map. */
  refineWith?: RefineWith;
}

/**
 * The pure routing decision for one corrective render, separated from the IO
 * so it is unit-testable without a network / `sharp`. Either re-render the
 * SOURCE workflow (the t2i channels, or a defensive downgrade) or run a
 * COMPANION workflow with a freshly built role-image source set.
 */
export type RefineRenderPlan =
  | { kind: 'source'; action: RefineAction; downgradedFrom?: RefineChannel }
  | {
      kind: 'companion';
      name: string;
      wf: WorkflowConfig;
      roleMap: Record<string, RoleMapping>;
      params: ResolvedGenerateParams & RefineExtraInputs;
      /** Role -> source (init path; a bbox mask synth spec for inpaint). */
      roleSources: Record<string, RoleImageInput>;
    };

/**
 * Decide how to render one corrective action (pure - no IO). The t2i channels
 * (`reroll` / `revise_prompt`) re-render the SOURCE workflow. A companion
 * channel routes to the workflow named in `refineWith`, feeding `currentImage`
 * (the render being repaired) into the companion's `init` role plus the
 * action's params (`denoise` / `target` / `detect`); an `inpaint` companion
 * with a `mask` role also gets a mask synth spec from the coarse `region`
 * (mapped via {@link regionToBbox}, the critic names a region, never a box).
 * The engine only proposes a companion that {@link resolveAvailableChannels}
 * verified, so a missing / non-role-map / init-less companion here is
 * defensive: it downgrades to a source `reroll` (carrying `downgradedFrom` so
 * the executor can warn) rather than wedging the loop.
 */
export function planRefineRender(
  action: RefineAction,
  currentImage: RenderedImage,
  ctx: {
    baseParams: ResolvedGenerateParams;
    workflows: Record<string, WorkflowConfig>;
    refineWith?: RefineWith;
  },
): RefineRenderPlan {
  if (!COMPANION_CHANNEL_SET.has(action.type)) return { kind: 'source', action };

  const name = ctx.refineWith?.[action.type as keyof RefineWith];
  const wf = name !== undefined ? ctx.workflows[name] : undefined;
  if (name === undefined || wf === undefined || !isRoleMap(wf.images) || !('init' in wf.images)) {
    return { kind: 'source', action: { type: 'reroll' }, downgradedFrom: action.type };
  }
  const roleMap = wf.images;

  const roleSources: Record<string, RoleImageInput> = { init: currentImage.savedPath };
  if (action.type === 'inpaint' && 'mask' in roleMap) {
    roleSources.mask = { bbox: [Array.from(regionToBbox(action.region))], feather: REFINE_MASK_FEATHER_PX };
  }

  // The source prompt / negative carry over (the companion repaints in-style);
  // `count` is pinned to 1, positional inputs are dropped (role mode), and the
  // action's denoise / target / detect are layered on. A `detailer` detect
  // keyword is translated to its detector model filename before injection.
  const detect =
    action.type === 'detailer' && action.detect !== undefined ? resolveDetectModel(action.detect, wf) : action.detect;
  // The critic's free-form `instruction` rides along only when the companion
  // workflow actually maps an `instruction` input; otherwise it would trip the
  // graph builder's unmapped-but-supplied mapping-error guard.
  const instruction = wf.inputs.instruction !== undefined ? action.instruction : undefined;
  const params: ResolvedGenerateParams & RefineExtraInputs = {
    ...ctx.baseParams,
    count: 1,
    inputImages: undefined,
    ...(action.denoise !== undefined ? { denoise: action.denoise } : {}),
    ...(action.target !== undefined ? { target: action.target } : {}),
    ...(detect !== undefined ? { detect } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
  };
  return { kind: 'companion', name, wf, roleMap, params, roleSources };
}

/**
 * Execute one corrective refine render: take the pure {@link planRefineRender}
 * decision and run it - re-submit the source workflow, or upload the init
 * image (+ synthesize the inpaint mask via {@link resolveRoleImages}) and
 * submit the companion. A failed mask / upload throws, aborting just this
 * round so the loop keeps the best-so-far.
 */
export async function renderRefineAction(
  deps: RefineRenderDeps,
  action: RefineAction,
  currentImage: RenderedImage,
): Promise<RenderedImage> {
  const plan = planRefineRender(action, currentImage, {
    baseParams: deps.baseParams,
    workflows: deps.workflows,
    ...(deps.refineWith !== undefined ? { refineWith: deps.refineWith } : {}),
  });

  if (plan.kind === 'source') {
    if (plan.downgradedFrom !== undefined) {
      deps.report(`refine: ${plan.downgradedFrom} companion is not usable; rerolling instead`);
    }
    return renderViaWorkflow({
      conn: deps.conn,
      wf: deps.sourceWf,
      name: deps.sourceName,
      cwd: deps.cwd,
      params: applyRefineAction(deps.baseParams, plan.action),
      ...(deps.sourceRoleImages !== undefined ? { roleImages: deps.sourceRoleImages } : {}),
      signal: deps.signal,
      report: deps.report,
      saveDir: deps.saveDir,
      ...(deps.streamProgress !== undefined ? { streamProgress: deps.streamProgress } : {}),
      ...(deps.previewTransform !== undefined ? { previewTransform: deps.previewTransform } : {}),
    });
  }

  const resolved = await resolveRoleImages(
    deps.conn,
    plan.roleMap,
    plan.roleSources,
    { width: currentImage.width ?? deps.baseParams.width, height: currentImage.height ?? deps.baseParams.height },
    homedir(),
    deps.report,
    deps.signal,
  );
  if (resolved.error !== undefined) throw new Error(resolved.error);

  return renderViaWorkflow({
    conn: deps.conn,
    wf: plan.wf,
    name: plan.name,
    cwd: deps.cwd,
    params: plan.params,
    ...(resolved.uploadedByRole !== undefined ? { roleImages: resolved.uploadedByRole } : {}),
    signal: deps.signal,
    report: deps.report,
    saveDir: deps.saveDir,
    ...(deps.streamProgress !== undefined ? { streamProgress: deps.streamProgress } : {}),
    ...(deps.previewTransform !== undefined ? { previewTransform: deps.previewTransform } : {}),
  });
}

/** The de-duplicated available-action hint handed to the critic. */
export function availableActionsFor(channels: readonly RefineChannel[]): RefineChannel[] {
  return Array.from(new Set<RefineChannel>([...ALWAYS_AVAILABLE_CHANNELS, ...channels]));
}

/**
 * Drive the auto-refine loop for one initial render. `refiner` is the
 * `comfyui-critic` wiring (the `critique` half); `renderAction` is the
 * caller-supplied corrective-render primitive (the `render` half, bound to
 * the caller's abort signal). Reports `refining <n>/<max>, score <s>` before
 * each corrective render. Returns the best-so-far {@link RefineLoopResult};
 * never throws past the engine's own graceful degrade.
 */
export async function runRefinePass<M>(deps: {
  refiner: Refiner<M>;
  agentCtx: RefineContext<M>;
  initialImage: RenderedImage;
  renderAction: (action: RefineAction, currentImage: RenderedImage) => Promise<RenderedImage>;
  request: CritiqueRequest;
  /** Companion channels configured for this source workflow (empty in step 1). */
  availableChannels: readonly RefineChannel[];
  criteria?: string;
  maxRefineIterations: number;
  refineAcceptThreshold: number;
  onProgress?: (text: string) => void;
}): Promise<RefineLoopResult<RenderedImage>> {
  const availableActions = availableActionsFor(deps.availableChannels);
  let lastScore = 0;
  let round = 0;
  // Track the image most recently handed to the critic: at the moment the
  // reducer calls `render(action)`, this is exactly the render that action is
  // meant to repair, so it is what a companion channel feeds into its init role.
  let currentImage = deps.initialImage;

  return runRefineLoop<RenderedImage>({
    initialImage: deps.initialImage,
    critique: async (image) => {
      currentImage = image;
      const decision = await deps.refiner.critique(deps.agentCtx, {
        imagePath: image.savedPath,
        request: deps.request,
        availableActions,
        ...(deps.criteria !== undefined ? { criteria: deps.criteria } : {}),
      });
      if (decision !== null) lastScore = decision.score;
      return decision;
    },
    render: async (action) => {
      round += 1;
      deps.onProgress?.(`refining ${round}/${deps.maxRefineIterations}, score ${lastScore}`);
      return deps.renderAction(action, currentImage);
    },
    availableChannels: deps.availableChannels,
    maxRefineIterations: deps.maxRefineIterations,
    refineAcceptThreshold: deps.refineAcceptThreshold,
    savedPathOf: (image) => image.savedPath,
  });
}
