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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { atomicWriteFile } from '../../../lib/node/pi/atomic-write.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { piAgentPath, piProjectPath } from '../../../lib/node/pi/pi-paths.ts';
import {
  coerceConfigLayer,
  mergeConfigLayers,
  resolveAuthHeaders,
  resolveBaseUrl,
  resolveSendToModel,
} from '../../../lib/node/pi/comfyui/config.ts';
import {
  buildHistoryUrl,
  buildQueueUrl,
  buildViewUrl,
  extractOutputImages,
  isExecutionComplete,
  joinUrl,
  parseWsMessage,
  toWsUrl,
} from '../../../lib/node/pi/comfyui/api.ts';
import { injectInputs, isComfyWorkflow, randomSeed, validateMapping } from '../../../lib/node/pi/comfyui/workflow.ts';
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
import type { ComfyuiConfig, ComfyWorkflow, ImageRef, WorkflowConfig } from '../../../lib/node/pi/comfyui/types.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

interface Conn {
  base: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

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

/** One fetched output: the on-disk path plus the inline image block. */
interface SavedImage {
  savedPath: string;
  block: { type: 'image'; data: string; mimeType: string };
}

/** Subset of `generate_image` params the prepare/submit helpers read. */
interface GenParams {
  prompt: string;
  negative?: string;
  workflow?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  denoise?: number;
  inputImage?: string;
  count?: number;
  sendToModel?: boolean;
  background?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Shipped default workflow (committed at config/pi/comfyui/txt2img.api.json)
// ──────────────────────────────────────────────────────────────────────

const extDir = dirname(fileURLToPath(import.meta.url));

function shippedWorkflow(): WorkflowConfig {
  return {
    file: join(extDir, '..', 'comfyui', 'txt2img.api.json'),
    inputs: {
      prompt: { node: '6', key: 'text' },
      negative: { node: '7', key: 'text' },
      seed: { node: '3', key: 'seed' },
      steps: { node: '3', key: 'steps' },
      cfg: { node: '3', key: 'cfg' },
      denoise: { node: '3', key: 'denoise' },
      width: { node: '5', key: 'width' },
      height: { node: '5', key: 'height' },
      batch: { node: '5', key: 'batch_size' },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Pure-ish helpers
// ──────────────────────────────────────────────────────────────────────

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function loadConfig(cwd: string): ComfyuiConfig {
  const base = { workflows: { txt2img: shippedWorkflow() } };
  const userLayer = coerceConfigLayer(readJson(piAgentPath('comfyui.json')));
  const projectLayer = coerceConfigLayer(readJson(piProjectPath(cwd, 'comfyui.json')));
  return mergeConfigLayers(base, userLayer, projectLayer);
}

function loadWorkflowGraph(file: string): { graph?: ComfyWorkflow; error?: string } {
  const resolved = expandHome(file);
  if (!existsSync(resolved)) return { error: `workflow file not found: ${resolved}` };
  const parsed = readJson(resolved);
  if (!isComfyWorkflow(parsed)) return { error: `workflow file is not a valid API-format graph: ${resolved}` };
  return { graph: parsed };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

// ──────────────────────────────────────────────────────────────────────
// ComfyUI HTTP / websocket
// ──────────────────────────────────────────────────────────────────────

async function submitPrompt(conn: Conn, graph: ComfyWorkflow, clientId: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(joinUrl(conn.base, '/prompt'), {
    method: 'POST',
    headers: { ...conn.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ComfyUI rejected the workflow (HTTP ${res.status}): ${text.slice(0, 800)}`);
  }
  const json = (await res.json()) as { prompt_id?: string };
  if (typeof json.prompt_id !== 'string') throw new Error('ComfyUI did not return a prompt_id');
  return json.prompt_id;
}

async function uploadImage(conn: Conn, filePath: string, signal: AbortSignal): Promise<string> {
  const resolved = expandHome(filePath);
  if (!existsSync(resolved)) throw new Error(`input image not found: ${resolved}`);
  const bytes = readFileSync(resolved);
  const form = new FormData();
  form.append('image', new Blob([bytes]), basename(resolved));
  form.append('overwrite', 'true');
  const res = await fetch(joinUrl(conn.base, '/upload/image'), {
    method: 'POST',
    headers: conn.headers,
    body: form,
    signal,
  });
  if (!res.ok) throw new Error(`image upload failed (HTTP ${res.status})`);
  const json = (await res.json()) as { name?: string; subfolder?: string };
  if (typeof json.name !== 'string') throw new Error('ComfyUI did not return an uploaded image name');
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

async function fetchHistory(conn: Conn, promptId: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(buildHistoryUrl(conn.base, promptId), { headers: conn.headers, signal });
  if (!res.ok) return null;
  return res.json();
}

async function fetchImageBytes(conn: Conn, ref: ImageRef, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(buildViewUrl(conn.base, ref), { headers: conn.headers, signal });
  if (!res.ok) throw new Error(`failed to fetch ${ref.filename} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** True when ComfyUI's `/history` entry for `promptId` reports an execution error. */
function historyHasError(history: unknown, promptId: string): boolean {
  const entry = history && typeof history === 'object' ? (history as Record<string, unknown>)[promptId] : undefined;
  const status =
    entry && typeof entry === 'object' ? (entry as { status?: { status_str?: string } }).status : undefined;
  return status?.status_str === 'error';
}

/** Fetch every output image, write each to `saveDir`, and return path + inline block. */
async function fetchAndSave(conn: Conn, refs: ImageRef[], saveDir: string, signal: AbortSignal): Promise<SavedImage[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return Promise.all(
    refs.map(async (ref, i) => {
      const bytes = await fetchImageBytes(conn, ref, signal);
      const savedPath = join(saveDir, `comfyui-${stamp}-${i}-${ref.filename}`);
      atomicWriteFile(savedPath, bytes);
      return {
        savedPath,
        block: { type: 'image' as const, data: bytes.toString('base64'), mimeType: mimeFromName(ref.filename) },
      };
    }),
  );
}

/**
 * Load the named workflow graph, upload any img2img input, compute the
 * seed, and inject every mapped param. Returns the ready-to-submit graph
 * plus the resolved seed, or a human-readable `error` for a bad workflow
 * file / mapping. `uploadImage` failures throw and are caught upstream.
 */
async function buildInjectedGraph(
  conn: Conn,
  wf: WorkflowConfig,
  name: string,
  params: GenParams,
  report: (text: string) => void,
  signal: AbortSignal,
): Promise<{ graph?: ComfyWorkflow; seed?: number; error?: string }> {
  const loaded = loadWorkflowGraph(wf.file);
  if (loaded.error || !loaded.graph) return { error: loaded.error ?? 'failed to load workflow' };

  let uploadedName: string | undefined;
  if (params.inputImage !== undefined) {
    if (wf.inputs.image === undefined) return { error: `workflow "${name}" does not accept an input image` };
    report('uploading input image…');
    uploadedName = await uploadImage(conn, params.inputImage, signal);
  }

  const autoSeed = params.seed === undefined && wf.inputs.seed !== undefined ? randomSeed() : undefined;
  const seed = params.seed ?? autoSeed;

  const injected = injectInputs(loaded.graph, wf.inputs, {
    prompt: params.prompt,
    negative: params.negative,
    seed,
    steps: params.steps,
    cfg: params.cfg,
    denoise: params.denoise,
    width: params.width,
    height: params.height,
    batch: params.count,
    image: uploadedName,
  });
  if (injected.errors.length > 0) return { error: `workflow mapping error: ${injected.errors.join('; ')}` };
  return { graph: injected.workflow, seed };
}

/** Best-effort removal of a still-queued prompt from ComfyUI's queue. */
async function cancelPrompt(conn: Conn, promptId: string, signal: AbortSignal): Promise<void> {
  try {
    await fetch(buildQueueUrl(conn.base), {
      method: 'POST',
      headers: { ...conn.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal,
    });
  } catch {
    // best-effort: a job already executing can't be dequeued
  }
}

/** Best-effort progress stream; failures (incl. ws auth) are swallowed. */
function openProgressSocket(
  conn: Conn,
  clientId: string,
  promptId: string,
  report: ((text: string) => void) | undefined,
  signal: AbortSignal,
): WebSocket | null {
  if (!report) return null;
  try {
    const ws = new WebSocket(toWsUrl(conn.base, clientId));
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const event = parseWsMessage(ev.data);
      if (!event) return;
      if (event.type === 'progress' && (event.promptId === undefined || event.promptId === promptId)) {
        report(`generating ${event.value}/${event.max}`);
      } else if (isExecutionComplete(event, promptId)) {
        report('rendering output…');
      }
    });
    signal.addEventListener('abort', () => ws.close(), { once: true });
    return ws;
  } catch {
    return null;
  }
}

/**
 * Poll `/history` until the prompt produces image outputs (or aborts).
 * Written recursively rather than as a `while` so the sequential awaits
 * (one poll, then a delay) aren't flagged as parallelizable.
 */
async function waitForImages(conn: Conn, promptId: string, signal: AbortSignal): Promise<ImageRef[]> {
  if (signal.aborted) throw new Error('aborted');
  const history = await fetchHistory(conn, promptId, signal);
  const images = extractOutputImages(history, promptId);
  if (images.length > 0) return images;
  if (historyHasError(history, promptId)) throw new Error('ComfyUI reported an execution error (see server log)');
  await delay(1000, signal);
  return waitForImages(conn, promptId, signal);
}

async function pingServer(conn: Conn): Promise<boolean> {
  try {
    const res = await fetch(joinUrl(conn.base, '/system_stats'), {
      headers: conn.headers,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Tool parameters
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function comfyuiExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_COMFYUI_DISABLED)) return;

  const cwd = process.cwd();
  // Auto-disable when no user-supplied workflows exist. The shipped txt2img
  // graph (config/pi/comfyui/txt2img.api.json) is an example - it expects a
  // v1-5-pruned-emaonly checkpoint that most servers won't have - so registering
  // the tool with only that available would leak a broken option into the model's
  // tool list. The user has to point at their own workflow in
  // ~/.pi/agent/comfyui.json or <cwd>/.pi/comfyui.json to opt in.
  const userWorkflows = coerceConfigLayer(readJson(piAgentPath('comfyui.json'))).workflows ?? {};
  const projectWorkflows = coerceConfigLayer(readJson(piProjectPath(cwd, 'comfyui.json'))).workflows ?? {};
  if (Object.keys(userWorkflows).length === 0 && Object.keys(projectWorkflows).length === 0) return;

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
    prompt: Type.String({ description: 'Positive text prompt describing the image to generate.' }),
    negative: Type.Optional(Type.String({ description: 'Negative prompt: concepts to avoid.' })),
    workflow: Type.Optional(
      Type.String({
        description: `Named workflow to run. Must be one of the configured names: ${workflowList}. Defaults to "${defaultWorkflow}". Each workflow has its own preconfigured checkpoint, sampler, scheduler, and dimensions - do not pass a checkpoint filename, model ID, or sampler name here, and do not invent a new workflow name.`,
      }),
    ),
    width: Type.Optional(Type.Number({ description: 'Output width in pixels.' })),
    height: Type.Optional(Type.Number({ description: 'Output height in pixels.' })),
    steps: Type.Optional(Type.Number({ description: 'Sampler steps.' })),
    cfg: Type.Optional(Type.Number({ description: 'CFG / guidance scale.' })),
    seed: Type.Optional(Type.Number({ description: 'Seed for reproducibility. Omit for a fresh random seed.' })),
    denoise: Type.Optional(Type.Number({ description: 'Denoise strength (img2img); 0-1.' })),
    inputImage: Type.Optional(
      Type.String({ description: 'Path to an input image for img2img workflows that accept one.' }),
    ),
    count: Type.Optional(Type.Number({ description: 'Batch size (number of images).' })),
    sendToModel: Type.Optional(
      Type.Boolean({
        description:
          'Whether to return the image to you (the model) for analysis. Defaults to the configured value (true). Set false to only save it to disk and keep the image out of context - use this when the user just wants the picture, not for you to inspect it. The image is automatically held back when the active model has no vision (image) input regardless of this value.',
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          'Submit the generation and return immediately without waiting for the image. Use for slow renders (many steps, large dimensions, batches) so you can keep working; the returned job id is collected later with the `image_jobs` tool (action `collect`). Default false (block until the image is ready).',
      }),
    ),
  });

  pi.registerTool({
    name: 'generate_image',
    label: 'Generate image',
    description:
      `Generate an image from a text prompt using a local or remote ComfyUI server, and return it inline. ` +
      `Use this when the user asks to create, draw, render, or generate a picture/image/art. ` +
      `Runs one of the preconfigured ComfyUI workflows: ${workflowList} (default: ${defaultWorkflow}). ` +
      `Each workflow bakes in its own checkpoint, sampler, and scheduler; do NOT inspect ComfyUI's installed models, query /object_info, or call the ComfyUI HTTP API directly to discover models or samplers - this tool already encapsulates that. ` +
      `Supports negative prompts, width/height, steps, cfg, seed, batch count, and img2img via inputImage. ` +
      `The generated PNG is saved to disk and returned so you can see it.`,
    promptSnippet: `To create or render an image, call \`generate_image\` (runs one of the configured ComfyUI workflows: ${workflowList}) instead of describing the picture in text. Do not call ComfyUI's HTTP API directly.`,
    promptGuidelines: [
      'Use `generate_image` whenever the user wants a picture generated, not a textual description.',
      `The \`workflow\` arg must be one of the configured names: ${workflowList}. Do not pass a checkpoint filename, a sampler name, or invent a new workflow.`,
      "Do not call ComfyUI's HTTP endpoints (`/object_info`, `/models`, `/prompt`, `/view`, etc.) via bash, curl, or any other tool - `generate_image` is the only supported entry point.",
      'Omit `seed` to get a fresh random image; pass the `seed` echoed in a prior result to reproduce or vary one.',
      'Only pass `inputImage` for img2img workflows; txt2img workflows do not accept one.',
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

      let socket: WebSocket | null = null;
      try {
        const prep = await buildInjectedGraph(conn, wf, name, params, report, runSignal);
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
            negative: params.negative,
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
        'list (show all background jobs), collect (poll a job and return its images if ready), cancel (drop a still-queued job).',
    }),
    id: Type.Optional(
      Type.String({ description: 'Job id from a background generate_image call (required for collect / cancel).' }),
    ),
  });

  pi.registerTool({
    name: 'image_jobs',
    label: 'Image jobs',
    description:
      'Manage background image generations started by generate_image with background=true. ' +
      'Actions: list (all background jobs and their status), collect (poll a job; when its render is done, fetch the image(s) and return them inline), ' +
      'cancel (best-effort drop of a still-queued job). ' +
      'collect is safe to call repeatedly - it reports "still running" until the image is ready.',
    promptSnippet:
      'After starting a background generation with generate_image (background=true), use image_jobs action collect with the returned id to retrieve the image once it is ready.',
    promptGuidelines: [
      'Only use `image_jobs` for jobs started by `generate_image` with `background: true`. Foreground generations return their image directly.',
      'Poll with action `collect` and the job `id`; it returns "still running" until ComfyUI finishes, then returns the image(s).',
      'Use action `list` to see every background job and its status; action `cancel` to drop one that is still queued.',
    ],
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
    description:
      'Show ComfyUI status; `/comfyui workflows` to validate configured workflows; `/comfyui jobs` to list background generations.',
    handler: async (args, ctx) => {
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
          const loaded = loadWorkflowGraph(wf.file);
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
