/**
 * The `generate_image` tool body for the comfyui extension. Lives under
 * `ext/` because it drives the {@link ComfyuiRuntime} session state, the
 * pi-coupled enhancer wiring, and builds multimodal tool results.
 *
 * {@link runPipeline} (enhancement -> graph build -> submit) is shared by
 * the foreground path (awaited) and the background path (run off-turn);
 * {@link executeGenerate} owns the per-call validation, the fore/background
 * branch, the render + save, and recording the landed generation.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { DEFAULT_TARGET_PIXELS, resolveAspect } from '../../comfyui/aspect.ts';
import {
  buildInjectedGraph,
  cancelPrompt,
  type Conn,
  createWaker,
  fetchAndSave,
  openProgressSocket,
  submitPrompt,
  waitForImages,
} from '../../comfyui/client.ts';
import { resolveAuthHeaders, resolveBaseUrl, resolveSendToModel } from '../../comfyui/config.ts';
import { buildEnhanceTask } from '../../comfyui/enhance.ts';
import { emitImageGenerated } from '../../comfyui/events.ts';
import { findGeneration, type GenerationRecord } from '../../comfyui/generations.ts';
import { addJob, findJob, updateJob } from '../../comfyui/jobs.ts';
import { summarizeRenderedImages } from '../../comfyui/summary.ts';
import { isRoleMap } from '../../comfyui/workflow.ts';
import { addCollapse } from '../../context-edit/directive.ts';
import { truncate } from '../../shared.ts';
import type { GenerateDetails } from './details.ts';
import { type EnhancerAccess, readGuidanceText } from './enhancer.ts';
import { previewTransformFor, resolveRoleImages, type RoleImageInput } from './images.ts';
import { CANCEL_TIMEOUT_MS } from './jobs.ts';
import { layerGenerationParams } from './layer-params.ts';
import type { GenerateParams } from './params.ts';
import type { ComfyuiRuntime } from './runtime.ts';

// The canonical `AgentToolResult` has no `isError`; pi's runtime reads it
// off the finalized result. The two tool bodies encode failures with it,
// so widen the result type to carry the optional flag (still assignable to
// `AgentToolResult<GenerateDetails>` at the registerTool call site).
export type GenerateToolResult = AgentToolResult<GenerateDetails> & { isError?: boolean };

export async function executeGenerate(
  rt: ComfyuiRuntime,
  enhancerAccess: EnhancerAccess,
  toolCallId: string,
  params: GenerateParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<GenerateDetails> | undefined,
  ctx: ExtensionContext,
): Promise<GenerateToolResult> {
  const config = rt.loadConfig(ctx.cwd);

  const fail = (
    message: string,
  ): { content: { type: 'text'; text: string }[]; details: GenerateDetails; isError: true } => ({
    content: [{ type: 'text', text: message }],
    details: { workflow: params.workflow ?? config.defaultWorkflow, savedPaths: [], error: message },
    isError: true,
  });

  // Resolve generation reuse before picking the workflow. `variationOf`
  // inherits a prior render's workflow + prompt + negative + seed + dims
  // as the baseline (per-call params still override); `refine` feeds a
  // prior render's saved image into an edit workflow as its input.
  if (params.variationOf !== undefined && params.refine !== undefined) {
    return fail('pass either variationOf or refine, not both');
  }
  let reuse: GenerationRecord | undefined;
  if (params.variationOf !== undefined) {
    reuse = findGeneration(rt.generations, params.variationOf);
    if (reuse === undefined) return fail(`unknown generation "${params.variationOf}" (see /comfyui gallery)`);
  }
  let refineImage: string | undefined;
  if (params.refine !== undefined) {
    const rec = findGeneration(rt.generations, params.refine);
    if (rec === undefined) return fail(`unknown generation "${params.refine}" (see /comfyui gallery)`);
    const src = rec.savedPaths[0];
    if (src === undefined || !existsSync(src)) {
      return fail(`generation "${params.refine}" has no saved image on disk to refine`);
    }
    if (params.inputImages !== undefined && params.inputImages.length > 0) {
      return fail('refine supplies the input image; do not also pass inputImages');
    }
    refineImage = src;
  }

  const name = params.workflow ?? reuse?.workflow ?? config.defaultWorkflow;
  const details: GenerateDetails = { workflow: name, savedPaths: [] };

  const wf = config.workflows[name];
  if (!wf) {
    const known = Object.keys(config.workflows).join(', ') || '(none)';
    details.error = `unknown workflow "${name}"`;
    return {
      content: [{ type: 'text', text: `${details.error}. Configured workflows: ${known}.` }],
      details,
      isError: true,
    };
  }

  // Image inputs are either positional (`inputImages`) or role-keyed
  // (`images`), set by the workflow; reject the wrong arg up front for
  // a clearer message than a downstream mapping error.
  const roleMap = isRoleMap(wf.images) ? wf.images : undefined;
  if (roleMap !== undefined && params.inputImages !== undefined && params.inputImages.length > 0) {
    return fail(`workflow "${name}" uses named image roles; pass "images" (role -> path/bbox), not "inputImages"`);
  }
  if (roleMap === undefined && params.images !== undefined && Object.keys(params.images).length > 0) {
    return fail(`workflow "${name}" does not use named image roles; pass "inputImages", not "images"`);
  }
  if (refineImage !== undefined && roleMap !== undefined && !('init' in roleMap)) {
    return fail(`workflow "${name}" has no "init" role to refine into`);
  }
  if (refineImage !== undefined && params.images?.init !== undefined) {
    return fail('refine supplies the init image; do not also pass images.init');
  }

  // Positive prompt comes from the call, else inherited from variationOf.
  const effectivePrompt = params.prompt ?? reuse?.prompt;
  if (effectivePrompt === undefined || effectivePrompt.trim().length === 0) {
    details.error = 'prompt is required (or pass variationOf to reuse a prior prompt)';
    return { content: [{ type: 'text', text: details.error }], details, isError: true };
  }

  const base = resolveBaseUrl(config);
  const headers = resolveAuthHeaders(config);
  const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };
  const saveDir = isAbsolute(config.saveDir) ? config.saveDir : join(ctx.cwd, config.saveDir);
  const requested = params.sendToModel ?? config.sendToModel;
  const background = params.background ?? config.background;
  // Ephemeral is meaningful only for a foreground render (a background
  // job returns no image to collapse); ignore it when backgrounding.
  const ephemeral = !background && (params.ephemeral ?? config.ephemeral);

  const d = config.defaults;

  // Aspect preset -> width/height. Only meaningful for a workflow that
  // maps both dimensions; erroring on the rest matches the
  // unmapped-arg contract (a clear failure beats a silent no-op). The
  // pixel budget follows the configured default area when set.
  let aspectDims: { width: number; height: number } | undefined;
  if (params.aspect) {
    if (wf.inputs.width === undefined || wf.inputs.height === undefined) {
      details.error = `workflow "${name}" does not support aspect (it maps no width/height)`;
      return { content: [{ type: 'text', text: details.error }], details, isError: true };
    }
    const targetPixels = d?.width !== undefined && d?.height !== undefined ? d.width * d.height : DEFAULT_TARGET_PIXELS;
    aspectDims = resolveAspect(params.aspect, targetPixels);
    if (!aspectDims) {
      details.error = `invalid aspect "${params.aspect}" (use e.g. "16:9", "portrait", "square")`;
      return { content: [{ type: 'text', text: details.error }], details, isError: true };
    }
  }

  // Stream a progress line; pi's onUpdate wants a full tool result, so
  // carry the (partial) details alongside the text. Stash the line on
  // details too so renderResult can show it while the result is partial
  // (the result renderer only sees details, not the content text).
  const report = (text: string): void => {
    details.progress = text;
    if (onUpdate) onUpdate({ content: [{ type: 'text', text }], details });
  };

  // The enhancement → graph-build → submit pipeline, shared by the
  // foreground (await it) and background (run it off-turn) paths. It
  // takes its own abort signal + progress reporter so the background
  // path can detach from the turn's lifetime, and returns the rendered
  // prompt / negative / seed / dims the caller needs to record the
  // result. `clientId` is generated by the caller so the foreground
  // path can also bind its progress websocket to the same id.
  type PipelineResult =
    | {
        ok: true;
        promptId: string;
        seed?: number;
        prompt: string;
        negative?: string;
        width?: number;
        height?: number;
        enhanceNote: string;
      }
    | { ok: false; error: string };

  const runPipeline = async (
    clientId: string,
    pipeSignal: AbortSignal,
    pipeReport: (text: string) => void,
  ): Promise<PipelineResult> => {
    // Opt-in prompt enhancement: refine the positive + baseline negative
    // into the workflow's native protocol via the `comfyui-enhance`
    // subagent before building the graph. Best-effort - a missing agent,
    // model-resolution failure, spawn error, or unparseable output keeps
    // the original prompt + baseline negative (the enhancer returns null).
    // The enhanced negative REPLACES the baseline (the agent is told to
    // build on it), matching the configured refine-replace merge.
    let promptForRender = effectivePrompt;
    const baselineNegative = params.negative ?? reuse?.negative ?? d?.negative;
    let enhancedNegative: string | undefined;
    const wantEnhance = params.enhance ?? wf.enhance ?? config.enhance;
    if (wantEnhance) {
      const enh = enhancerAccess.getEnhancer(ctx);
      if (enh?.isEnabled()) {
        pipeReport('enhancing prompt…');
        const task = buildEnhanceTask({
          prompt: effectivePrompt,
          ...(baselineNegative !== undefined ? { negative: baselineNegative } : {}),
          guidance: readGuidanceText(config, wf, ctx.cwd),
          ...(wf.description !== undefined ? { description: wf.description } : {}),
          ...(wf.tags !== undefined ? { tags: wf.tags } : {}),
          ...(wf.promptProtocol !== undefined ? { promptProtocol: wf.promptProtocol } : {}),
          ...((): { context?: string } => {
            const merged = rt.mergedSceneContext(params.context);
            return merged !== undefined ? { context: merged } : {};
          })(),
        });
        const enhanceResult = await enh.enhance(
          {
            cwd: ctx.cwd,
            model: ctx.model,
            modelRegistry: ctx.modelRegistry as never,
            signal: pipeSignal,
          },
          task,
        );
        if (enhanceResult) {
          promptForRender = enhanceResult.prompt;
          if (enhanceResult.negative !== undefined) enhancedNegative = enhanceResult.negative;
        }
      }
    }
    const enhancedPrompt = promptForRender !== effectivePrompt;

    // Layer the config `defaults` block (and any aspect-derived
    // dimensions) under the per-call params: `param ?? aspect ?? reuse ??
    // defaults`. The graph builder only injects params that are present,
    // so a default simply pre-fills the param before injection; the
    // workflow-baked graph value stays the final fallback. See
    // layer-params.ts for the precedence rules.
    const resolvedParams = layerGenerationParams({
      params,
      prompt: promptForRender,
      ...(enhancedNegative !== undefined ? { enhancedNegative } : {}),
      ...(baselineNegative !== undefined ? { baselineNegative } : {}),
      ...(reuse !== undefined ? { reuse } : {}),
      ...(aspectDims !== undefined ? { aspectDims } : {}),
      ...(d !== undefined ? { defaults: d } : {}),
      roleMode: roleMap !== undefined,
      ...(refineImage !== undefined ? { refineImage } : {}),
    });

    // Echo the enhanced prompt so the model knows what was actually
    // rendered (and can reuse it via variationOf). Capped to keep the
    // result line readable. Empty when enhancement was off or no-op'd.
    // Also flag a `context` arg that was supplied with enhancement off
    // (it is only consumed by the enhancer), so the model learns the
    // arg did nothing rather than silently dropping it.
    const enhanceNote =
      (enhancedPrompt ? `\nEnhanced prompt: ${truncate(resolvedParams.prompt, 240)}` : '') +
      (params.context !== undefined && !wantEnhance
        ? '\nNote: `context` was ignored (only used when enhance is on).'
        : '');

    // Role-keyed image inputs: resolve paths + synthesize bbox masks and
    // upload them (the mask raster needs `sharp`, so it lives here, not
    // in the pure graph builder). A `refine` id feeds the `init` role.
    let roleImages: Record<string, string> | undefined;
    if (roleMap !== undefined) {
      const sources: Record<string, RoleImageInput> = { ...params.images };
      if (refineImage !== undefined) sources.init = refineImage;
      if (Object.keys(sources).length > 0) {
        const resolvedRoles = await resolveRoleImages(
          conn,
          roleMap,
          sources,
          { width: resolvedParams.width, height: resolvedParams.height },
          homedir(),
          pipeReport,
          pipeSignal,
        );
        if (resolvedRoles.error !== undefined) return { ok: false, error: resolvedRoles.error };
        roleImages = resolvedRoles.uploadedByRole;
      }
    }

    const prep = await buildInjectedGraph(
      conn,
      wf,
      name,
      resolvedParams,
      ctx.cwd,
      homedir(),
      pipeReport,
      pipeSignal,
      roleImages,
    );
    if (prep.error || !prep.graph) {
      return { ok: false, error: prep.error ?? 'failed to prepare workflow' };
    }

    pipeReport('submitting to ComfyUI…');
    const promptId = await submitPrompt(conn, prep.graph, clientId, pipeSignal);
    return {
      ok: true,
      promptId,
      seed: prep.seed,
      prompt: resolvedParams.prompt,
      negative: resolvedParams.negative,
      width: resolvedParams.width,
      height: resolvedParams.height,
      enhanceNote,
    };
  };

  // Background: register the job and return immediately, then run the
  // enhancement + graph-build + submit pipeline off-turn so the turn is
  // never blocked on the enhancer LLM call, image uploads, or the submit
  // round-trip. The detached task owns its abort controller + timeout
  // (NOT the turn's signal, which is gone the instant we return) and
  // patches the real prompt id / seed / rendered prompt onto the job once
  // ComfyUI has queued it, or marks the job errored if prep/submit fails.
  if (background) {
    const baselineNegative = params.negative ?? reuse?.negative ?? d?.negative;
    const added = addJob(rt.registry, {
      promptId: '',
      workflow: name,
      prompt: effectivePrompt,
      negative: baselineNegative,
      saveDir,
      sendToModel: requested,
      startedAt: Date.now(),
    });
    rt.registry = added.registry;
    const jobId = added.created.id;
    rt.updateStatusline();
    details.background = true;
    details.jobId = jobId;
    // Spin the poll timer up now (idempotent); it skips jobs whose
    // deferred submit hasn't filled in a prompt id yet, so it simply
    // starts watching the moment the submit lands.
    const autoDownload = config.autoDownload;
    if (autoDownload) rt.ensurePollTimer(config.pollIntervalMs);

    void (async () => {
      const bgAc = new AbortController();
      const bgTimer = setTimeout(() => bgAc.abort(), conn.timeoutMs);
      try {
        const result = await runPipeline(randomUUID(), bgAc.signal, () => {
          /* off-turn: progress lines have nowhere to stream */
        });
        if (!result.ok) {
          rt.registry = updateJob(rt.registry, jobId, { status: 'error', error: result.error, endedAt: Date.now() });
          rt.updateStatusline();
          return;
        }
        // The model may have cancelled the job while it was still
        // submitting. Honor that by interrupting the prompt we just
        // queued instead of resurrecting a cancelled job.
        if (findJob(rt.registry, jobId)?.status !== 'running') {
          const cAc = new AbortController();
          const cTimer = setTimeout(() => cAc.abort(), CANCEL_TIMEOUT_MS);
          try {
            await cancelPrompt(conn, result.promptId, cAc.signal);
          } catch {
            /* best-effort: a cancelled job that already finished still lands on disk */
          } finally {
            clearTimeout(cTimer);
          }
          return;
        }
        rt.registry = updateJob(rt.registry, jobId, {
          promptId: result.promptId,
          seed: result.seed,
          prompt: result.prompt,
          negative: result.negative,
        });
        if (autoDownload) rt.ensurePollTimer(config.pollIntervalMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = bgAc.signal.aborted ? `timed out after ${conn.timeoutMs}ms` : message;
        rt.registry = updateJob(rt.registry, jobId, { status: 'error', error: reason, endedAt: Date.now() });
        rt.updateStatusline();
      } finally {
        clearTimeout(bgTimer);
      }
    })();

    const collectHint = autoDownload
      ? `It will auto-download to ${saveDir} when ready; collect it with the image_jobs tool (action collect, id ${jobId}) to view it inline.`
      : `Collect it later with the image_jobs tool (action collect, id ${jobId}).`;
    const text = `Started background generation [${jobId}] via "${name}". ${collectHint}`;
    return { content: [{ type: 'text', text }], details };
  }

  // Foreground: combine the turn's abort signal with the per-generation
  // timeout, then await the pipeline and the render.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  const runSignal = ac.signal;
  const clientId = randomUUID();

  let socket: WebSocket | null = null;
  try {
    const result = await runPipeline(clientId, runSignal, report);
    if (!result.ok) {
      details.error = result.error;
      return { content: [{ type: 'text', text: result.error }], details, isError: true };
    }
    const { promptId, seed, enhanceNote } = result;
    details.promptId = promptId;
    details.seed = seed;

    // The socket wakes the poll the instant the render finishes, so a
    // healthy websocket trims the up-to-1s poll-interval latency; the
    // poll stays the source of truth when the socket never connects.
    const waker = createWaker();
    socket = openProgressSocket(conn, clientId, promptId, onUpdate ? report : undefined, runSignal, waker);
    const refs = await waitForImages(conn, promptId, runSignal, waker);

    // Downscale the model-facing copy (token economy), but never an
    // ephemeral render: its block is collapsed out of model context,
    // so shrinking it only degrades the one-time TUI view for no gain.
    const previewTransform = ephemeral
      ? undefined
      : previewTransformFor(params.previewMaxDimension ?? config.previewMaxDimension);
    const saved = await fetchAndSave(conn, refs, saveDir, runSignal, previewTransform);
    for (const s of saved) details.savedPaths.push(s.savedPath);
    emitImageGenerated({
      savedPaths: details.savedPaths,
      workflow: name,
      prompt: result.prompt,
      seed: details.seed,
      background: false,
    });

    // Record the landed render in the generation registry so it gets a
    // reusable `g<n>` id (gallery + variationOf / refine). Only store
    // dims the workflow actually maps, so the record reflects what was
    // rendered rather than an ignored default.
    const generation = rt.recordGeneration({
      workflow: name,
      promptId,
      prompt: result.prompt,
      negative: result.negative,
      seed: details.seed,
      width: wf.inputs.width !== undefined ? result.width : undefined,
      height: wf.inputs.height !== undefined ? result.height : undefined,
      savedPaths: details.savedPaths,
      source: ephemeral ? 'ephemeral' : 'foreground',
      createdAt: Date.now(),
    });
    if (generation) details.generationId = generation.id;
    const idNote = generation ? ` [${generation.id}]` : '';

    // Ephemeral render: keep the image block in the result so the TUI
    // shows it this turn, but record a collapse directive so the
    // `context` hook strips the whole call+image from every outgoing
    // provider payload (this turn's continuation included). The image
    // never reaches the model, so the sendToModel / vision gate is
    // moot here - always attach the block for the terminal.
    if (ephemeral && toolCallId) {
      const r = addCollapse(rt.ephemeral, toolCallId, 'ephemeral image render', Date.now());
      if (r.ok) {
        rt.ephemeral = r.state;
        rt.persistEphemeral();
      }
      details.ephemeral = true;
      const summary = summarizeRenderedImages({
        verb: 'Generated',
        count: refs.length,
        idNote,
        workflow: name,
        seed,
        saveDir,
        decision: { send: true, visionBlocked: false },
        extra: ' (ephemeral: shown once, not kept in context)',
      });
      return { content: [{ type: 'text', text: summary }, ...saved.map((s) => s.block)], details };
    }

    const decision = resolveSendToModel(requested, ctx.model?.input);
    const summary = summarizeRenderedImages({
      verb: 'Generated',
      count: refs.length,
      idNote,
      workflow: name,
      seed,
      saveDir,
      decision,
      extra: enhanceNote,
    });
    return decision.send
      ? { content: [{ type: 'text', text: summary }, ...saved.map((s) => s.block)], details }
      : { content: [{ type: 'text', text: summary }], details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = runSignal.aborted && !(signal?.aborted ?? false) ? `timed out after ${conn.timeoutMs}ms` : message;
    details.error = reason;
    return { content: [{ type: 'text', text: `image generation failed: ${reason}` }], details, isError: true };
  } finally {
    clearTimeout(timer);
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  }
}
