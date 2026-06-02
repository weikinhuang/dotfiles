/**
 * Pure URL builders + response/event parsing for the ComfyUI HTTP and
 * websocket API. The extension shell owns the actual `fetch` /
 * `WebSocket` calls; everything here is string/JSON shaping so it can be
 * unit-tested without a server.
 *
 * Endpoints used downstream:
 *   - POST `/prompt`            submit a workflow, get a `prompt_id`
 *   - GET  `/history/{id}`      outputs once the job finishes
 *   - GET  `/view?filename=…`   fetch a generated image's bytes
 *   - WS   `/ws?clientId=…`     live progress + completion events
 *
 * No pi imports.
 */

import type { ImageRef } from './types.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drop any trailing slash so path joining stays predictable. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Join `path` onto `baseUrl`, ensuring exactly one separating slash. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/** URL for `GET /view` to fetch one output image's bytes. */
export function buildViewUrl(baseUrl: string, ref: ImageRef): string {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder,
    type: ref.type,
  });
  return `${joinUrl(baseUrl, '/view')}?${params.toString()}`;
}

/** URL for `GET /history/{promptId}`. */
export function buildHistoryUrl(baseUrl: string, promptId: string): string {
  return joinUrl(baseUrl, `/history/${encodeURIComponent(promptId)}`);
}

/** URL for `POST /queue` (used with `{ delete: [promptId] }` to drop a queued job). */
export function buildQueueUrl(baseUrl: string): string {
  return joinUrl(baseUrl, '/queue');
}

/** URL for `POST /interrupt` (cancels the prompt ComfyUI is currently executing). */
export function buildInterruptUrl(baseUrl: string): string {
  return joinUrl(baseUrl, '/interrupt');
}

/**
 * Convert an `http(s)` base URL into the `ws(s)` `/ws` URL for `clientId`.
 * `https` upgrades to `wss`; anything else (including `http`) uses `ws`.
 */
export function toWsUrl(baseUrl: string, clientId: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  return `${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`;
}

/**
 * Pull every output image ref out of a `/history/{promptId}` response.
 * Returns `[]` when the prompt is absent (still running) or has no
 * image outputs. Tolerant of partial / unexpected shapes - anything
 * that is not a well-formed image entry is skipped.
 */
export function extractOutputImages(history: unknown, promptId: string): ImageRef[] {
  if (!isObject(history)) return [];
  const entry = history[promptId];
  if (!isObject(entry) || !isObject(entry.outputs)) return [];

  const out: ImageRef[] = [];
  for (const node of Object.values(entry.outputs)) {
    if (!isObject(node) || !Array.isArray(node.images)) continue;
    for (const image of node.images as unknown[]) {
      if (!isObject(image)) continue;
      const filename = image.filename;
      if (typeof filename !== 'string' || filename.length === 0) continue;
      out.push({
        filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
        type: typeof image.type === 'string' ? image.type : 'output',
      });
    }
  }
  return out;
}

/**
 * True when ComfyUI's `/history` entry for `promptId` reports an
 * execution error (`status.status_str === 'error'`). Tolerant of partial
 * shapes - a missing entry, status, or field reads as "no error" so a
 * still-running or absent prompt is never mistaken for a failure.
 */
export function historyHasError(history: unknown, promptId: string): boolean {
  if (!isObject(history)) return false;
  const entry = history[promptId];
  if (!isObject(entry)) return false;
  const status = (entry as { status?: { status_str?: string } }).status;
  return status?.status_str === 'error';
}

/** A parsed websocket event, narrowed to the fields the extension uses. */
export type WsEvent =
  | { type: 'progress'; value: number; max: number; promptId?: string }
  | { type: 'executing'; node: string | null; promptId?: string }
  | { type: 'executed'; node?: string; promptId?: string }
  | { type: 'execution_error'; promptId?: string }
  | { type: 'status' }
  | { type: 'other'; raw: string };

function asPromptId(data: Record<string, unknown>): string | undefined {
  const id = data.prompt_id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Parse a text websocket frame into a {@link WsEvent}. Returns `null`
 * when the frame is not JSON or lacks a string `type`. Binary preview
 * frames are handled by the caller and never reach here.
 */
export function parseWsMessage(raw: string): WsEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.type !== 'string') return null;
  const data = isObject(parsed.data) ? parsed.data : {};

  switch (parsed.type) {
    case 'progress': {
      const value = typeof data.value === 'number' ? data.value : 0;
      const max = typeof data.max === 'number' ? data.max : 0;
      return { type: 'progress', value, max, promptId: asPromptId(data) };
    }
    case 'executing':
      return { type: 'executing', node: typeof data.node === 'string' ? data.node : null, promptId: asPromptId(data) };
    case 'executed':
      return {
        type: 'executed',
        node: typeof data.node === 'string' ? data.node : undefined,
        promptId: asPromptId(data),
      };
    case 'execution_error':
      return { type: 'execution_error', promptId: asPromptId(data) };
    case 'status':
      return { type: 'status' };
    default:
      return { type: 'other', raw };
  }
}

/**
 * True when `event` signals that `promptId` finished executing. ComfyUI
 * emits an `executing` event with `node: null` for the prompt when its
 * queue item is done.
 */
export function isExecutionComplete(event: WsEvent, promptId: string): boolean {
  return event.type === 'executing' && event.node === null && event.promptId === promptId;
}
