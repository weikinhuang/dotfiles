/**
 * The standalone `/comfyui refine <gX>` command body: refine an EXISTING
 * gallery render through the same critic loop the `autoRefine` flag uses.
 * It targets a recorded generation id only (so the recorded
 * workflow / prompt / seed are the request the critic judges against),
 * critiques the saved PNG, loops corrective re-renders, writes a NEW
 * gallery entry with lineage to the source, saves every render to disk,
 * and notifies the user. Being a slash command it returns NOTHING to the
 * model context.
 *
 * Lives under `ext/` because it drives the pi-coupled refiner wiring + the
 * session-scoped {@link ComfyuiRuntime}; the loop itself reuses the shared
 * {@link ./refine-loop.ts} engine.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { type Conn, readSavedImages } from '../../comfyui/client.ts';
import { resolveAuthHeaders, resolveBaseUrl } from '../../comfyui/config.ts';
import { findGeneration } from '../../comfyui/generations.ts';
import {
  type CritiqueRequest,
  type RefineAction,
  type RefineChannel,
  summarizeRefineJourney,
  toRefineJourney,
} from '../../comfyui/refine.ts';
import { envTruthy } from '../../parse-env.ts';
import { previewTransformFor } from './images.ts';
import type { ResolvedGenerateParams } from './layer-params.ts';
import { applyRefineAction, type RenderedImage, renderViaWorkflow, runRefinePass } from './refine-loop.ts';
import { readRefineGuidanceText, type RefinerAccess } from './refiner.ts';
import type { ComfyuiRuntime } from './runtime.ts';

// Build step 1 ships only the always-available channels; companions are
// later build steps, so none are offered yet (the engine downgrades any
// companion proposal to a t2i channel).
const REFINE_CHANNELS: readonly RefineChannel[] = [];

/**
 * Run a standalone refine over the recorded generation `id`. Notifies the
 * user with the outcome; never throws. Returns nothing (slash command).
 */
export async function runRefineCommand(
  rt: ComfyuiRuntime,
  refinerAccess: RefinerAccess,
  id: string,
  ctx: ExtensionContext,
): Promise<void> {
  const notify = (message: string, level: 'info' | 'warning' | 'error' = 'info'): void => {
    try {
      ctx.ui.notify(message, level);
    } catch {
      /* notify is best-effort */
    }
  };

  const config = rt.loadConfig(ctx.cwd);
  const rec = findGeneration(rt.generations, id);
  if (rec === undefined) {
    notify(`unknown generation "${id}" (see /comfyui gallery)`, 'warning');
    return;
  }
  const sourcePath = rec.savedPaths[0];
  if (sourcePath === undefined || !existsSync(sourcePath)) {
    notify(`generation "${id}" has no saved image on disk to refine`, 'warning');
    return;
  }
  const wf = config.workflows[rec.workflow];
  if (wf === undefined) {
    notify(`generation "${id}" used workflow "${rec.workflow}", which is no longer configured`, 'warning');
    return;
  }

  const refiner = refinerAccess.getRefiner(ctx);
  if (refiner === null || !refiner.isEnabled()) {
    notify('auto-refine is unavailable (the comfyui-critic agent is not installed or refine is disabled)', 'warning');
    return;
  }

  const initialBlocks = await readSavedImages([sourcePath]);
  const initialBlock = initialBlocks[0];
  if (initialBlock === undefined) {
    notify(`could not read the saved image for "${id}"`, 'warning');
    return;
  }

  const conn: Conn = {
    base: resolveBaseUrl(config),
    headers: resolveAuthHeaders(config),
    timeoutMs: config.timeoutMs,
  };
  const saveDir = isAbsolute(config.saveDir) ? config.saveDir : join(ctx.cwd, config.saveDir);
  const previewTransform = previewTransformFor(config.previewMaxDimension);

  // Re-render base: the recorded request the critic judges against. A
  // reroll drops the seed; a revise_prompt swaps prompt / negative.
  const baseParams: ResolvedGenerateParams = {
    prompt: rec.prompt,
    ...(rec.negative !== undefined ? { negative: rec.negative } : {}),
    ...(rec.seed !== undefined ? { seed: rec.seed } : {}),
    ...(rec.width !== undefined ? { width: rec.width } : {}),
    ...(rec.height !== undefined ? { height: rec.height } : {}),
  };

  const initialImage: RenderedImage = {
    block: initialBlock.block,
    savedPath: initialBlock.savedPath,
    ...(rec.seed !== undefined ? { seed: rec.seed } : {}),
    prompt: rec.prompt,
    ...(rec.negative !== undefined ? { negative: rec.negative } : {}),
    ...(rec.width !== undefined ? { width: rec.width } : {}),
    ...(rec.height !== undefined ? { height: rec.height } : {}),
  };

  const guidance = readRefineGuidanceText(config, wf, ctx.cwd);
  const request: CritiqueRequest = {
    prompt: rec.prompt,
    ...(rec.negative !== undefined ? { negative: rec.negative } : {}),
    ...(wf.promptProtocol !== undefined ? { promptProtocol: wf.promptProtocol } : {}),
    ...(guidance.length > 0 ? { guidance } : {}),
  };
  const criteria = wf.refineCriteria;
  const debug = envTruthy(process.env.PI_COMFYUI_REFINE_DEBUG);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs);
  notify(`refining ${id} via "${rec.workflow}"…`);
  try {
    const loop = await runRefinePass({
      refiner,
      agentCtx: { cwd: ctx.cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never, signal: ac.signal },
      initialImage,
      renderAction: (action: RefineAction) =>
        renderViaWorkflow({
          conn,
          wf,
          name: rec.workflow,
          cwd: ctx.cwd,
          params: applyRefineAction(baseParams, action),
          signal: ac.signal,
          report: () => {
            /* slash command: no streaming surface */
          },
          saveDir,
          previewTransform,
        }),
      request,
      availableChannels: REFINE_CHANNELS,
      ...(criteria !== undefined ? { criteria } : {}),
      maxRefineIterations: config.maxRefineIterations,
      refineAcceptThreshold: config.refineAcceptThreshold,
      ...(debug ? { onProgress: (text: string) => notify(`comfyui refine: ${text}`) } : {}),
    });

    const best = loop.image;
    const generation = rt.recordGeneration({
      workflow: rec.workflow,
      prompt: best.prompt,
      negative: best.negative,
      seed: best.seed,
      width: wf.inputs.width !== undefined ? best.width : undefined,
      height: wf.inputs.height !== undefined ? best.height : undefined,
      savedPaths: [best.savedPath],
      source: 'foreground',
      createdAt: Date.now(),
      refine: toRefineJourney(loop),
      refineOf: id,
    });
    const newId = generation ? ` [${generation.id}]` : '';
    notify(`Refined ${id}${newId}: ${summarizeRefineJourney(loop)}. Saved to ${saveDir}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = ac.signal.aborted ? `timed out after ${config.timeoutMs}ms` : message;
    notify(`refine failed: ${reason}`, 'error');
  } finally {
    clearTimeout(timer);
  }
}
