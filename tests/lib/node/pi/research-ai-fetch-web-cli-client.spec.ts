/**
 * Tests for the `ai-fetch-web` CLI-backed McpClient used by the
 * deep-research pipeline to populate the source store post-fanout.
 *
 * Every test injects a fake `spawn` so we exercise argv
 * construction, env threading, stdin piping, JSON parsing, and
 * structured-content extraction against deterministic bytes -
 * no actual subprocesses spawn during `npm test`.
 */

import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  createAiFetchWebCliClient,
  createAiFetchWebCliClientFromEnv,
  findAiFetchWebBinary,
  type SpawnedChild,
  type SpawnFn,
} from '../../../../lib/node/pi/research-ai-fetch-web-cli-client.ts';

// ──────────────────────────────────────────────────────────────────────
// Spawn-stub helpers.
// ──────────────────────────────────────────────────────────────────────

interface CapturedCall {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  stdin: string;
}

interface SpawnStubOpts {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  emitError?: Error;
}

/**
 * Build a fake `spawn` that captures the invocation and
 * synchronously emits scripted stdout/close events. Returns the
 * stub plus a mutable `calls` array so the test can inspect what
 * was invoked.
 */
function makeSpawnStub(scripted: SpawnStubOpts | ((i: number) => SpawnStubOpts)): {
  spawn: SpawnFn;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const spawn: SpawnFn = (command, args, options) => {
    const call: CapturedCall = { command, args, stdin: '' };
    if (options && 'env' in options && options.env) call.env = options.env;
    calls.push(call);

    const script = typeof scripted === 'function' ? scripted(i) : scripted;
    i += 1;

    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdinCollector: string[] = [];
    const closeEmitter = new EventEmitter();

    const child: SpawnedChild = {
      stdin: {
        write: (chunk: string) => {
          stdinCollector.push(chunk);
          return true;
        },
        end: () => {
          call.stdin = stdinCollector.join('');
          queueMicrotask(() => {
            if (script.emitError) {
              closeEmitter.emit('error', script.emitError);
              return;
            }
            if (script.stdout.length > 0) stdout.emit('data', Buffer.from(script.stdout));
            if (script.stderr && script.stderr.length > 0) stderr.emit('data', Buffer.from(script.stderr));
            closeEmitter.emit('close', script.exitCode ?? 0, null);
          });
        },
      },
      stdout: {
        on: (event, listener) => {
          stdout.on(event, listener);
        },
      },
      stderr: {
        on: (event, listener) => {
          stderr.on(event, listener);
        },
      },
      on: ((event: 'close' | 'error', listener: (...xs: unknown[]) => void) => {
        closeEmitter.on(event, listener);
      }) as SpawnedChild['on'],
    };
    return child;
  };
  return { spawn, calls };
}

// ──────────────────────────────────────────────────────────────────────
// findAiFetchWebBinary
// ──────────────────────────────────────────────────────────────────────

describe('findAiFetchWebBinary', () => {
  test('honours AI_FETCH_WEB_BIN override when the target exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-fwcli-'));
    const bin = join(dir, 'my-ai-fetch-web');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);

    const out = findAiFetchWebBinary({ env: { AI_FETCH_WEB_BIN: bin, PATH: '' } });

    expect(out).toBe(bin);

    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when AI_FETCH_WEB_BIN points at a missing file', () => {
    const out = findAiFetchWebBinary({ env: { AI_FETCH_WEB_BIN: '/no/such/file', PATH: '' } });

    expect(out).toBeNull();
  });

  test('walks PATH and returns the first hit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-fwcli-'));
    const empty = join(dir, 'empty');
    const filled = join(dir, 'filled');
    mkdirSync(empty, { recursive: true });
    mkdirSync(filled, { recursive: true });
    const bin = join(filled, 'ai-fetch-web');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);

    const out = findAiFetchWebBinary({ env: { PATH: `${empty}:${filled}` } });

    expect(out).toBe(bin);

    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when PATH has no ai-fetch-web', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-fwcli-empty-'));

    const out = findAiFetchWebBinary({ env: { PATH: dir } });

    expect(out).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});

