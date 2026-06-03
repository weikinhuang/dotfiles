/**
 * Tests for lib/node/pi/comfyui/client.ts.
 *
 * These exercise the ComfyUI server I/O, so `fetch` / `WebSocket` are
 * stubbed via `vi.stubGlobal`. The deterministic URL building and
 * response parsing they delegate to is covered by api.spec.ts /
 * workflow.spec.ts; here we assert the request wiring, the OK/non-OK
 * branches, and the disk write.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildInjectedGraph,
  cancelPrompt,
  type Conn,
  createWaker,
  fetchAndSave,
  fetchHistory,
  fetchImageBytes,
  fetchQueue,
  pingServer,
  submitPrompt,
  waitForImages,
} from '../../../../../lib/node/pi/comfyui/client.ts';
import type { ComfyWorkflow, ImageRef, WorkflowConfig } from '../../../../../lib/node/pi/comfyui/types.ts';

const CONN: Conn = { base: 'http://comfy:8188', headers: { Authorization: 'Bearer t' }, timeoutMs: 1000 };

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

function fakeResponse(init: FakeResponseInit): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(init.json),
    text: () => Promise.resolve(init.text ?? ''),
    arrayBuffer: () => Promise.resolve((init.bytes ?? new Uint8Array()).buffer),
  } as unknown as Response;
}

/** Install a fetch stub and capture every (url, init) call. */
function stubFetch(responder: (url: string, init?: RequestInit) => Response): { calls: { url: string }[] } {
  const calls: { url: string }[] = [];
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u });
    return Promise.resolve(responder(u, init));
  });
  return { calls };
}

const signal = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submitPrompt', () => {
  const graph: ComfyWorkflow = { '1': { inputs: {} } };

  test('POSTs to /prompt and returns the prompt_id', async () => {
    const { calls } = stubFetch(() => fakeResponse({ json: { prompt_id: 'p1' } }));
    const id = await submitPrompt(CONN, graph, 'cid', signal());
    expect(id).toBe('p1');
    expect(calls[0].url).toBe('http://comfy:8188/prompt');
  });

  test('throws with the server body on a non-OK response', async () => {
    stubFetch(() => fakeResponse({ ok: false, status: 400, text: 'bad node' }));
    await expect(submitPrompt(CONN, graph, 'cid', signal())).rejects.toThrow('HTTP 400');
  });

  test('throws when no prompt_id comes back', async () => {
    stubFetch(() => fakeResponse({ json: {} }));
    await expect(submitPrompt(CONN, graph, 'cid', signal())).rejects.toThrow('did not return a prompt_id');
  });
});

describe('fetchHistory', () => {
  test('returns the parsed body on OK', async () => {
    stubFetch(() => fakeResponse({ json: { p1: { outputs: {} } } }));
    await expect(fetchHistory(CONN, 'p1', signal())).resolves.toEqual({ p1: { outputs: {} } });
  });

  test('returns null on a non-OK response', async () => {
    stubFetch(() => fakeResponse({ ok: false, status: 404 }));
    await expect(fetchHistory(CONN, 'p1', signal())).resolves.toBeNull();
  });
});

describe('fetchImageBytes', () => {
  const ref: ImageRef = { filename: 'a.png', subfolder: '', type: 'output' };

  test('returns the response bytes as a Buffer', async () => {
    stubFetch(() => fakeResponse({ bytes: new Uint8Array([1, 2, 3]) }));
    const buf = await fetchImageBytes(CONN, ref, signal());
    expect([...buf]).toEqual([1, 2, 3]);
  });

  test('throws on a non-OK response', async () => {
    stubFetch(() => fakeResponse({ ok: false, status: 500 }));
    await expect(fetchImageBytes(CONN, ref, signal())).rejects.toThrow('failed to fetch a.png');
  });
});

describe('fetchAndSave', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'comfyui-save-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes each image to saveDir and returns an inline block', async () => {
    stubFetch(() => fakeResponse({ bytes: new Uint8Array([255, 0]) }));
    const refs: ImageRef[] = [{ filename: 'out.png', subfolder: '', type: 'output' }];
    const saved = await fetchAndSave(CONN, refs, dir, signal());
    expect(saved).toHaveLength(1);
    expect(saved[0].block.mimeType).toBe('image/png');
    expect(saved[0].block.data).toBe(Buffer.from([255, 0]).toString('base64'));
    expect(readdirSync(dir)).toHaveLength(1);
    expect(saved[0].savedPath).toContain('out.png');
  });

  test('basenames a traversal filename so writes stay inside saveDir', async () => {
    stubFetch(() => fakeResponse({ bytes: new Uint8Array([1]) }));
    const refs: ImageRef[] = [{ filename: '../../escape.png', subfolder: '', type: 'output' }];
    const saved = await fetchAndSave(CONN, refs, dir, signal());
    // The written path is inside dir and the traversal segments are gone.
    expect(saved[0].savedPath.startsWith(dir)).toBe(true);
    expect(saved[0].savedPath).not.toContain('..');
    expect(saved[0].savedPath).toContain('escape.png');
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe('fetchQueue', () => {
  test('returns the parsed body on OK', async () => {
    const body = { queue_running: [[0, 'p1', {}]], queue_pending: [] };
    const { calls } = stubFetch(() => fakeResponse({ json: body }));
    await expect(fetchQueue(CONN, signal())).resolves.toEqual(body);
    expect(calls[0].url).toBe('http://comfy:8188/queue');
  });

  test('returns null on a non-OK response', async () => {
    stubFetch(() => fakeResponse({ ok: false, status: 503 }));
    await expect(fetchQueue(CONN, signal())).resolves.toBeNull();
  });
});

describe('cancelPrompt', () => {
  test('POSTs a delete to /queue', async () => {
    const { calls } = stubFetch(() => fakeResponse({}));
    await cancelPrompt(CONN, 'p1', signal());
    expect(calls[0].url).toBe('http://comfy:8188/queue');
  });

  test('swallows a fetch failure (best-effort)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')));
    await expect(cancelPrompt(CONN, 'p1', signal())).resolves.toBeUndefined();
  });
});

