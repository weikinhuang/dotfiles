/**
 * Tests for lib/node/pi/hooks/runner.ts.
 *
 * The runner takes a `HookSpawnFn` so every branch of the
 * spawn/parse/decision pipeline can be exercised without touching
 * `child_process`. The real `nodeChildProcessSpawn` is covered
 * indirectly by an integration test that runs a tiny `sh -c` script.
 */

import { describe, expect, test, vi } from 'vitest';

import { type Hook } from '../../../../../lib/node/pi/hooks/config.ts';
import {
  type HookSpawnFn,
  type HookSpawnOptions,
  type HookSpawnResult,
  nodeChildProcessSpawn,
  parseHookStdout,
  runHook,
  STREAM_BUFFER_MAX,
} from '../../../../../lib/node/pi/hooks/runner.ts';

function makeHook(over: Partial<Hook> = {}): Hook {
  return { command: '/h.sh', scope: 'user', ...over };
}

function stubSpawn(result: Partial<HookSpawnResult>): HookSpawnFn {
  const full: HookSpawnResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
    ...result,
  };
  return (): Promise<HookSpawnResult> => Promise.resolve(full);
}

describe('parseHookStdout', () => {
  test('empty stdout → continue', () => {
    expect(parseHookStdout('')).toEqual({ decision: 'continue' });
    expect(parseHookStdout('   \n  ')).toEqual({ decision: 'continue' });
  });

  test('JSON decision parses every field', () => {
    const parsed = parseHookStdout(JSON.stringify({ decision: 'block', reason: 'no', additionalContext: 'ctx' }));
    expect(parsed).toEqual({ decision: 'block', reason: 'no', additionalContext: 'ctx' });
  });

  test('JSON without decision defaults to continue but keeps additionalContext', () => {
    const parsed = parseHookStdout(JSON.stringify({ additionalContext: 'hi' }));
    expect(parsed).toEqual({ decision: 'continue', additionalContext: 'hi' });
  });

  test('JSON with unrecognized decision string defaults to continue', () => {
    const parsed = parseHookStdout(JSON.stringify({ decision: 'maybe' }));
    expect(parsed).toEqual({ decision: 'continue' });
  });

  test('non-JSON stdout falls through as additionalContext', () => {
    const parsed = parseHookStdout('plain text from the hook\n');
    expect(parsed).toEqual({ decision: 'continue', additionalContext: 'plain text from the hook\n' });
  });

  test('JSON-shaped scalar / array also falls through as additionalContext', () => {
    expect(parseHookStdout('42')).toEqual({ decision: 'continue', additionalContext: '42' });
    expect(parseHookStdout('[1,2]')).toEqual({ decision: 'continue', additionalContext: '[1,2]' });
  });
});