// ──────────────────────────────────────────────────────────────────────
// fetchUrl
// ──────────────────────────────────────────────────────────────────────

describe('createAiFetchWebCliClient.fetchUrl', () => {
  test('spawns ai-fetch-web with the expected argv and parses structuredContent', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({
        content: [{ type: 'text', text: 'prelude...' }],
        structuredContent: {
          articleTitle: 'Example Domain',
          contentType: 'text/html',
          resolvedUrl: 'https://example.com/',
          text: '# Example\n\nBody.',
        },
      }),
    });
    const client = createAiFetchWebCliClient({ bin: '/usr/bin/ai-fetch-web', spawn: stub.spawn });

    const out = await client.fetchUrl({ url: 'https://example.com' });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.command).toBe('/usr/bin/ai-fetch-web');
    expect(stub.calls[0]?.args).toEqual(['--json', '--timeout-ms', '30000', 'fetch', 'https://example.com']);
    expect(out).toEqual({
      content: '# Example\n\nBody.',
      title: 'Example Domain',
      url: 'https://example.com/',
      mediaType: 'text/html',
    });
  });

  test('threads --format through (mapping readability -> markdown)', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ structuredContent: { text: '' } }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    await client.fetchUrl({ url: 'https://x.test', format: 'readability' });

    expect(stub.calls[0]?.args).toContain('--format');
    expect(stub.calls[0]?.args).toContain('markdown');
  });

  test('preserves non-readability format values verbatim', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ structuredContent: { text: '' } }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    await client.fetchUrl({ url: 'https://x.test', format: 'html' });

    const args = stub.calls[0]?.args ?? [];
    const ix = args.indexOf('--format');

    expect(args[ix + 1]).toBe('html');
  });

  test('throws when the CLI exits non-zero, including stderr tail', async () => {
    const stub = makeSpawnStub({
      stdout: '',
      stderr: 'ai-fetch-web: upstream 503',
      exitCode: 3,
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    await expect(client.fetchUrl({ url: 'https://x.test' })).rejects.toThrow(/exit 3.*upstream 503/);
  });

  test('throws when stdout is not JSON', async () => {
    const stub = makeSpawnStub({ stdout: 'not json here' });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    await expect(client.fetchUrl({ url: 'https://x.test' })).rejects.toThrow(/not JSON/);
  });

  test('throws when the MCP result is flagged as an error', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({
        content: [{ type: 'text', text: 'robots.txt denied' }],
        isError: true,
      }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    await expect(client.fetchUrl({ url: 'https://x.test' })).rejects.toThrow(/mcp tool error: robots\.txt denied/);
  });

  test('throws when structuredContent is missing', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ content: [{ type: 'text', text: 'whatever' }] }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    await expect(client.fetchUrl({ url: 'https://x.test' })).rejects.toThrow(/missing structuredContent/);
  });

  test('passes the injected env to the child', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ structuredContent: { text: '' } }),
    });
    const client = createAiFetchWebCliClient({
      bin: 'ai-fetch-web',
      spawn: stub.spawn,
      env: { AI_FETCH_WEB_URL: 'https://llm.test/mcp/', AI_FETCH_WEB_AUTH: 'Basic xyz', PATH: '/usr/bin' },
    });

    await client.fetchUrl({ url: 'https://x.test' });

    expect(stub.calls[0]?.env?.AI_FETCH_WEB_URL).toBe('https://llm.test/mcp/');
    expect(stub.calls[0]?.env?.AI_FETCH_WEB_AUTH).toBe('Basic xyz');
  });

  test('propagates a custom timeoutMs into --timeout-ms', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ structuredContent: { text: '' } }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn, timeoutMs: 120_000 });

    await client.fetchUrl({ url: 'https://x.test' });

    const args = stub.calls[0]?.args ?? [];
    const ix = args.indexOf('--timeout-ms');

    expect(args[ix + 1]).toBe('120000');
  });
});

// ──────────────────────────────────────────────────────────────────────
// convertHtml
// ──────────────────────────────────────────────────────────────────────

