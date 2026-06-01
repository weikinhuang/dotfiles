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

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
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
  buildViewUrl,
  extractOutputImages,
  isExecutionComplete,
  joinUrl,
  parseWsMessage,
  toWsUrl,
} from '../../../lib/node/pi/comfyui/api.ts';
import { injectInputs, isComfyWorkflow, randomSeed, validateMapping } from '../../../lib/node/pi/comfyui/workflow.ts';
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
  const entry = history && typeof history === 'object' ? (history as Record<string, unknown>)[promptId] : undefined;
  const status =
    entry && typeof entry === 'object' ? (entry as { status?: { status_str?: string } }).status : undefined;
  if (status?.status_str === 'error') throw new Error('ComfyUI reported an execution error (see server log)');
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

      const loaded = loadWorkflowGraph(wf.file);
      if (loaded.error || !loaded.graph) {
        details.error = loaded.error;
        return { content: [{ type: 'text', text: loaded.error ?? 'failed to load workflow' }], details, isError: true };
      }

      const base = resolveBaseUrl(config);
      const headers = resolveAuthHeaders(config);
      const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };

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
        // img2img: upload the input image and reference it in the LoadImage node.
        let uploadedName: string | undefined;
        if (params.inputImage !== undefined) {
          if (wf.inputs.image === undefined) {
            details.error = `workflow "${name}" does not accept an input image`;
            return { content: [{ type: 'text', text: details.error }], details, isError: true };
          }
          report('uploading input image…');
          uploadedName = await uploadImage(conn, params.inputImage, runSignal);
        }

        const autoSeed = params.seed === undefined && wf.inputs.seed !== undefined ? randomSeed() : undefined;
        const seed = params.seed ?? autoSeed;
        details.seed = seed;

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
        if (injected.errors.length > 0) {
          details.error = injected.errors.join('; ');
          return {
            content: [{ type: 'text', text: `workflow mapping error: ${details.error}` }],
            details,
            isError: true,
          };
        }

        const clientId = randomUUID();
        report('submitting to ComfyUI…');
        const promptId = await submitPrompt(conn, injected.workflow, clientId, runSignal);
        details.promptId = promptId;

        socket = openProgressSocket(conn, clientId, promptId, onUpdate ? report : undefined, runSignal);
        const refs = await waitForImages(conn, promptId, runSignal);

        const saveDir = isAbsolute(config.saveDir) ? config.saveDir : join(ctx.cwd, config.saveDir);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const saved = await Promise.all(
          refs.map(async (ref, i) => {
            const bytes = await fetchImageBytes(conn, ref, runSignal);
            const savedPath = join(saveDir, `comfyui-${stamp}-${i}-${ref.filename}`);
            atomicWriteFile(savedPath, bytes);
            return {
              savedPath,
              block: { type: 'image' as const, data: bytes.toString('base64'), mimeType: mimeFromName(ref.filename) },
            };
          }),
        );
        for (const s of saved) details.savedPaths.push(s.savedPath);

        const requested = params.sendToModel ?? config.sendToModel;
        const decision = resolveSendToModel(requested, ctx.model?.input);
        const seedNote = seed !== undefined ? ` (seed ${seed})` : '';
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

  pi.registerCommand('comfyui', {
    description: 'Show ComfyUI status, or `/comfyui workflows` to validate configured workflows.',
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const base = resolveBaseUrl(config);
      const headers = resolveAuthHeaders(config);
      const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };
      const sub = args.trim().toLowerCase();

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
