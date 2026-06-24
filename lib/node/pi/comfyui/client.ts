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
import { randomUUID } from 'node:crypto';

import { delay } from '../abortable-delay.ts';
import { atomicWriteFile } from '../atomic-write.ts';
import { expandTilde } from '../path-expand.ts';

import {
  buildHistoryUrl,
  buildInterruptUrl,
  buildQueueUrl,
  buildViewUrl,
  extractOutputImages,
  historyHasError,
  isExecutionComplete,
  joinUrl,
  parseWsMessage,
  queueRunningHasPrompt,
  toWsUrl,
} from './api.ts';
import { mimeFromName } from './images.ts';
import type { ComfyWorkflow, ImageRef, WorkflowConfig } from './types.ts';
import { createWaker, type Waker } from './waker.ts';
import {
  injectImageList,
  injectImageRoles,
  injectInputs,
  isRoleMap,
  loadWorkflowGraph,
  randomSeed,
} from './workflow.ts';

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

/**
 * Optional post-processing of an output image's bytes before they become
 * the inline model block (used by the token-economy downscale). Receives
 * the full-resolution bytes + the block's MIME type and returns the bytes
 * to base64-encode; the on-disk file is written from the ORIGINAL bytes
 * regardless. The decode/resize is native (`sharp`), so the concrete
 * transform is supplied by the extension shell; the default is identity.
 */
export type ImageBlockTransform = (bytes: Buffer, mimeType: string) => Promise<Buffer> | Buffer;