describe('runHook', () => {
  test('happy path: spawn returns JSON decision, runner forwards it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const hook = makeHook();
      const stdout = JSON.stringify({ decision: 'allow', reason: 'ok' });
      const result = await runHook({
        hook,
        payload: { event: 'PreToolUse', tool: 'bash' },
        signal: new AbortController().signal,
        cwd: '/cwd',
        spawnFn: stubSpawn({ stdout }),
      });
      expect(result).toEqual({ decision: 'allow', reason: 'ok' });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('happy path: text stdout becomes additionalContext / continue', async () => {
    const result = await runHook({
      hook: makeHook(),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn: stubSpawn({ stdout: 'observability note' }),
    });
    expect(result).toEqual({ decision: 'continue', additionalContext: 'observability note' });
  });

  test('empty stdout → continue', async () => {
    const result = await runHook({
      hook: makeHook(),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn: stubSpawn({ stdout: '' }),
    });
    expect(result).toEqual({ decision: 'continue' });
  });

  test('timeout: returns block + timedOut + warning fired', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const hook = makeHook({ timeout: 50 });
      const opts: HookSpawnOptions[] = [];
      const spawnFn: HookSpawnFn = (o) => {
        opts.push(o);
        return Promise.resolve({ stdout: '', stderr: '', exitCode: null, timedOut: true, truncated: false });
      };
      const result = await runHook({
        hook,
        payload: {},
        signal: new AbortController().signal,
        cwd: '/cwd',
        spawnFn,
      });
      expect(result.decision).toBe('block');
      expect(result.timedOut).toBe(true);
      expect(result.reason).toContain('50ms');
      expect(opts).toHaveLength(1);
      expect(opts[0].timeoutMs).toBe(50);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('timed out');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('non-zero exit: returns block with stderr as reason', async () => {
    const result = await runHook({
      hook: makeHook(),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn: stubSpawn({ exitCode: 2, stderr: 'oh no\n' }),
    });
    expect(result).toEqual({ decision: 'block', reason: 'oh no' });
  });

  test('flags truncation from the spawn result onto the HookResult (success path)', async () => {
    const result = await runHook({
      hook: makeHook(),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn: stubSpawn({ stdout: 'note', truncated: true }),
    });
    expect(result).toEqual({ decision: 'continue', additionalContext: 'note', truncated: true });
  });

  test('flags truncation on a non-zero-exit block result', async () => {
    const result = await runHook({
      hook: makeHook(),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn: stubSpawn({ exitCode: 1, stderr: 'boom', truncated: true }),
    });
    expect(result).toEqual({ decision: 'block', reason: 'boom', truncated: true });
  });

  test('non-zero exit with empty stderr falls back to a generic reason', async () => {
    const result = await runHook({
      hook: makeHook(),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn: stubSpawn({ exitCode: 7, stderr: '' }),
    });
    expect(result).toEqual({ decision: 'block', reason: 'hook exited with code 7' });
  });

  test('spawn throws → block with the error message and a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const spawnFn: HookSpawnFn = () => Promise.reject(new Error('ENOENT: no such file'));
      const result = await runHook({
        hook: makeHook(),
        payload: {},
        signal: new AbortController().signal,
        cwd: '/cwd',
        spawnFn,
      });
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('ENOENT');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('payload is JSON-serialized exactly once and forwarded to spawn', async () => {
    const observed: string[] = [];
    const spawnFn: HookSpawnFn = (o) => {
      observed.push(o.payload);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false });
    };
    await runHook({
      hook: makeHook(),
      payload: { event: 'Stop', cwd: '/x' },
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn,
    });
    expect(observed).toEqual([JSON.stringify({ event: 'Stop', cwd: '/x' })]);
  });

  test('hook.timeout falls back to opts.defaultTimeoutMs, then DEFAULT_TIMEOUT_MS', async () => {
    const observed: HookSpawnOptions[] = [];
    const spawnFn: HookSpawnFn = (o) => {
      observed.push(o);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false });
    };
    await runHook({
      hook: makeHook(),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn,
      defaultTimeoutMs: 1234,
    });
    expect(observed[0].timeoutMs).toBe(1234);

    await runHook({
      hook: makeHook({ timeout: 5000 }),
      payload: {},
      signal: new AbortController().signal,
      cwd: '/cwd',
      spawnFn,
      defaultTimeoutMs: 1234,
    });
    expect(observed[1].timeoutMs).toBe(5000);
  });
});

describe('nodeChildProcessSpawn (smoke)', () => {
  test('runs a real sh -c command and captures stdout', async () => {
    const ac = new AbortController();
    const res = await nodeChildProcessSpawn({
      command: 'cat',
      payload: 'hello world',
      timeoutMs: 5000,
      signal: ac.signal,
      cwd: process.cwd(),
      sandboxed: false,
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe('hello world');
  });

  test('non-zero exit code is propagated', async () => {
    const ac = new AbortController();
    const res = await nodeChildProcessSpawn({
      command: 'exit 3',
      payload: '',
      timeoutMs: 5000,
      signal: ac.signal,
      cwd: process.cwd(),
      sandboxed: false,
    });
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });

  test('caps stdout at STREAM_BUFFER_MAX and flags truncation', async () => {
    // Regression: a flooding hook previously accumulated its whole
    // output in memory. Emit well over the cap and assert it is bounded.
    const ac = new AbortController();
    const bytes = STREAM_BUFFER_MAX * 4;
    const res = await nodeChildProcessSpawn({
      command: `head -c ${bytes} /dev/zero | tr '\\0' 'a'`,
      payload: '',
      timeoutMs: 5000,
      signal: ac.signal,
      cwd: process.cwd(),
      sandboxed: false,
    });
    expect(res.exitCode).toBe(0);
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBe(STREAM_BUFFER_MAX);
  });
});
