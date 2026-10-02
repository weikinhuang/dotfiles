import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import cacheBreakpoint from '../../../../../config/pi/extensions/cache-breakpoint.ts';
import { cacheTraceSidecarPath } from '../../../../../lib/node/pi/cache-trace-config.ts';
import { parseCacheTraceJsonl } from '../../../../../lib/node/pi/cache-trace-reader.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('runtime flags produce private per-session sidecars, associate response usage, and isolate reload runs', () => {
  vi.stubEnv('PI_CACHE_BREAKPOINT_DISABLED', '');
  vi.stubEnv('PI_CACHE_BREAKPOINT_TRACE', '');
  vi.stubEnv('PI_CACHE_BREAKPOINT_RESPONSES_KEY', '');
  const dir = mkdtempSync(join(tmpdir(), 'trace-runtime-'));
  try {
    const session = join(dir, 'session.jsonl');
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const flags = new Map<string, string>([
      ['cache-trace', 'auto'],
      ['cache-trace-level', 'system'],
    ]);
    const registerFlag = vi.fn();
    const pi = {
      registerFlag,
      getFlag: (name: string) => flags.get(name),
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    cacheBreakpoint(pi);
    expect(registerFlag).toHaveBeenCalledTimes(2);
    const ctx = {
      cwd: dir,
      hasUI: true,
      ui: { notify: vi.fn() },
      model: { provider: 'openai', id: 'fixture', api: 'openai-responses' },
      sessionManager: { getSessionFile: () => session, getSessionId: () => 'session', getLeafId: () => 'leaf' },
    };
    const payload = { instructions: 'PRIVATE system', input: [{ role: 'user', content: 'PRIVATE user' }] };
    const original = structuredClone(payload);
    for (let index = 0; index < 2; index++) {
      handlers.get('session_start')!({}, ctx);
      expect(handlers.get('before_provider_request')!({ payload }, ctx)).toBeUndefined();
      handlers.get('message_end')!(
        { message: { role: 'assistant', usage: { cacheRead: 123, cacheWrite: 456, cost: { total: 0.1 } } } },
        ctx,
      );
    }
    expect(payload).toEqual(original);
    const text = readFileSync(cacheTraceSidecarPath(session), 'utf8');
    expect(text).not.toContain('PRIVATE user');
    const parsed = parseCacheTraceJsonl(text);
    expect(parsed.requests).toHaveLength(2);
    expect(new Set(parsed.requests.map((request) => request.runId)).size).toBe(2);
    expect(parsed.requests[0].cacheRead).toBe(123);
    expect(parsed.snapshots.size).toBe(2);
    handlers.get('session_shutdown')!({}, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