async function buildImageBlock(
  bytes: Buffer,
  name: string,
  transform?: ImageBlockTransform,
): Promise<SavedImage['block']> {
  const mimeType = mimeFromName(name);
  const encoded = transform ? await transform(bytes, mimeType) : bytes;
  return { type: 'image', data: encoded.toString('base64'), mimeType };
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
  inputImages?: string[];
  count?: number;
  sendToModel?: boolean;
  background?: boolean;
  /**
   * Auto-refine companion extras injected only by the refine loop: a
   * grounder target phrase (`ground` channel) and a detector class
   * (`detailer` channel). A normal render leaves both undefined; a companion
   * workflow that uses them MUST map `target` / `detect` in its input map
   * (an unmapped-but-supplied value is a mapping error, surfaced before submit).
   */
  target?: string;
  detect?: string;
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

/** Upload raw image bytes under `filename`; returns the server-side name. */
export async function uploadImageBuffer(
  conn: Conn,
  bytes: Buffer,
  filename: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the Blob part type is
  // satisfied regardless of the source Buffer's backing store.
  form.append('image', new Blob([new Uint8Array(bytes)]), filename);
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

/** Upload a local image file for img2img; returns its server-side name. */
export async function uploadImage(conn: Conn, filePath: string, homedir: string, signal: AbortSignal): Promise<string> {
  const resolved = expandTilde(filePath, homedir);
  if (!existsSync(resolved)) throw new Error(`input image not found: ${resolved}`);
  return uploadImageBuffer(conn, readFileSync(resolved), basename(resolved), signal);
}

/** GET `/history/{id}`; returns `null` on a non-OK response. */
export async function fetchHistory(conn: Conn, promptId: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(buildHistoryUrl(conn.base, promptId), { headers: conn.headers, signal });
  if (!res.ok) return null;
  return res.json();
}

/** GET `/queue` (running + pending jobs); returns `null` on a non-OK response. */
export async function fetchQueue(conn: Conn, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(buildQueueUrl(conn.base), { headers: conn.headers, signal });
  if (!res.ok) return null;
  return res.json();
}

/** GET `/view` for one output image; returns its raw bytes. */
export async function fetchImageBytes(conn: Conn, ref: ImageRef, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(buildViewUrl(conn.base, ref), { headers: conn.headers, signal });
  if (!res.ok) throw new Error(`failed to fetch ${ref.filename} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetch every output image, write each to `saveDir` at full resolution,
 * and return path + inline block. When `transform` is supplied it
 * post-processes only the inline block's bytes (e.g. a downscale for the
 * model); the on-disk file is always the original bytes.
 */
export async function fetchAndSave(
  conn: Conn,
  refs: ImageRef[],
  saveDir: string,
  signal: AbortSignal,
  transform?: ImageBlockTransform,
): Promise<SavedImage[]> {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  return Promise.all(
    refs.map(async (ref, i) => {
      const bytes = await fetchImageBytes(conn, ref, signal);
      // `ref.filename` comes straight from the server's /history JSON; run
      // it through basename so a hostile / buggy server returning
      // "../escape.png" can't write outside saveDir.
      const savedPath = join(saveDir, `comfyui-${stamp}-${i}-${basename(ref.filename)}`);
      atomicWriteFile(savedPath, bytes);
      return { savedPath, block: await buildImageBlock(bytes, ref.filename, transform) };
    }),
  );
}

/**
 * Re-build inline image blocks from files already written to disk by a
 * prior {@link fetchAndSave} (e.g. an auto-downloaded background job).
 * Skips any path that no longer exists, so a manually-deleted output is
 * silently dropped rather than throwing. Local IO - no server call. The
 * optional `transform` downscales only the re-served block (the disk file
 * is left untouched), so a collected background job shrinks like a fresh
 * foreground render.
 */
export async function readSavedImages(paths: string[], transform?: ImageBlockTransform): Promise<SavedImage[]> {
  const existing = paths.filter((p) => existsSync(p));
  return Promise.all(
    existing.map(async (savedPath) => ({
      savedPath,
      block: await buildImageBlock(readFileSync(savedPath), savedPath, transform),
    })),
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
  cwd: string,
  homedir: string,
  report: (text: string) => void,
  signal: AbortSignal,
  roleImages?: Record<string, string>,
): Promise<{ graph?: ComfyWorkflow; seed?: number; error?: string }> {
  const loaded = loadWorkflowGraph(wf.file, cwd, homedir);
  if (loaded.error || !loaded.graph) return { error: loaded.error ?? 'failed to load workflow' };

  const slots = wf.images;
  const roleMode = isRoleMap(slots);

  // Image inputs: positional uploads happen here; role uploads (incl.
  // synthesized masks, which need `sharp`) are resolved by the shell and
  // passed in via `roleImages`.
  let withImages: { workflow: ComfyWorkflow; errors: string[] };
  if (roleMode) {
    if ((params.inputImages?.length ?? 0) > 0) {
      return { error: `workflow "${name}" uses named image roles; pass "images", not "inputImages"` };
    }
    withImages = injectImageRoles(loaded.graph, slots, roleImages ?? {});
  } else {
    const targets = slots ?? [];
    const images = params.inputImages ?? [];
    if (images.length > 0 && targets.length === 0) {
      return { error: `workflow "${name}" does not accept an input image` };
    }
    if (images.length > targets.length) {
      return { error: `workflow "${name}" accepts at most ${targets.length} reference image(s)` };
    }
    if (images.length > 0) {
      report(images.length === 1 ? 'uploading input image…' : `uploading ${images.length} reference images…`);
    }
    const uploadedNames = await Promise.all(images.map((path) => uploadImage(conn, path, homedir, signal)));
    withImages = injectImageList(loaded.graph, targets, uploadedNames);
  }

  const autoSeed = params.seed === undefined && wf.inputs.seed !== undefined ? randomSeed() : undefined;
  const seed = params.seed ?? autoSeed;

  const injected = injectInputs(withImages.workflow, wf.inputs, {
    prompt: params.prompt,
    negative: params.negative,
    seed,
    steps: params.steps,
    cfg: params.cfg,
    denoise: params.denoise,
    width: params.width,
    height: params.height,
    batch: params.count,
    target: params.target,
    detect: params.detect,
  });
  const errors = [...withImages.errors, ...injected.errors];
  if (errors.length > 0) return { error: `workflow mapping error: ${errors.join('; ')}` };
  return { graph: injected.workflow, seed };
}

/**
 * Best-effort cancellation of a background generation.
 *
 * ComfyUI splits cancellation across two endpoints: `POST /queue
 * {delete:[id]}` removes a still-*pending* prompt from the queue, while
 * `POST /interrupt` stops whatever prompt is *currently executing* (it
 * takes no id of its own). So we read `/queue` first: if our prompt is the
 * running one, interrupt it; otherwise drop it from the pending queue.
 * Every call is wrapped so a prompt that is already gone (finished, or the
 * server restarted) is a silent no-op.
 */
export async function cancelPrompt(conn: Conn, promptId: string, signal: AbortSignal): Promise<void> {
  let queue: unknown = null;
  try {
    queue = await fetchQueue(conn, signal);
  } catch {
    // best-effort: a queue read failure just falls through to a plain delete
  }

  if (queueRunningHasPrompt(queue, promptId)) {
    // The prompt is executing now; `/interrupt` is the only way to stop it.
    try {
      await fetch(buildInterruptUrl(conn.base), { method: 'POST', headers: conn.headers, signal });
    } catch {
      // best-effort: a job that just finished can't be interrupted
    }
    return;
  }

  // Pending (or unknown): drop it from the queue. A no-op if already gone.
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

/**
 * Best-effort progress stream; failures (incl. ws auth) are swallowed.
 *
 * Two jobs: surface a live progress line via `report` (when given), and,
 * when a `waker` is supplied, fire it the instant the socket sees this
 * prompt finish or error so {@link waitForImages} can cut its poll sleep
 * short instead of waiting out the full interval. The socket only ever
 * *wakes* the poll - it never reports completion on its own, so a missed
 * or never-connected socket just falls back to plain polling.
 */
export function openProgressSocket(
  conn: Conn,
  clientId: string,
  promptId: string,
  report: ((text: string) => void) | undefined,
  signal: AbortSignal,
  waker?: Waker,
): WebSocket | null {
  if (!report && !waker) return null;
  try {
    const ws = new WebSocket(toWsUrl(conn.base, clientId));
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const event = parseWsMessage(ev.data);
      if (!event) return;
      if (event.type === 'progress' && (event.promptId === undefined || event.promptId === promptId)) {
        report?.(`generating ${event.value}/${event.max}`);
      } else if (isExecutionComplete(event, promptId)) {
        report?.('rendering output…');
        waker?.wake();
      } else if (event.type === 'execution_error' && (event.promptId === undefined || event.promptId === promptId)) {
        // The error itself is confirmed by the next /history poll (which
        // carries the reason); we just wake it so that happens at once.
        waker?.wake();
      }
    });
    signal.addEventListener('abort', () => ws.close(), { once: true });
    return ws;
  } catch {
    return null;
  }
}

/**
 * Poll `/history` until the prompt produces output refs (or aborts).
 * Written recursively rather than as a `while` so the sequential awaits
 * (one poll, then a sleep) aren't flagged as parallelizable.
 *
 * The fixed-interval poll is the reliable floor. When a `waker` is passed
 * (fed by {@link openProgressSocket}), a completion/error event cuts the
 * sleep short, so a healthy websocket removes the up-to-`pollMs` latency
 * tax between "render finished" and "we noticed" without giving up the
 * poll as the source of truth.
 */
export async function waitForImages(
  conn: Conn,
  promptId: string,
  signal: AbortSignal,
  waker?: Waker,
  pollMs = 1000,
): Promise<ImageRef[]> {
  if (signal.aborted) throw new Error('aborted');
  const history = await fetchHistory(conn, promptId, signal);
  const images = extractOutputImages(history, promptId);
  if (images.length > 0) return images;
  if (historyHasError(history, promptId)) throw new Error('ComfyUI reported an execution error (see server log)');
  if (waker) await waker.sleep(pollMs, signal);
  else await delay(pollMs, signal);
  return waitForImages(conn, promptId, signal, waker, pollMs);
}

/** Re-export so the extension shell can build a waker without reaching into `./waker`. */
export { createWaker, type Waker };

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

/**
 * GET `/object_info` and return the parsed node catalog. ComfyUI describes every
 * loadable node here, including the available model files as enum lists on loader
 * inputs (e.g. `CheckpointLoaderSimple.input.required.ckpt_name[0]`). Returned as
 * an opaque record; callers extract the lists they need.
 */
export async function fetchObjectInfo(conn: Conn, signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(joinUrl(conn.base, '/object_info'), { headers: conn.headers, signal });
  if (!res.ok) {
    throw new Error(`object_info request failed: ${res.status} ${res.statusText}`);
  }
  const data: unknown = await res.json();
  if (data === null || typeof data !== 'object') {
    throw new Error('object_info response was not a JSON object');
  }
  return data as Record<string, unknown>;
}
