import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Conn } from '../../../../../lib/node/pi/comfyui/client.ts';
import type { ImageJob } from '../../../../../lib/node/pi/comfyui/jobs.ts';
import { pollJobOnce } from '../../../../../lib/node/pi/comfyui/poll.ts';

const conn: Conn = { base: 'http://comfy.test', headers: {}, timeoutMs: 1000 };

function job(over: Partial<ImageJob> = {}): ImageJob {
  return {
    id: '1',
    promptId: 'p1',
    workflow: 'anima',
    prompt: 'x',
    saveDir: '/tmp/comfy',
    sendToModel: false,
    status: 'running',
    savedPaths: [],
    startedAt: 0,
    ...over,
  };
}

/** Route a stubbed `fetch` by URL to canned `/history` + `/queue` bodies. */
function stubFetch(bodies: { history?: unknown; queue?: unknown }): void {
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = String(input);
    const body: unknown = url.includes('/queue') ? bodies.queue : bodies.history;
    const res = { ok: true, json: () => Promise.resolve(body ?? {}) } as unknown as Response;
    return Promise.resolve(res);
  });
}

/**
 * Route a stubbed `fetch` where either endpoint can respond non-OK (a
 * transient HTTP error). `fetchHistory` / `fetchQueue` map a non-OK response
 * to `null`, which the poller must NOT read as "prompt gone".
 */
function stubFetchStatus(opts: { historyOk?: boolean; queueOk?: boolean; history?: unknown; queue?: unknown }): void {
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = String(input);
    const isQueue = url.includes('/queue');
    const ok = isQueue ? (opts.queueOk ?? true) : (opts.historyOk ?? true);
    const body: unknown = isQueue ? opts.queue : opts.history;
    const res = { ok, status: ok ? 200 : 502, json: () => Promise.resolve(body ?? {}) } as unknown as Response;
    return Promise.resolve(res);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pollJobOnce', () => {
  test('a job with no prompt id is still "running" and makes no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const outcome = await pollJobOnce(job({ promptId: '' }), conn, AbortSignal.timeout(1000));
    expect(outcome).toEqual({ kind: 'running' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an entry with no outputs yet reads as running', async () => {
    stubFetch({ history: { p1: { outputs: {} } } });
    expect(await pollJobOnce(job(), conn, AbortSignal.timeout(1000))).toEqual({ kind: 'running' });
  });

  test('an execution error reads as failed', async () => {
    stubFetch({ history: { p1: { status: { status_str: 'error' } } } });
    const outcome = await pollJobOnce(job(), conn, AbortSignal.timeout(1000));
    expect(outcome.kind).toBe('failed');
  });

  test('a prompt absent from both history and queue reads as failed (server lost it)', async () => {
    stubFetch({ history: {}, queue: { queue_running: [], queue_pending: [] } });
    const outcome = await pollJobOnce(job(), conn, AbortSignal.timeout(1000));
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'prompt is no longer on the server (ComfyUI may have restarted); resubmit to retry',
    });
  });

  test('an absent history entry that is still queued reads as running', async () => {
    stubFetch({ history: {}, queue: { queue_running: [[0, 'p1']], queue_pending: [] } });
    expect(await pollJobOnce(job(), conn, AbortSignal.timeout(1000))).toEqual({ kind: 'running' });
  });

  test('a transient HTTP failure on BOTH history and queue keeps the job running (not failed)', async () => {
    // A 502 / timeout on both endpoints must not be read as "prompt gone" -
    // failing a live background job on a blip is the bug this guards against.
    stubFetchStatus({ historyOk: false, queueOk: false });
    expect(await pollJobOnce(job(), conn, AbortSignal.timeout(1000))).toEqual({ kind: 'running' });
  });

  test('history reached (no entry) but the queue fetch fails keeps the job running', async () => {
    // The prompt is absent from a reachable history, but the queue could not
    // be read, so absence cannot be confirmed - stay running rather than fail.
    stubFetchStatus({ historyOk: true, history: {}, queueOk: false });
    expect(await pollJobOnce(job(), conn, AbortSignal.timeout(1000))).toEqual({ kind: 'running' });
  });

  test('history fetch fails but a reachable queue lacks the prompt reads as failed', async () => {
    // The server was reached (queue is non-null) and does not list the prompt,
    // so it is genuinely gone.
    stubFetchStatus({ historyOk: false, queueOk: true, queue: { queue_running: [], queue_pending: [] } });
    const outcome = await pollJobOnce(job(), conn, AbortSignal.timeout(1000));
    expect(outcome.kind).toBe('failed');
  });
});
