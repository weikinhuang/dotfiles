/**
 * ComfyUI server I/O: the HTTP (`fetch`) + websocket (`WebSocket`) +
 * disk calls that drive a generation. Everything here speaks only to the
 * {@link Conn} struct and the pure builders / parsers in `api.ts`,
 * `workflow.ts`, and `images.ts` - no pi runtime import - so the
 * extension shell is left with just the pi glue (tool / command
 * registration, result formatting, the job registry).
 *
 * These functions touch the network and the filesystem, so the spec
 * stubs `fetch` / `WebSocket` rather than running fully in-memory; the
 * deterministic shaping they delegate to is covered by the sibling pure
 * specs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { delay } from '../abortable-delay.ts';
import { atomicWriteFile } from '../atomic-write.ts';
import { expandTilde } from '../path-expand.ts';

import {
  buildHistoryUrl,
  buildQueueUrl,
  buildViewUrl,
  extractOutputImages,
  historyHasError,
  isExecutionComplete,
  joinUrl,
  parseWsMessage,
  toWsUrl,
} from './api.ts';
import { mimeFromName } from './images.ts';
import type { ComfyWorkflow, ImageRef, WorkflowConfig } from './types.ts';
import { injectInputs, loadWorkflowGraph, randomSeed } from './workflow.ts';

/** A live connection to a ComfyUI server: base URL, auth headers, timeout. */
export interface Conn {
  base: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

/** One fetched output: the on-disk path plus the inline image block. */
export interface SavedImage {
  savedPath: string;
  block: { type: 'image'; data: string; mimeType: string };
}

/** Subset of `generate_image` params the prepare/submit helpers read. */
export interface GenParams {
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

/** POST a graph to `/prompt`; returns the assigned `prompt_id`. */
export async function submitPrompt(
  conn: Conn,
  graph: ComfyWorkflow,
  clientId: string,
  signal: AbortSignal,
): Promise<string> {
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

/** Upload a local image for img2img; returns its server-side name. */
export async function uploadImage(conn: Conn, filePath: string, homedir: string, signal: AbortSignal): Promise<string> {
  const resolved = expandTilde(filePath, homedir);
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

/** GET `/history/{id}`; returns `null` on a non-OK response. */
export async function fetchHistory(conn: Conn, promptId: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(buildHistoryUrl(conn.base, promptId), { headers: conn.headers, signal });
  if (!res.ok) return null;
  return res.json();
}

/** GET `/view` for one output image; returns its raw bytes. */
export async function fetchImageBytes(conn: Conn, ref: ImageRef, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(buildViewUrl(conn.base, ref), { headers: conn.headers, signal });
  if (!res.ok) throw new Error(`failed to fetch ${ref.filename} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch every output image, write each to `saveDir`, and return path + inline block. */
export async function fetchAndSave(
  conn: Conn,
  refs: ImageRef[],
  saveDir: string,
  signal: AbortSignal,
): Promise<SavedImage[]> {
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
export async function buildInjectedGraph(
  conn: Conn,
  wf: WorkflowConfig,
  name: string,
  params: GenParams,
  homedir: string,
  report: (text: string) => void,
  signal: AbortSignal,
): Promise<{ graph?: ComfyWorkflow; seed?: number; error?: string }> {
  const loaded = loadWorkflowGraph(wf.file, homedir);
  if (loaded.error || !loaded.graph) return { error: loaded.error ?? 'failed to load workflow' };

  let uploadedName: string | undefined;
  if (params.inputImage !== undefined) {
    if (wf.inputs.image === undefined) return { error: `workflow "${name}" does not accept an input image` };
    report('uploading input image…');
    uploadedName = await uploadImage(conn, params.inputImage, homedir, signal);
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
export async function cancelPrompt(conn: Conn, promptId: string, signal: AbortSignal): Promise<void> {
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
export function openProgressSocket(
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
export async function waitForImages(conn: Conn, promptId: string, signal: AbortSignal): Promise<ImageRef[]> {
  if (signal.aborted) throw new Error('aborted');
  const history = await fetchHistory(conn, promptId, signal);
  const images = extractOutputImages(history, promptId);
  if (images.length > 0) return images;
  if (historyHasError(history, promptId)) throw new Error('ComfyUI reported an execution error (see server log)');
  await delay(1000, signal);
  return waitForImages(conn, promptId, signal);
}

/** True when `/system_stats` responds OK within 5s; false on any error. */
export async function pingServer(conn: Conn): Promise<boolean> {
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
