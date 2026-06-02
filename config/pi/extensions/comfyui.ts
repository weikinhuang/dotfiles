/**
 * `comfyui` - a local/remote ComfyUI image-generation tool for pi.
 *
 * Registers a single `generate_image` tool the model can call. The tool
 * loads a named API-format workflow, injects the prompt / seed /
 * dimensions into the nodes named by the workflow's input map, submits
 * it to a ComfyUI server, streams generation progress, fetches the
 * rendered PNG(s), saves them to disk, and returns them inline as
 * multimodal tool results so both the terminal and vision-capable models
 * see the image.
 *
 * This is NOT a replacement for pi's built-in (provider-routed) image
 * generation - it is a custom tool, the same shape pi's own
 * `antigravity-image-gen.ts` example uses, because there is no
 * extension-pluggable image-provider hook.
 *
 * All pure logic (config layering + `${ENV}` interpolation, workflow
 * param injection, URL building, history / websocket parsing) lives under
 * `lib/node/pi/comfyui/` and is unit-tested; this shell is just the pi
 * glue: tool + command registration, the HTTP/websocket calls, and
 * result formatting.
 *
 * Config layers (lowest -> highest): shipped txt2img default ->
 * <piAgentDir>/comfyui.json -> <cwd>/.pi/comfyui.json.
 *
 * The extension auto-disables when neither config file contributes a `workflows`
 * entry. The shipped txt2img.api.json is an example, not a real default, so
 * without user workflows we deregister rather than leak a broken option into the
 * tool list.
 *
 * Environment:
 *   PI_COMFYUI_DISABLED=1   skip the extension entirely
 *   PI_COMFYUI_URL=...      override the configured baseUrl
 *   PI_COMFYUI_TOKEN=...    referenced by a config authHeader as ${PI_COMFYUI_TOKEN}
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { COMFYUI_USAGE } from '../../../lib/node/pi/comfyui/usage.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import {
  loadComfyuiConfig,
  loadUserWorkflowNames,
  resolveAuthHeaders,
  resolveBaseUrl,
  resolveSendToModel,
  SHIPPED_WORKFLOW_INPUTS,
} from '../../../lib/node/pi/comfyui/config.ts';
import { extractOutputImages, historyHasError } from '../../../lib/node/pi/comfyui/api.ts';
import {
  buildInjectedGraph,
  cancelPrompt,
  type Conn,
  fetchAndSave,
  fetchHistory,
  openProgressSocket,
  pingServer,
  submitPrompt,
  waitForImages,
} from '../../../lib/node/pi/comfyui/client.ts';
import { loadWorkflowGraph, validateMapping } from '../../../lib/node/pi/comfyui/workflow.ts';
import {
  addJob,
  findJob,
  formatJobLine,
  formatRegistry,
  formatRunningBlock,
  type ImageJob,
  type JobRegistry,
  emptyRegistry,
  runningJobs,
  updateJob,
} from '../../../lib/node/pi/comfyui/jobs.ts';
import type { ComfyuiConfig, WorkflowConfig } from '../../../lib/node/pi/comfyui/types.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

interface GenerateDetails {
  workflow: string;
  seed?: number;
  promptId?: string;
  savedPaths: string[];
  error?: string;
  /** Latest streamed progress line (e.g. "generating 12/30"), shown while the result is partial. */
  progress?: string;
  /** True when the call only submitted the job and returned without waiting. */
  background?: boolean;
  /** Registry id of the background job this call started (when `background`). */
  jobId?: string;
}

/** Action verbs accepted by the `image_jobs` tool. */
type JobsAction = 'list' | 'collect' | 'cancel';

interface JobsDetails {
  action: JobsAction;
  jobId?: string;
  status?: ImageJob['status'];
  savedPaths?: string[];
  error?: string;
  jobs?: ImageJob[];
}

// ──────────────────────────────────────────────────────────────────────
// Shipped default workflow (committed at config/pi/comfyui/txt2img.api.json)
// ──────────────────────────────────────────────────────────────────────

const extDir = dirname(fileURLToPath(import.meta.url));

// Only the on-disk path of the shipped example workflow is shell-specific;
// its input map is pure data (SHIPPED_WORKFLOW_INPUTS in lib).
function shippedWorkflow(): WorkflowConfig {
  return { file: join(extDir, '..', 'comfyui', 'txt2img.api.json'), inputs: SHIPPED_WORKFLOW_INPUTS };
}

