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

import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import bgBash from '../../../../config/pi/extensions/bg-bash.ts';
import { type JobSummary } from '../../../../lib/node/pi/bg-bash-reducer.ts';
import type { LiveCardRenderContext as ToolRenderContext } from '../../../../lib/node/pi/ext/live-tool-cards.ts';

interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: { job?: JobSummary; totalBytes?: number; logExcerpt?: string };
  isError?: boolean;
}

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: unknown,
) => Promise<ToolResult>;

interface Card {
  result: ToolResult;
  render: (expanded?: boolean, freshState?: boolean) => string;
  invalidate: ReturnType<typeof vi.fn>;
}

interface Runtime {
  call: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
  emit: (name: string, event?: unknown) => unknown;
  idle: (value: boolean) => void;
  command: (args: string) => Promise<void>;
  notify: ReturnType<typeof vi.fn>;
  card: (params: Record<string, unknown>) => Promise<Card>;
  clear: () => Promise<void>;
  tree: () => Promise<void>;
  appendEntry: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  shutdown: () => Promise<void>;
}

interface Renderers {
  execute: Execute;
  renderCall: (args: Record<string, unknown>, theme: Theme, context: ToolRenderContext) => Component;
  renderResult: (
    result: ToolResult,
    options: { expanded: boolean },
    theme: Theme,
    context: ToolRenderContext,
  ) => Component;
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

function load(dir: string, mode = 'tui'): Runtime {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let tool: Renderers;
  let command: (args: string, ctx: unknown) => Promise<void>;
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  let idle = true;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    registerTool: (definition: Renderers) => {
      tool = definition;
    },
    registerCommand: (_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    },
    registerMessageRenderer: vi.fn(),
    appendEntry,
    sendMessage,
    events: { on: () => (): void => undefined },
  } as unknown as ExtensionAPI;
  bgBash(pi);
  const ctx = {
    cwd: dir,
    mode,
    hasUI: mode === 'tui',
    ui: { setStatus: vi.fn(), notify, select: vi.fn(), input: vi.fn() },
    sessionManager: { getBranch: () => [] },
    isIdle: () => idle,
  };
  void handlers.get('session_start')?.({}, ctx);
  let n = 0;
  const card = async (params: Record<string, unknown>, signal?: AbortSignal): Promise<Card> => {
    const invalidate = vi.fn();
    const context = {
      toolCallId: `call-${n++}`,
      state: {},
      args: params,
      executionStarted: false,
      isPartial: false,
      invalidate,
    } as unknown as ToolRenderContext;
    tool.renderCall(params, theme, context);
    context.executionStarted = true;
    const result = await tool.execute(context.toolCallId, params, signal, undefined, ctx);
    return {
      result,
      invalidate,
      render: (expanded = false, freshState = false) => {
        const row = freshState ? { ...context, state: {} } : context;
        // Exports/replayed rows may render the call again, but execution has already started.
        tool.renderCall(params, theme, row);
        return tool
          .renderResult(result, { expanded }, theme, row)
          .render(2000)
          .map((line) => line.trimEnd())
          .join('\n');
      },
    };
  };
  return {
    card,
    call: async (params, signal) => (await card(params, signal)).result,
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    idle: (value) => {
      idle = value;
    },
    command: (args) => command(args, ctx),
    notify,
    clear: async () => {
      await command('clear', ctx);
    },
    tree: async () => {
      await handlers.get('session_tree')?.({}, ctx);
    },
    appendEntry,
    sendMessage,
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

  test('only the original START card follows output and completion without rewriting results or history', async () => {
    const card = await rt.card({
      action: 'start',
      interactiveStdin: true,
      command:
        'while IFS= read -r line; do [ "$line" = done ] && exit 7; printf "%s\\n" "$line"; printf "err:%s\\n" "$line" >&2; done',
    });
    const id = card.result.details.job!.id;
    const original = JSON.stringify(card.result);
    expect(card.render()).toContain('running');
    expect(card.render(true)).toContain(`cwd ${dir}`);
    const historical = card.render(false, true);
    const status = await rt.card({ action: 'status', id });
    const logs = await rt.card({ action: 'logs', id });
    const wait = await rt.card({ action: 'wait', id, timeoutMs: 1 });
    const list = await rt.card({ action: 'list' });
    const snapshots = [status, logs, wait, list].map((row) => row.render());

    await rt.call({ action: 'stdin', id, text: `${'x'.repeat(1000)}recent-output\n` });
    const entries = rt.appendEntry.mock.calls.length;
    const messages = rt.sendMessage.mock.calls.length;
    card.invalidate.mockClear();
    await vi.waitFor(() => expect(card.invalidate).toHaveBeenCalled(), { timeout: 1500 });
    expect(card.render()).toContain('stdout:');
    expect(card.render()).toContain('stderr:');
    expect(card.render()).toContain('recent-output');
    expect(card.render().length).toBeLessThan(800);
    expect(rt.appendEntry).toHaveBeenCalledTimes(entries);
    expect(rt.sendMessage).toHaveBeenCalledTimes(messages);
    expect(card.render(false, true)).toBe(historical);

    card.invalidate.mockClear();
    await rt.call({ action: 'stdin', id, text: 'done\n' });
    // No status/wait call is needed to update the original result row.
    await vi.waitFor(() => expect(card.invalidate).toHaveBeenCalled());
    expect(card.render()).toContain('exit 7');
    expect(JSON.stringify(card.result)).toBe(original);
    expect([status, logs, wait, list].map((row) => row.render())).toEqual(snapshots);
    expect([status, logs, wait, list].every((row) => row.invalidate.mock.calls.length === 0)).toBe(true);
    const terminal = card.render();
    await rt.call({ action: 'remove', id });
    expect(card.render()).toBe(terminal);
    expect(card.render(false, true)).toBe(historical);
    card.invalidate.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(card.invalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(card.result)).toBe(original);
  });

  test('expansion reveals a full short command without changing the collapsed card or tool result', async () => {
    const command = `# ${'header-preview '.repeat(8).trimEnd()}\n# full-command-detail\nread line`;
    const card = await rt.card({ action: 'start', command, interactiveStdin: true });
    const original = JSON.stringify(card.result);
    const collapsed = card.render();
    const entries = rt.appendEntry.mock.calls.length;
    const messages = rt.sendMessage.mock.calls.length;
    expect(collapsed).not.toContain('full-command-detail');
    expect(card.render(true)).toContain(`command:\n${command}`);
    expect(card.render()).toBe(collapsed);
    expect(card.render(true, true)).toContain(`command:\n${command}`);
    expect(JSON.stringify(card.result)).toBe(original);
    expect(rt.appendEntry).toHaveBeenCalledTimes(entries);
    expect(rt.sendMessage).toHaveBeenCalledTimes(messages);
  });

  test('expanded command snippets stop after eight rows with an explicit truncation notice', async () => {
    const command = [...Array.from({ length: 20 }, (_, i) => `# command-line-${i}`), 'read line'].join('\n');
    const card = await rt.card({ action: 'start', command, interactiveStdin: true });
    const expanded = card.render(true);
    expect(expanded).toContain('# command-line-7');
    expect(expanded).not.toContain('# command-line-19');
    expect(expanded).toContain('more lines');
  });

  test('terminal START data survives clear, while tree navigation restores historical rendering', async () => {
    const card = await rt.card({ action: 'start', command: 'read line; echo cleared', interactiveStdin: true });
    const id = card.result.details.job!.id;
    card.render();
    await rt.call({ action: 'stdin', id, text: 'go\n' });
    await vi.waitFor(() => expect(card.invalidate).toHaveBeenCalled());
    const terminal = card.render();
    expect(terminal).toContain('exit 0');
    expect(terminal).toContain('stdout: cleared');
    await rt.clear();
    expect(card.render()).toBe(terminal);
    await rt.tree();
    expect(card.render()).toBe(card.render(false, true));
    expect(card.render()).not.toContain('stdout: cleared');
  });

  test('shutdown stops original-card invalidation before child teardown', async () => {
    const card = await rt.card({ action: 'start', command: 'read line', interactiveStdin: true });
    card.render();
    card.invalidate.mockClear();
    await rt.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(card.invalidate).not.toHaveBeenCalled();
    expect(card.render()).toBe(card.render(false, true));
  });

  test('signaled-without-endedAt stays live until the process actually finishes', async () => {
    const card = await rt.card({
      action: 'start',
      interactiveStdin: true,
      command: `exec ${node} -e 'process.on("SIGTERM",()=>setTimeout(()=>{console.log("signal-drained");process.exit(0)},800)); console.log("ready"); process.stdin.resume()'`,
    });
    const id = card.result.details.job!.id;
    await vi.waitFor(() => expect(card.render()).toContain('stdout: ready'));
    const signal = await rt.call({ action: 'signal', id });
    expect(signal.details.job?.endedAt).toBeUndefined();
    card.render();
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(card.render()).not.toContain('signal-drained');
    await vi.waitFor(
      () => {
        expect(card.render()).toContain('signal-drained');
        expect(card.render()).toContain('exit 0');
      },
      { timeout: 2000 },
    );
  });

  test('an outputOpen START card keeps following late bytes until the inherited pipe closes', async () => {
    vi.stubEnv('PI_BG_BASH_DRAIN_MS', '10');
    await rt.shutdown();
    rt = load(dir);
    const card = await rt.card({
      action: 'start',
      interactiveStdin: true,
      command: `read line; ${node} -e 'setTimeout(()=>console.log("late-pipe-output"),900)' & exit 0`,
    });
    const id = card.result.details.job!.id;
    card.render();
    await rt.call({ action: 'stdin', id, text: 'go\n' });
    await vi.waitFor(() => expect(card.render()).toContain('output pipe still open'));
    card.invalidate.mockClear();
    await vi.waitFor(() => expect(card.invalidate).toHaveBeenCalled(), { timeout: 1500 });
    await vi.waitFor(() => expect(card.render()).toContain('stdout: late-pipe-output'), { timeout: 2000 });
    expect(card.render()).not.toContain('output pipe still open');
    const terminal = card.render();
    await rt.call({ action: 'remove', id });
    expect(card.render()).toBe(terminal);
  });

  test('non-TUI execution never attaches live START rendering', async () => {
    await rt.shutdown();
    rt = load(dir, 'rpc');
    const card = await rt.card({ action: 'start', command: 'read line; echo rpc-output', interactiveStdin: true });
    const historical = card.render();
    const id = card.result.details.job!.id;
    await rt.call({ action: 'stdin', id, text: 'go\n' });
    await rt.call({ action: 'wait', id, timeoutMs: 2000 });
    expect(card.render()).toBe(historical);
    expect(card.invalidate).not.toHaveBeenCalled();
  });

  test('busy completions batch at the boundary, preserving other extensions drafts', async () => {
    rt.idle(false);
    const first = await startId(rt, { command: 'echo first; exit 1', nudge: true });
    await rt.call({ action: 'wait', id: first, timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const second = await startId(rt, { command: 'echo second', nudge: true });
    await rt.call({ action: 'wait', id: second, timeoutMs: 2000 });
    expect(rt.sendMessage).not.toHaveBeenCalled();
    const existing = { type: 'custom', customType: 'other-extension', data: {} };
    const boundary = rt.emit('agent_before_settle', { outcome: 'completed', entries: [existing] }) as {
      entries: { type: string; customType: string; content?: string; details?: { jobs: JobSummary[] } }[];
      continue: boolean;
    };
    expect(boundary.continue).toBe(true);
    expect(boundary.entries[0]).toEqual(existing);
    expect(boundary.entries[1].details?.jobs.map((job) => job.id)).toEqual([first, second]);
    expect(boundary.entries[1].content).toContain('✗');
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });

  test.each(['status', 'wait', 'logs', 'list'])(
    'delivered terminal %s suppresses an already-pending nudge',
    async (action) => {
      rt.idle(false);
      const id = await startId(rt, { command: 'echo completed; exit 1', nudge: true });
      await rt.call({ action: 'wait', id, timeoutMs: 2000 });
      const delivered = await rt.call({ action, id });
      expect(delivered.content[0].text).toContain('exited 1');
      rt.emit('message_end', { message: { role: 'toolResult', toolName: 'bg_bash', ...delivered } });
      expect(rt.emit('agent_before_settle', { outcome: 'completed', entries: [] })).toBeUndefined();
      rt.idle(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(rt.sendMessage).not.toHaveBeenCalled();
    },
  );

  test('running logs and live cards do not acknowledge an eventual failure', async () => {
    rt.idle(false);
    const card = await rt.card({
      action: 'start',
      command: 'read line; echo failure; exit 2',
      interactiveStdin: true,
      nudge: true,
    });
    const id = card.result.details.job!.id;
    const logs = await rt.call({ action: 'logs', id });
    rt.emit('message_end', { message: { role: 'toolResult', toolName: 'bg_bash', ...logs } });
    card.render();
    await rt.call({ action: 'stdin', id, text: 'finish\n' });
    await rt.call({ action: 'wait', id, timeoutMs: 2000 });
    expect(card.render()).toContain('exit 2');
    const boundary = rt.emit('agent_before_settle', { outcome: 'completed', entries: [] });
    expect(JSON.stringify(boundary)).toContain('exited 2');
  });

  test('clear cancels pending nudges, releases buffers, and includes finalized signaled jobs', async () => {
    rt.idle(false);
    const id = await startId(rt, { command: 'read line', interactiveStdin: true, nudge: true });
    await rt.call({ action: 'signal', id });
    await vi.waitFor(async () => expect((await rt.call({ action: 'status', id })).details.job?.endedAt).toBeDefined());
    await rt.clear();
    await rt.command(`logs ${id}`);
    expect(rt.notify).toHaveBeenLastCalledWith(expect.stringContaining('No live job'), 'warning');
    expect(rt.emit('agent_before_settle', { outcome: 'completed', entries: [] })).toBeUndefined();
    expect((await rt.call({ action: 'status', id })).isError).toBe(true);
  });

  test('removed output-open jobs finish disk logging without resurrection or notifications', async () => {
    vi.stubEnv('PI_BG_BASH_DRAIN_MS', '10');
    await rt.shutdown();
    rt = load(dir);
    rt.idle(false);
    const id = await startId(rt, {
      command: `echo first; ${node} -e 'setTimeout(()=>console.log("late output"),350)' & exit 0`,
      nudge: true,
    });
    const finished = await rt.call({ action: 'wait', id, timeoutMs: 2000 });
    expect(finished.details.job?.outputOpen).toBe(true);
    await rt.call({ action: 'remove', id });
    await vi.waitFor(() => expect(readFileSync(finished.details.job!.logFile!, 'utf8')).toContain('late output'));
    expect((await rt.call({ action: 'status', id })).isError).toBe(true);
    expect(rt.emit('agent_before_settle', { outcome: 'completed', entries: [] })).toBeUndefined();
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });

  test('failed idle delivery retries once, retains pending outcomes, and warns locally', async () => {
    rt.idle(false);
    rt.sendMessage.mockImplementation(() => {
      throw new Error('delivery rejected');
    });
    const id = await startId(rt, { command: 'exit 1', nudge: true });
    await rt.call({ action: 'wait', id, timeoutMs: 2000 });
    rt.idle(true);
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(rt.sendMessage).toHaveBeenCalledTimes(2);
    expect(rt.notify).toHaveBeenCalledWith(expect.stringContaining('remain pending'), 'warning');
    rt.emit('input', { source: 'interactive' });
    rt.idle(false);
    expect(JSON.stringify(rt.emit('agent_before_settle', { outcome: 'completed', entries: [] }))).toContain('exited 1');
  });

  test('a cancelled wait never acknowledges the later failure', async () => {
    rt.idle(false);
    const id = await startId(rt, { command: 'read line; exit 1', interactiveStdin: true, nudge: true });
    const controller = new AbortController();
    const waiting = rt.call({ action: 'wait', id, timeoutMs: 2000 }, controller.signal);
    controller.abort();
    const cancelled = await waiting;
    rt.emit('message_end', { message: { role: 'toolResult', toolName: 'bg_bash', ...cancelled } });
    await rt.call({ action: 'stdin', id, text: 'finish\n' });
    await rt.call({ action: 'wait', id, timeoutMs: 2000 });
    expect(JSON.stringify(rt.emit('agent_before_settle', { outcome: 'completed', entries: [] }))).toContain('exited 1');
  });

  test('wait removes its abort listener when a job exits before timeout', async () => {
    const id = await startId(rt, { command: 'read line', interactiveStdin: true });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = rt.call({ action: 'wait', id, timeoutMs: 2000 }, controller.signal);
    await rt.call({ action: 'stdin', id, text: 'done\n' });
    await waiting;
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]?.[1]);
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