describe('createAiFetchWebCliClient.convertHtml', () => {
  test('pipes HTML on stdin, routes to `convert`, returns text', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({
        structuredContent: { format: 'markdown', text: '# Test\n\nHello' },
      }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    const out = await client.convertHtml({ html: '<h1>Test</h1>', baseUrl: 'https://x.test', format: 'text' });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.args).toEqual([
      '--json',
      '--timeout-ms',
      '30000',
      'convert',
      '--html-file',
      '-',
      '--base-url',
      'https://x.test',
      '--format',
      'text',
    ]);
    expect(stub.calls[0]?.stdin).toBe('<h1>Test</h1>');
    expect(out.content).toBe('# Test\n\nHello');
  });

  test('omits optional flags when the caller does not pass them', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ structuredContent: { text: 'ok' } }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    await client.convertHtml({ html: '<p>hi</p>' });

    const args = stub.calls[0]?.args ?? [];

    expect(args).not.toContain('--base-url');
    expect(args).not.toContain('--format');
  });
});

// ──────────────────────────────────────────────────────────────────────
// searchWeb
// ──────────────────────────────────────────────────────────────────────

describe('createAiFetchWebCliClient.searchWeb', () => {
  test('returns structured results in McpSearchResultItem shape', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({
        structuredContent: {
          query: 'rust 1.0 release',
          results: [
            { url: 'https://a.example', title: 'A', snippet: 'aaa' },
            { url: 'https://b.example', title: 'B', snippet: 'bbb' },
          ],
        },
      }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    const out = await client.searchWeb({ query: 'rust 1.0 release', limit: 5 });

    expect(stub.calls[0]?.args).toEqual([
      '--json',
      '--timeout-ms',
      '30000',
      'search',
      'rust 1.0 release',
      '--limit',
      '5',
    ]);
    expect(out.results).toEqual([
      { url: 'https://a.example', title: 'A', snippet: 'aaa' },
      { url: 'https://b.example', title: 'B', snippet: 'bbb' },
    ]);
  });

  test('drops entries without a usable URL', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({
        structuredContent: {
          results: [{ title: 'no-url' }, { url: 'https://ok.example', title: 'ok' }],
        },
      }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    const out = await client.searchWeb({ query: 'q' });

    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.url).toBe('https://ok.example');
  });

  test('returns an empty results list when structuredContent is absent', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ content: [{ type: 'text', text: 'Query: q\nResult Count: 0' }] }),
    });
    const client = createAiFetchWebCliClient({ bin: 'ai-fetch-web', spawn: stub.spawn });

    const out = await client.searchWeb({ query: 'q' });

    expect(out.results).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// extraArgs threading
// ──────────────────────────────────────────────────────────────────────

describe('createAiFetchWebCliClient.extraArgs', () => {
  test('prepends extraArgs ahead of the generated flags', async () => {
    const stub = makeSpawnStub({
      stdout: JSON.stringify({ structuredContent: { text: '' } }),
    });
    const client = createAiFetchWebCliClient({
      bin: 'ai-fetch-web',
      spawn: stub.spawn,
      extraArgs: ['-v'],
    });

    await client.fetchUrl({ url: 'https://x.test' });

    expect(stub.calls[0]?.args).toEqual(['-v', '--json', '--timeout-ms', '30000', 'fetch', 'https://x.test']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// createAiFetchWebCliClientFromEnv
// ──────────────────────────────────────────────────────────────────────

describe('createAiFetchWebCliClientFromEnv', () => {
  test('returns null when no binary is found', () => {
    const out = createAiFetchWebCliClientFromEnv({
      env: { PATH: '' },
      pathEnv: '',
    });

    expect(out).toBeNull();
  });

  test('returns a client when the binary is discoverable on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-fwcli-'));
    const bin = join(dir, 'ai-fetch-web');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);

    const out = createAiFetchWebCliClientFromEnv({
      env: { PATH: dir },
      pathEnv: dir,
    });

    expect(out).not.toBeNull();
    expect(typeof out?.fetchUrl).toBe('function');

    rmSync(dir, { recursive: true, force: true });
  });

  test('respects an explicit bin override even if PATH is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-fwcli-'));
    const bin = join(dir, 'ai-fetch-web');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);

    const out = createAiFetchWebCliClientFromEnv({
      env: { PATH: '' },
      bin,
    });

    expect(out).not.toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});
