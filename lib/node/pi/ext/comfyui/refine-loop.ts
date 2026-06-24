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
import {
  type CritiqueRequest,
  type RefineAction,
  type RefineChannel,
  type Refiner,
  type RefineContext,
  type RefineLoopResult,
  runRefineLoop,
} from '../../comfyui/refine.ts';
import type { WorkflowConfig } from '../../comfyui/types.ts';
import type { ResolvedGenerateParams } from './layer-params.ts';

/** Channels that need no companion workflow - always runnable (build step 1). */
const ALWAYS_AVAILABLE_CHANNELS: readonly RefineChannel[] = ['reroll', 'revise_prompt'];

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
  params: ResolvedGenerateParams;
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
  // Companion channels (img2img / inpaint / detailer / ground) are later
  // build-order steps; until they ship they are never in `availableChannels`,
  // so the engine downgrades them to reroll / revise_prompt and they never
  // reach this primitive.
  return next;
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
  renderAction: (action: RefineAction) => Promise<RenderedImage>;
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

  return runRefineLoop<RenderedImage>({
    initialImage: deps.initialImage,
    critique: async (image) => {
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
      return deps.renderAction(action);
    },
    availableChannels: deps.availableChannels,
    maxRefineIterations: deps.maxRefineIterations,
    refineAcceptThreshold: deps.refineAcceptThreshold,
    savedPathOf: (image) => image.savedPath,
  });
}
