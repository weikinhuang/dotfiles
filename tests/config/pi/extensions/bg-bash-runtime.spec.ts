/**
 * Runtime spec for the bg_bash extension shell: loads
 * `config/pi/extensions/bg-bash.ts` against a minimal fake pi, then drives
 * the registered tool's `execute` with real child processes.
 *
 * Covers the two failure modes behind "exit summary says 356B but logs
 * shows 10 bytes":
 *
 *   - output written by a grandchild after the shell exits must be in the
 *     `wait` summary, `logs`, and the on-disk log (finalize on stdio close,
 *     not on bare 'exit');
 *   - a `[wait, logs]` pair issued in ONE parallel tool batch must give the
 *     `logs` call the post-wait state rather than a mid-run snapshot.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import bgBash from '../../../../config/pi/extensions/bg-bash.ts';
import { type JobSummary } from '../../../../lib/node/pi/bg-bash-reducer.ts';

interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: { job?: JobSummary; totalBytes?: number; logExcerpt?: string };
  isError?: boolean;
}

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: undefined,
  onUpdate: undefined,
  ctx: unknown,
) => Promise<ToolResult>;

interface Runtime {
  call: (params: Record<string, unknown>) => Promise<ToolResult>;
  shutdown: () => Promise<void>;
}

function load(dir: string): Runtime {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let execute: Execute | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    registerTool: (definition: { execute: Execute }) => {
      execute = definition.execute;
    },
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    events: { on: () => (): void => undefined },
  } as unknown as ExtensionAPI;
  bgBash(pi);
  const ctx = {
    cwd: dir,
    hasUI: false,
    ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(), input: vi.fn() },
    sessionManager: { getBranch: () => [] },
    isIdle: () => true,
  };
  void handlers.get('session_start')?.({}, ctx);
  let n = 0;
  return {
    call: (params) => execute!(`call-${n++}`, params, undefined, undefined, ctx),
    shutdown: async () => {
      await handlers.get('session_shutdown')?.({}, ctx);
    },
  };
}

const node = JSON.stringify(process.execPath);

async function startId(rt: Runtime, params: Record<string, unknown>): Promise<string> {
  const r = await rt.call({ action: 'start', ...params });
  expect(r.isError).toBeFalsy();
  return r.details.job!.id;
}

describe('bg_bash runtime (real spawn)', () => {
  let dir: string;
  let rt: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bg-bash-runtime-'));
    vi.stubEnv('PI_BG_BASH_DISABLED', '');
    vi.stubEnv('PI_BG_BASH_LOG_DIR', join(dir, 'logs'));
    vi.stubEnv('PI_BG_BASH_DRAIN_MS', '2000');
    vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'));
    rt = load(dir);
  });
  afterEach(async () => {
    await rt.shutdown();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  test('grandchild output after the shell exits is in wait, logs, and the log file', async () => {
    const id = await startId(rt, {
      command: `echo a; ${node} -e 'setTimeout(()=>console.log("b".repeat(5000)),300)' & exit 0`,
    });
    const wait = await rt.call({ action: 'wait', id, timeoutMs: 10_000 });
    expect(wait.content[0].text).toMatch(/^Exited: .* exited 0 after /);
    expect(wait.details.job).toMatchObject({ status: 'exited', stdoutBytes: 5003 });
    expect(wait.details.job?.outputOpen).toBeUndefined();

    const logs = await rt.call({ action: 'logs', id });
    expect(logs.details.totalBytes).toBe(wait.details.job!.stdoutBytes + wait.details.job!.stderrBytes);
    expect(logs.details.logExcerpt).toBe(`a\n${'b'.repeat(5000)}\n`);
    expect(logs.content[0].text).not.toContain('still running');

    await vi.waitFor(() => expect(readFileSync(wait.details.job!.logFile!, 'utf8')).toBe(`a\n${'b'.repeat(5000)}\n`));
  });

  test('[wait, logs] in one parallel batch: logs reports the post-wait state', async () => {
    const id = await startId(rt, { command: "echo '== vitest'; sleep 0.4; echo ' Test Files  1 passed'" });
    // pi starts every execute of a parallel batch in message order, then
    // awaits them together.
    const [wait, logs] = await Promise.all([
      rt.call({ action: 'wait', id, timeoutMs: 10_000 }),
      rt.call({ action: 'logs', id }),
    ]);
    expect(wait.details.job?.status).toBe('exited');
    expect(logs.details.logExcerpt).toBe('== vitest\n Test Files  1 passed\n');
    expect(logs.details.totalBytes).toBe(wait.details.job!.stdoutBytes);
    expect(logs.content[0].text).not.toContain('still running');
  });

  test('logs on a running job is flagged as a partial snapshot', async () => {
    const id = await startId(rt, { command: 'echo first; sleep 5' });
    await vi.waitFor(async () => {
      const logs = await rt.call({ action: 'logs', id });
      expect(logs.details.logExcerpt).toBe('first\n');
      expect(logs.content[0].text).toContain('(job still running - output so far)');
    });
  });

  test('shell: "bash" runs bash-only syntax; sh gets a warning instead', async () => {
    const cmd = 'false | true; echo "rc=${PIPESTATUS[0]}"';
    const id = await startId(rt, { command: cmd, shell: 'bash' });
    await rt.call({ action: 'wait', id, timeoutMs: 10_000 });
    const logs = await rt.call({ action: 'logs', id });
    expect(logs.details.logExcerpt).toBe('rc=1\n');

    const shStart = await rt.call({ action: 'start', command: cmd });
    expect(shStart.content[0].text).toContain('looks bash-only (PIPESTATUS');
    const bashStart = await rt.call({ action: 'start', command: cmd, shell: 'bash' });
    expect(bashStart.content[0].text).not.toContain('Warning');
  });
});