describe('pingServer', () => {
  test('true when /system_stats responds OK', async () => {
    const { calls } = stubFetch(() => fakeResponse({}));
    await expect(pingServer(CONN)).resolves.toBe(true);
    expect(calls[0].url).toBe('http://comfy:8188/system_stats');
  });

  test('false on a non-OK response', async () => {
    stubFetch(() => fakeResponse({ ok: false, status: 502 }));
    await expect(pingServer(CONN)).resolves.toBe(false);
  });

  test('false when the request rejects', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('refused')));
    await expect(pingServer(CONN)).resolves.toBe(false);
  });
});

describe('waitForImages', () => {
  test('returns the images as soon as /history has outputs', async () => {
    const history = { p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } };
    stubFetch(() => fakeResponse({ json: history }));
    await expect(waitForImages(CONN, 'p1', signal())).resolves.toEqual([
      { filename: 'a.png', subfolder: '', type: 'output' },
    ]);
  });

  test('throws when /history reports an execution error', async () => {
    stubFetch(() => fakeResponse({ json: { p1: { status: { status_str: 'error' } } } }));
    await expect(waitForImages(CONN, 'p1', signal())).rejects.toThrow('execution error');
  });

  test('throws immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(waitForImages(CONN, 'p1', ac.signal)).rejects.toThrow('aborted');
  });

  test('a woken sleep skips the poll interval between empty polls', async () => {
    const ready = { p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } };
    let poll = 0;
    stubFetch(() => fakeResponse({ json: poll++ === 0 ? { p1: { outputs: {} } } : ready }));
    const waker = createWaker();
    // Pre-latch a wake so the post-first-poll sleep resolves at once
    // without advancing any real timer (poll interval is 60s here).
    waker.wake();
    const refs = await waitForImages(CONN, 'p1', signal(), waker, 60000);
    expect(refs).toEqual([{ filename: 'a.png', subfolder: '', type: 'output' }]);
    expect(poll).toBe(2);
  });
});

describe('buildInjectedGraph', () => {
  const HOME = '/home/test';
  const noop = (): void => undefined;
  let dir: string;
  let wfFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'comfyui-graph-'));
    wfFile = join(dir, 'wf.json');
    writeFileSync(wfFile, JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old' } } }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns a mapping error for a missing workflow file without hitting the network', async () => {
    const { calls } = stubFetch(() => fakeResponse({}));
    const wf: WorkflowConfig = { file: '/missing/wf.json', inputs: { prompt: { node: '6', key: 'text' } } };
    const out = await buildInjectedGraph(CONN, wf, 'txt2img', { prompt: 'x' }, dir, HOME, noop, signal());
    expect(out.error).toContain('workflow file not found');
    expect(calls).toHaveLength(0);
  });

  test('injects the prompt into the loaded graph', async () => {
    const wf: WorkflowConfig = { file: wfFile, inputs: { prompt: { node: '6', key: 'text' } } };
    const out = await buildInjectedGraph(CONN, wf, 'txt2img', { prompt: 'a cat' }, dir, HOME, noop, signal());
    expect(out.error).toBeUndefined();
    expect(out.graph?.['6'].inputs?.text).toBe('a cat');
  });

  test('resolves a relative workflow file against cwd', async () => {
    const wf: WorkflowConfig = { file: './wf.json', inputs: { prompt: { node: '6', key: 'text' } } };
    const out = await buildInjectedGraph(CONN, wf, 'txt2img', { prompt: 'a cat' }, dir, HOME, noop, signal());
    expect(out.error).toBeUndefined();
    expect(out.graph?.['6'].inputs?.text).toBe('a cat');
  });

  test('rejects an inputImage for a workflow that does not accept one', async () => {
    const wf: WorkflowConfig = { file: wfFile, inputs: { prompt: { node: '6', key: 'text' } } };
    const out = await buildInjectedGraph(
      CONN,
      wf,
      'txt2img',
      { prompt: 'x', inputImage: '~/in.png' },
      dir,
      HOME,
      noop,
      signal(),
    );
    expect(out.error).toContain('does not accept an input image');
  });
});