function loadConfig(cwd: string): ComfyuiConfig {
  return loadComfyuiConfig(cwd, shippedWorkflow());
}

// ──────────────────────────────────────────────────────────────────────
// Tool parameters
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function comfyuiExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_COMFYUI_DISABLED)) return;

  // Registration-time seed only. Registration runs before any session
  // exists, so there is no `ctx` to read `ctx.cwd` from yet - the real
  // session cwd arrives on `session_start` below, where we re-point this.
  // It is used here for two things that can only be decided at
  // registration: the auto-disable gate, and the workflow list baked
  // into the (immutable) tool description. Tool handlers and the command
  // completions re-resolve from `ctx.cwd` / the updated `cwd` instead.
  let cwd = process.cwd();

  // Auto-disable when no user-supplied workflows exist. The shipped txt2img
  // graph (config/pi/comfyui/txt2img.api.json) is an example - it expects a
  // v1-5-pruned-emaonly checkpoint that most servers won't have - so registering
  // the tool with only that available would leak a broken option into the model's
  // tool list. The user has to point at their own workflow in
  // ~/.pi/agent/comfyui.json or <cwd>/.pi/comfyui.json to opt in.
  //
  // This gate is necessarily registration-time: pi has no unregisterTool API,
  // so we cannot register first and back out on `session_start`. It is keyed
  // off the user-global config (cwd-independent) and the project config under
  // the registration-time cwd. A project whose only workflows live under a
  // later `ctx.cwd` that differs from the launch dir would miss this gate, but
  // its handlers still work once that project's config loads at call time.
  if (loadUserWorkflowNames(cwd).length === 0) return;

  const registrationConfig = loadConfig(cwd);
  const workflowNames = Object.keys(registrationConfig.workflows);
  const defaultWorkflow = registrationConfig.defaultWorkflow;
  const workflowList = workflowNames.join(', ') || '(none)';

  // Background-job registry. In-memory and per-session: ComfyUI owns the
  // actual execution and persists each prompt under its id, so a job is
  // just metadata here. Not persisted to the session branch (unlike
  // bg-bash) - reattaching to a prior runtime's promptId is best handled
  // by re-submitting, and the server's own history outlives us anyway.
  let registry: JobRegistry = emptyRegistry();

  // Statusline slot (see statusline.ts): show a count of pending jobs and
  // clear the slot when none are running so quiet sessions stay clean.
  let uiRef: ExtensionContext['ui'] | undefined;
  let lastStatusRunning = -1;
  const updateStatusline = (): void => {
    if (!uiRef) return;
    const running = runningJobs(registry).length;
    if (running === lastStatusRunning) return;
    lastStatusRunning = running;
    uiRef.setStatus('comfyui', running > 0 ? `▦ img:${running}` : undefined);
  };

  pi.on('session_start', (_event, ctx) => {
    // Re-point cwd from the registration-time `process.cwd()` seed to the
    // real session cwd. The `/comfyui workflows` completion resolver
    // closes over `cwd` (completions get no `ctx`), so this keeps it
    // pointed at the session's project config after a `/reload`.
    cwd = ctx.cwd;
    uiRef = ctx.ui;
    lastStatusRunning = -1;
    updateStatusline();
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // Clear the statusline badge and drop the in-memory job registry so
    // a /reload doesn't leave a stale `▦ img:N` count claiming the slot
    // or surface a prior session's background jobs. ComfyUI owns the
    // actual executions server-side, so dropping our metadata is safe;
    // the user re-collects via the server's own history if needed.
    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus('comfyui', undefined);
      } catch {
        // best-effort: shutdown must never throw.
      }
    }
    registry = emptyRegistry();
    uiRef = undefined;
    lastStatusRunning = -1;
  });

  // Remind the model about pending background jobs each turn so even a
  // weak model remembers to collect them.
  pi.on('before_agent_start', (event, ctx) => {
    uiRef = ctx.ui;
    updateStatusline();
    const block = formatRunningBlock(registry);
    if (!block) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  const GenerateParams = Type.Object({
    prompt: Type.String({ description: 'Positive prompt: what to depict.' }),
    negative: Type.Optional(Type.String({ description: 'Negative prompt: what to avoid.' })),
    workflow: Type.Optional(
      Type.String({ description: `One of: ${workflowList}. Default ${defaultWorkflow}. Do not invent names.` }),
    ),
    width: Type.Optional(Type.Number({ description: 'Output width (px).' })),
    height: Type.Optional(Type.Number({ description: 'Output height (px).' })),
    steps: Type.Optional(Type.Number({ description: 'Sampler steps.' })),
    cfg: Type.Optional(Type.Number({ description: 'CFG / guidance scale.' })),
    seed: Type.Optional(Type.Number({ description: 'Omit for a random seed; reuse a prior seed to reproduce.' })),
    denoise: Type.Optional(Type.Number({ description: 'Denoise strength 0-1 (img2img).' })),
    inputImage: Type.Optional(Type.String({ description: 'Input image path (img2img workflows only).' })),
    count: Type.Optional(Type.Number({ description: 'Batch size.' })),
    sendToModel: Type.Optional(
      Type.Boolean({
        description:
          'Return the image to you for analysis (default true). false = save to disk only, out of context. Auto-suppressed for non-vision models.',
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          'Return immediately without waiting; collect later via `image_jobs` (collect). Use for slow renders. Default false.',
      }),
    ),
  });

  pi.registerTool({
    name: 'generate_image',
    label: 'Generate image',
    description:
      `Generate an image from a prompt via a ComfyUI server and return it inline. ` +
      `Use when the user asks to create, draw, render, or generate a picture. ` +
      `Workflows: ${workflowList} (default ${defaultWorkflow}); each bakes in its own checkpoint, sampler, and scheduler. ` +
      `The PNG is saved to disk and returned so you can see it.`,
    promptSnippet: `To create or render an image, call \`generate_image\` (workflows: ${workflowList}) instead of describing it in text.`,
    promptGuidelines: [
      "Never call ComfyUI's HTTP API (`/object_info`, `/prompt`, `/view`, …) via bash/curl/anything - `generate_image` is the only entry point; it encapsulates model and sampler choice.",
      'Only pass `inputImage` for img2img workflows.',
    ],
    parameters: GenerateParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const name = params.workflow ?? config.defaultWorkflow;
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

      const base = resolveBaseUrl(config);
      const headers = resolveAuthHeaders(config);
      const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };
      const saveDir = isAbsolute(config.saveDir) ? config.saveDir : join(ctx.cwd, config.saveDir);
      const requested = params.sendToModel ?? config.sendToModel;

      // Stream a progress line; pi's onUpdate wants a full tool result, so
      // carry the (partial) details alongside the text. Stash the line on
      // details too so renderResult can show it while the result is partial
      // (the result renderer only sees details, not the content text).
      const report = (text: string): void => {
        details.progress = text;
        if (onUpdate) onUpdate({ content: [{ type: 'text', text }], details });
      };

      // Combine the turn's abort signal with the per-generation timeout.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
      if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
      const runSignal = ac.signal;

      // Layer the config `defaults` block under the per-call params:
      // `param ?? config.defaults?.X`. The graph builder only injects
      // params that are present, so a default simply pre-fills the param
      // before injection; the workflow-baked graph value stays the final
      // fallback for anything neither the call nor the defaults set.
      const d = config.defaults;
      const resolvedParams = {
        ...params,
        negative: params.negative ?? d?.negative,
        width: params.width ?? d?.width,
        height: params.height ?? d?.height,
        steps: params.steps ?? d?.steps,
        cfg: params.cfg ?? d?.cfg,
        denoise: params.denoise ?? d?.denoise,
        count: params.count ?? d?.count,
      };

      let socket: WebSocket | null = null;
      try {
        const prep = await buildInjectedGraph(conn, wf, name, resolvedParams, ctx.cwd, homedir(), report, runSignal);
        if (prep.error || !prep.graph) {
          details.error = prep.error;
          return {
            content: [{ type: 'text', text: prep.error ?? 'failed to prepare workflow' }],
            details,
            isError: true,
          };
        }
        const seed = prep.seed;
        details.seed = seed;

        const clientId = randomUUID();
        report('submitting to ComfyUI…');
        const promptId = await submitPrompt(conn, prep.graph, clientId, runSignal);
        details.promptId = promptId;
        const seedNote = seed !== undefined ? ` (seed ${seed})` : '';

        // Background: register the job and return without waiting. ComfyUI
        // keeps running it server-side; the model collects it later via
        // `image_jobs`.
        if (params.background) {
          const added = addJob(registry, {
            promptId,
            workflow: name,
            seed,
            prompt: params.prompt,
            negative: resolvedParams.negative,
            saveDir,
            sendToModel: requested,
            startedAt: Date.now(),
          });
          registry = added.registry;
          updateStatusline();
          details.background = true;
          details.jobId = added.created.id;
          const text =
            `Started background generation [${added.created.id}] via "${name}"${seedNote}. ` +
            `Collect it later with the image_jobs tool (action collect, id ${added.created.id}).`;
          return { content: [{ type: 'text', text }], details };
        }

        socket = openProgressSocket(conn, clientId, promptId, onUpdate ? report : undefined, runSignal);
        const refs = await waitForImages(conn, promptId, runSignal);

        const saved = await fetchAndSave(conn, refs, saveDir, runSignal);
        for (const s of saved) details.savedPaths.push(s.savedPath);

        const decision = resolveSendToModel(requested, ctx.model?.input);
        const countNote = `${refs.length} image${refs.length === 1 ? '' : 's'}`;
        if (!decision.send) {
          const why = decision.visionBlocked
            ? ' (active model has no image input; not sent to model)'
            : ' (image not sent to model)';
          const summary = `Generated ${countNote} via "${name}"${seedNote}. Saved to ${saveDir}.${why}`;
          return { content: [{ type: 'text', text: summary }], details };
        }
        const summary = `Generated ${countNote} via "${name}"${seedNote}. Saved to ${saveDir}.`;
        return { content: [{ type: 'text', text: summary }, ...saved.map((s) => s.block)], details };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason =
          runSignal.aborted && !(signal?.aborted ?? false) ? `timed out after ${conn.timeoutMs}ms` : message;
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
    },

    renderCall(args, theme, _context) {
      const prompt = ((args as { prompt?: string }).prompt ?? '').replace(/\s+/g, ' ').trim();
      const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
      const head = theme.fg('toolTitle', theme.bold('generate_image '));
      return new Text(`${head}${theme.fg('dim', preview)}`, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const details = (result.details ?? {}) as Partial<GenerateDetails>;
      if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);

      const n = details.savedPaths?.length ?? 0;
      const seedNote = details.seed !== undefined ? ` · seed ${details.seed}` : '';

      // Background submission: no image yet, just the job handle.
      if (details.background) {
        const head = theme.fg('accent', `▶ background [${details.jobId ?? '?'}]`);
        return new Text(`${head}${theme.fg('dim', seedNote)}`, 0, 0);
      }

      // Still running: surface the live progress line (e.g. "generating 12/30")
      // streamed over the websocket, or a neutral "working…" if none yet.
      if ((options.isPartial || context.isPartial) && n === 0) {
        const prog = details.progress ?? 'working…';
        return new Text(theme.fg('dim', `⟳ ${prog}${seedNote}`), 0, 0);
      }

      const summary = theme.fg('success', `✓ ${n} image${n === 1 ? '' : 's'}${seedNote}`);
      if (!options.expanded) return new Text(summary, 0, 0);

      // Expanded (ctrl+o): show the full positive / negative prompt and paths.
      const args = (context.args ?? {}) as { prompt?: string; negative?: string };
      const label = (text: string): string => theme.fg('dim', text);
      const lines = [summary];
      if (args.prompt) lines.push(`${label('prompt:   ')}${args.prompt}`);
      lines.push(`${label('negative: ')}${args.negative ?? '(workflow default)'}`);
      for (const p of details.savedPaths ?? []) lines.push(`${label('saved:    ')}${p}`);
      return new Text(lines.join('\n'), 0, 0);
    },
  });

  // ── image_jobs: manage background generations ──────────────────────

  type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
  interface JobsReturn {
    content: ToolContent[];
    details: JobsDetails;
    isError?: boolean;
  }

  const jobsError = (action: JobsAction, message: string): JobsReturn => ({
    content: [{ type: 'text', text: message }],
    details: { action, error: message },
    isError: true,
  });

  const actListJobs = (): JobsReturn => ({
    content: [{ type: 'text', text: formatRegistry(registry, Date.now()) }],
    details: { action: 'list', jobs: registry.jobs },
  });

  const actCollect = async (
    id: string | undefined,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<JobsReturn> => {
    if (!id) return jobsError('collect', 'collect requires `id`');
    const job = findJob(registry, id);
    if (!job) return jobsError('collect', `job [${id}] not found`);

    if (job.status === 'cancelled') {
      return {
        content: [{ type: 'text', text: `[${id}] was cancelled.` }],
        details: { action: 'collect', jobId: id, status: 'cancelled' },
      };
    }
    if (job.status === 'error') {
      return jobsError('collect', `[${id}] failed: ${job.error ?? 'unknown error'}`);
    }
    if (job.status === 'done') {
      return {
        content: [
          { type: 'text', text: `[${id}] already collected: ${job.savedPaths.length} image(s) in ${job.saveDir}.` },
        ],
        details: { action: 'collect', jobId: id, status: 'done', savedPaths: job.savedPaths },
      };
    }

    // Still running: poll `/history` once. If outputs are ready, fetch +
    // save and hand them back; otherwise report and let the model re-poll.
    const config = loadConfig(ctx.cwd);
    const conn: Conn = {
      base: resolveBaseUrl(config),
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const history = await fetchHistory(conn, job.promptId, ac.signal);
      const refs = extractOutputImages(history, job.promptId);
      if (refs.length === 0) {
        if (historyHasError(history, job.promptId)) {
          const reason = 'ComfyUI reported an execution error (see server log)';
          registry = updateJob(registry, id, { status: 'error', error: reason, endedAt: Date.now() });
          updateStatusline();
          return jobsError('collect', `[${id}] failed: ${reason}`);
        }
        return {
          content: [{ type: 'text', text: `[${id}] still running (no output yet). Call collect again shortly.` }],
          details: { action: 'collect', jobId: id, status: 'running' },
        };
      }

      const saved = await fetchAndSave(conn, refs, job.saveDir, ac.signal);
      const savedPaths = saved.map((s) => s.savedPath);
      registry = updateJob(registry, id, { status: 'done', savedPaths, endedAt: Date.now() });
      updateStatusline();

      const decision = resolveSendToModel(job.sendToModel, ctx.model?.input);
      const seedNote = job.seed !== undefined ? ` (seed ${job.seed})` : '';
      const countNote = `${refs.length} image${refs.length === 1 ? '' : 's'}`;
      const details: JobsDetails = { action: 'collect', jobId: id, status: 'done', savedPaths };
      if (!decision.send) {
        const why = decision.visionBlocked
          ? ' (active model has no image input; not sent to model)'
          : ' (image not sent to model)';
        const text = `Collected ${countNote} from [${id}] via "${job.workflow}"${seedNote}. Saved to ${job.saveDir}.${why}`;
        return { content: [{ type: 'text', text }], details };
      }
      const text = `Collected ${countNote} from [${id}] via "${job.workflow}"${seedNote}. Saved to ${job.saveDir}.`;
      return { content: [{ type: 'text', text }, ...saved.map((s) => s.block)], details };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = ac.signal.aborted && !(signal?.aborted ?? false) ? `timed out after ${conn.timeoutMs}ms` : message;
      return jobsError('collect', `collect failed for [${id}]: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const actCancel = async (
    id: string | undefined,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<JobsReturn> => {
    if (!id) return jobsError('cancel', 'cancel requires `id`');
    const job = findJob(registry, id);
    if (!job) return jobsError('cancel', `job [${id}] not found`);
    if (job.status !== 'running') return jobsError('cancel', `[${id}] is not running (status: ${job.status})`);

    const config = loadConfig(ctx.cwd);
    const conn: Conn = {
      base: resolveBaseUrl(config),
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      await cancelPrompt(conn, job.promptId, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    registry = updateJob(registry, id, { status: 'cancelled', endedAt: Date.now() });
    updateStatusline();
    return {
      content: [
        {
          type: 'text',
          text: `Cancelled [${id}] (best-effort: a job already executing on the server may still finish).`,
        },
      ],
      details: { action: 'cancel', jobId: id, status: 'cancelled' },
    };
  };

  const ImageJobsParams = Type.Object({
    action: StringEnum(['list', 'collect', 'cancel'] as const, {
      description:
        'list (all background jobs), collect (poll a job; returns images once ready, "still running" otherwise - safe to repeat), cancel (drop a still-queued job).',
    }),
    id: Type.Optional(Type.String({ description: 'Job id (required for collect / cancel).' })),
  });

  pi.registerTool({
    name: 'image_jobs',
    label: 'Image jobs',
    description:
      'Manage background image generations (those started by generate_image with background=true). ' +
      'Actions: list, collect (poll, returning the image(s) once ready), cancel.',
    promptSnippet:
      'After a background generate_image (background=true), use image_jobs collect with the returned id to retrieve the image once ready.',
    parameters: ImageJobsParams,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as unknown as { action: JobsAction; id?: string };
      switch (params.action) {
        case 'list':
          return actListJobs();
        case 'collect':
          return await actCollect(params.id, ctx, signal);
        case 'cancel':
          return await actCancel(params.id, ctx, signal);
      }
    },

    renderCall(args, theme, _context) {
      const action = (args as { action?: string }).action ?? '';
      const id = (args as { id?: string }).id;
      let text = theme.fg('toolTitle', theme.bold('image_jobs ')) + theme.fg('muted', action);
      if (id) text += ` ${theme.fg('accent', `[${id}]`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = (result.details ?? {}) as Partial<JobsDetails>;
      if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);

      if (details.action === 'list') {
        const jobs = details.jobs ?? [];
        if (jobs.length === 0) return new Text(theme.fg('dim', '(no background image jobs)'), 0, 0);
        const now = Date.now();
        return new Text(jobs.map((j) => theme.fg('text', formatJobLine(j, now))).join('\n'), 0, 0);
      }

      const id = details.jobId ?? '?';
      switch (details.status) {
        case 'running':
          return new Text(theme.fg('dim', `⟳ [${id}] still running`), 0, 0);
        case 'cancelled':
          return new Text(theme.fg('muted', `◌ [${id}] cancelled`), 0, 0);
        case 'done': {
          const n = details.savedPaths?.length ?? 0;
          return new Text(theme.fg('success', `✓ [${id}] ${n} image${n === 1 ? '' : 's'}`), 0, 0);
        }
        default:
          return new Text(theme.fg('dim', `[${id}]`), 0, 0);
      }
    },
  });

  pi.registerCommand('comfyui', {
    description: 'Inspect ComfyUI status, workflows, and background jobs',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        workflows: {
          description: 'Validate configured workflows',
          // Re-read config so a `/reload`-free config edit still completes.
          args: () => Object.keys(loadConfig(cwd).workflows).map((label) => ({ label })),
        },
        jobs: {
          description: 'List background generations',
          args: () => registry.jobs.map((j) => ({ label: j.id, description: j.status })),
        },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(COMFYUI_USAGE, 'info');
        return;
      }
      const config = loadConfig(ctx.cwd);
      const base = resolveBaseUrl(config);
      const headers = resolveAuthHeaders(config);
      const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };
      const sub = args.trim().toLowerCase();

      if (sub === 'jobs') {
        ctx.ui.notify(formatRegistry(registry, Date.now()), 'info');
        return;
      }

      if (sub === 'workflows') {
        const lines: string[] = [];
        for (const [name, wf] of Object.entries(config.workflows)) {
          const loaded = loadWorkflowGraph(wf.file, ctx.cwd, homedir());
          if (loaded.error || !loaded.graph) {
            lines.push(`✗ ${name}: ${loaded.error ?? 'load failed'}`);
            continue;
          }
          const errors = validateMapping(loaded.graph, wf.inputs);
          const inputs = Object.keys(wf.inputs).join(', ') || '(none)';
          lines.push(errors.length > 0 ? `✗ ${name}: ${errors.join('; ')}` : `✓ ${name}: ${inputs}`);
        }
        ctx.ui.notify(lines.join('\n') || 'no workflows configured', 'info');
        return;
      }

      const reachable = await pingServer(conn);
      const names = Object.keys(config.workflows).join(', ') || '(none)';
      ctx.ui.notify(
        [
          `comfyui: ${base} ${reachable ? '(reachable)' : '(unreachable)'}`,
          `auth: ${config.authHeader ? `on (${config.authHeader.name})` : 'off'}`,
          `default workflow: ${config.defaultWorkflow}`,
          `workflows: ${names}`,
          `saveDir: ${config.saveDir}`,
        ].join('\n'),
        reachable ? 'info' : 'warning',
      );
    },
  });
}
