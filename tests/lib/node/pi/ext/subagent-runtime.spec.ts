import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  registerSubagentInjection,
  unregisterSubagentInjection,
} from '../../../../../lib/node/pi/subagent/extension-injection.ts';

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Result {
  content: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}
interface RunDetails {
  handle: string;
  stopReason: string;
  turns: number;
  tokens: { input: number; output: number };
  childSessionFile?: string;
}

// Only provider entry points are replaced. Resource discovery, extension loading,
// tool wrapping, child creation, subscriptions, and session disposal are real SDK code.
describe('subagent actual SDK runtime (provider-free)', () => {
  let root: string;
  let cwd: string;
  let parent: AgentSession;
  let children: Set<AgentSession>;
  let gates: Gate[];
  let pending: Promise<unknown>[];
  let worktreeDirs: string[];
  let promptImpl: (
    session: AgentSession,
    text: string,
    options?: Parameters<AgentSession['prompt']>[1],
  ) => Promise<void>;
  let abortImpl: (session: AgentSession) => Promise<void>;
  let model: NonNullable<AgentSession['model']>;
  let disposeSpy: MockInstance<AgentSession['dispose']>;

  function gate(): Gate {
    const value = deferred();
    gates.push(value);
    return value;
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise);
    return promise;
  }

  function emit(session: AgentSession, event: AgentSessionEvent): void {
    // SDK subscribe() listeners are intentionally used rather than a fake event bus.
    (session as unknown as { _emit(event: AgentSessionEvent): void })._emit(event);
  }

  function finish(session: AgentSession, text = 'review complete', toolCall = false): void {
    const message: AssistantMessage = {
      role: 'assistant',
      content: toolCall
        ? [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'file' } }]
        : [{ type: 'text', text }],
      api: model.api as AssistantMessage['api'],
      provider: model.provider,
      model: model.id,
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 23,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: toolCall ? 'toolUse' : 'stop',
      timestamp: 1,
    };
    session.agent.state.messages = [...session.agent.state.messages, message];
    emit(session, { type: 'message_end', message });
    emit(session, { type: 'turn_end', message, toolResults: [] });
    emit(session, { type: 'agent_end', messages: [message], willRetry: false });
  }

  function tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const actual = parent.agent.state.tools.find((entry) => entry.name === name);
    if (!actual) throw new Error(`Missing actual SDK tool ${name}`);
    return track(actual.execute(`test-${pending.length}`, args, signal) as Promise<Result>);
  }

  function spawn(task: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Result> {
    return tool('subagent', { agent: 'review', task, ...extra }, signal);
  }

  function details(result: Result): RunDetails {
    return result.details as RunDetails;
  }

  function send(handle: string, action: string, extra: Record<string, unknown> = {}): Promise<Result> {
    return tool('subagent_send', { to: handle, action, ...extra });
  }

  function writeAgent(tools = ['read'], extra = ''): void {
    writeFileSync(
      join(cwd, '.pi/agents/review.md'),
      `---\nname: review\ndescription: deterministic runtime review\nmodel: inherit\ntools: [${tools.join(', ')}]\ntimeoutMs: 60000\n${extra}\n---\nReview the task.\n`,
    );
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'subagent-sdk-'));
    cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    mkdirSync(join(cwd, '.pi/agents'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    children = new Set();
    gates = [];
    pending = [];
    worktreeDirs = [];
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PI_SUBAGENT_')) vi.stubEnv(key, '');
    }
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    vi.stubEnv('PI_SUBAGENT_CONCURRENCY', '1');
    vi.stubEnv('PI_SUBAGENT_BG_SHUTDOWN_MS', '1000');
    // Any accidental provider/network request is a test failure, never a paid call.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network forbidden in subagent runtime spec');
      }),
    );
    writeAgent();
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), refreshOnCreate: false });
    model = runtime.getModels()[0];
    if (!model) throw new Error('SDK static model catalog is empty');
    promptImpl = async (session) => {
      finish(session);
    };
    abortImpl = async () => {
      /* No real provider operation to abort. */
    };
    vi.spyOn(AgentSession.prototype, 'prompt').mockImplementation(function (this: AgentSession, text, options) {
      children.add(this);
      return track(promptImpl(this, text, options));
    });
    vi.spyOn(AgentSession.prototype, 'abort').mockImplementation(function (this: AgentSession) {
      return track(abortImpl(this));
    });
    disposeSpy = vi.spyOn(AgentSession.prototype, 'dispose');
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [resolve('config/pi/extensions/subagent.ts')],
    });
    await loader.reload();
    const errors = loader.getExtensions().errors;
    if (errors.length > 0) throw new Error(`Extension load failed: ${JSON.stringify(errors)}`);
    ({ session: parent } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
      customTools: [
        {
          name: 'custom_probe',
          label: 'Custom probe',
          description: 'Parent-only custom tool',
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: 'probe' }], details: undefined }),
        },
      ],
    }));
    await parent.bindExtensions({ mode: 'print' });
    // Own every timeout, including regression paths that return before draining.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    unregisterSubagentInjection('runtime-security-probe');
    for (const value of gates) value.resolve();
    await Promise.allSettled(pending);
    if (parent) {
      await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      parent.dispose();
    }
    for (const child of children) child.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const dir of worktreeDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test('foreground completion preserves answer/usage and can be retrieved with status and wait', async () => {
    const result = await spawn('foreground');
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'review complete' }]);
    expect(details(result)).toMatchObject({ stopReason: 'completed', turns: 1, tokens: { input: 11, output: 7 } });
    const handle = details(result).handle;
    expect(details(await send(handle, 'status')).stopReason).toBe('completed');
    expect((await send(handle, 'wait')).content).toEqual(result.content);
    expect(disposeSpy.mock.instances).toContain([...children][0]);
  });

  test('background status, steering, and wait use the actual registered tools', async () => {
    const started = gate();
    const release = gate();
    const steering: unknown[] = [];
    promptImpl = async (session, text, options) => {
      if (options?.streamingBehavior === 'steer') {
        steering.push({ text, options });
        return;
      }
      started.resolve();
      await release.promise;
      finish(session, 'background answer');
    };
    const result = await spawn('background', { run_in_background: true });
    await started.promise;
    const handle = details(result).handle;
    expect(details(result).stopReason).toBe('spawned');
    expect(details(await send(handle, 'status')).stopReason).toBe('running');
    expect((await tool('subagent_send', { to: handle, text: 'focus on tests' })).isError).toBe(false);
    expect(steering).toHaveLength(1);
    expect(steering[0]).toMatchObject({ text: 'focus on tests', options: { streamingBehavior: 'steer' } });
    let settled = false;
    const wait = send(handle, 'wait').then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    const final = await wait;
    expect(final.isError).toBe(false);
    expect(final.content).toEqual([{ type: 'text', text: 'background answer' }]);
    expect(details(final).stopReason).toBe('completed');
  });

  test.each([false, true])(
    'natural text-only final at maxTurns=1 is successful (background=%s)',
    async (background) => {
      const result = await spawn('one natural turn', { maxTurns: 1, run_in_background: background });
      const final = background ? await send(details(result).handle, 'wait') : result;
      expect(final.isError).toBe(false);
      expect(details(final).stopReason).toBe('completed');
      expect(final.content).toEqual([{ type: 'text', text: 'review complete' }]);
    },
  );

  test('maxTurns still stops a tool-calling continuation', async () => {
    promptImpl = async (session) => {
      finish(session, '', true);
    };
    const result = await spawn('tool continuation', { maxTurns: 1 });
    expect(result.isError).toBe(true);
    expect(details(result).stopReason).toBe('max_turns');
  });

  test('wait removes its abort listener on completion without cancelling the child', async () => {
    const release = gate();
    promptImpl = async (session) => {
      await release.promise;
      finish(session);
    };
    const spawned = await spawn('wait listener', { run_in_background: true });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = tool('subagent_send', { to: details(spawned).handle, action: 'wait' }, controller.signal);
    await Promise.resolve();
    release.resolve();
    expect((await waiting).isError).toBe(false);
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]?.[1]);
    controller.abort();
    expect(details(await send(details(spawned).handle, 'status')).stopReason).toBe('completed');
  });

  test('an explicit abort has a bounded wait even when the child ignores it', async () => {
    const release = gate();
    promptImpl = async (session) => {
      await release.promise;
      finish(session);
    };
    abortImpl = () => release.promise;
    const spawned = await spawn('stalled abort', { run_in_background: true });
    const aborting = send(details(spawned).handle, 'abort');
    await vi.advanceTimersByTimeAsync(1500);
    expect((await aborting).isError).toBe(false);
    release.resolve();
    expect(details(await send(details(spawned).handle, 'wait')).stopReason).toBe('aborted');
  });

  test.each([false, true])('a pre-aborted call never prompts a child (background=%s)', async (background) => {
    const controller = new AbortController();
    controller.abort();
    const result = await spawn('already cancelled', { run_in_background: background }, controller.signal);
    expect(children.size).toBe(0);
    expect(result.isError).toBe(true);
    expect(details(result).stopReason).toBe('aborted');
  });

  test('a cancelled semaphore waiter never prompts after the held background child completes', async () => {
    const release = gate();
    const prompted: string[] = [];
    promptImpl = async (session, text) => {
      prompted.push(text);
      if (text === 'held') await release.promise;
      finish(session);
    };
    const held = await spawn('held', { run_in_background: true });
    const controller = new AbortController();
    const queued = spawn('cancelled waiter', {}, controller.signal);
    controller.abort();
    release.resolve();
    await send(details(held).handle, 'wait');
    const result = await queued;
    expect(prompted).toEqual(['held']);
    expect(result.isError).toBe(true);
    expect(details(result).stopReason).toBe('aborted');
  });

  test('abort during asynchronous resource setup prevents the first child prompt', async () => {
    const entered = gate();
    const release = gate();
    const descriptor: TypedPropertyDescriptor<DefaultResourceLoader['reload']> | undefined =
      Object.getOwnPropertyDescriptor(DefaultResourceLoader.prototype, 'reload');
    const originalReload = descriptor?.value;
    if (!originalReload) throw new Error('Missing original loader implementation');
    vi.spyOn(DefaultResourceLoader.prototype, 'reload').mockImplementation(async function (
      this: DefaultResourceLoader,
    ) {
      entered.resolve();
      await release.promise;
      return originalReload.call(this);
    });
    const controller = new AbortController();
    const running = spawn('cancel during setup', {}, controller.signal);
    await entered.promise;
    controller.abort();
    release.resolve();
    const result = await running;
    expect(children.size).toBe(0);
    expect(result.isError).toBe(true);
    expect(details(result).stopReason).toBe('aborted');
  });

  test('shutdown awaits delayed abort, prompt settlement, and disposal within its deadline', async () => {
    const release = gate();
    const abortEntered = gate();
    const promptDone = gate();
    let child!: AgentSession;
    promptImpl = async (session) => {
      child = session;
      await promptDone.promise;
      finish(session);
    };
    abortImpl = async () => {
      abortEntered.resolve();
      await release.promise;
      promptDone.resolve();
    };
    const spawned = await spawn('shutdown child', { run_in_background: true });
    expect(details(spawned).stopReason).toBe('spawned');
    expect(child).toBeDefined();
    let shutdownSettled = false;
    let disposedAtShutdown = false;
    const shutdown = track(
      parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }).then(() => {
        shutdownSettled = true;
        disposedAtShutdown = disposeSpy.mock.instances.includes(child);
      }),
    );
    await Promise.race([abortEntered.promise, shutdown]);
    // Flush microtasks without advancing the fake shutdown deadline.
    await setImmediate();
    const returnedBeforeDrain = shutdownSettled;
    release.resolve();
    await shutdown;
    expect.soft(returnedBeforeDrain).toBe(false);
    expect(disposedAtShutdown).toBe(true);
  });

  test('a parent custom tool requested by an agent fails actionably instead of silently dropping it', async () => {
    expect(parent.getActiveToolNames()).toContain('custom_probe');
    writeAgent(['read', 'custom_probe']);
    await parent.bindExtensions({ mode: 'print' });
    const result = await spawn('requires custom tool');
    expect(result.isError).toBe(true);
    expect(details(result).stopReason).toBe('error');
    expect(JSON.stringify(result)).toMatch(/custom_probe/);
    expect(JSON.stringify(result)).toMatch(/unsupported|custom tool|built.?in|cannot.*inherit/i);
    expect(children.size).toBe(0);
  });

  test.each(['text', 'json'])('worktree recovery preserves the %s result contract', async (returnFormat) => {
    const git = (...args: string[]): void => {
      execFileSync('git', args, {
        cwd,
        stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    };
    git('init', '-q');
    writeFileSync(join(cwd, 'base.txt'), 'base');
    git('add', 'base.txt');
    git('-c', 'user.name=tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'base');
    writeAgent(['read'], 'isolation: worktree');
    await parent.bindExtensions({ mode: 'print' });
    let childCwd = '';
    promptImpl = async (session) => {
      childCwd = session.sessionManager.getCwd();
      expect(childCwd).not.toBe(cwd);
      worktreeDirs.push(dirname(childCwd));
      writeFileSync(join(childCwd, 'child-work.txt'), 'recover this change');
      finish(session, '{"ok":true}');
    };
    const result = await spawn('worktree recovery', { returnFormat });
    expect(result.isError).toBe(false);
    expect(existsSync(join(childCwd, 'child-work.txt'))).toBe(true);
    expect(result.details).toMatchObject({
      workspace: { isolation: 'worktree', worktreePath: childCwd, worktreePreserved: true },
    });
    const answer = result.content[0]?.text ?? '';
    expect(answer.startsWith('{"ok":true}')).toBe(true);
    expect(answer.includes(`Child workspace preserved at ${childCwd}`)).toBe(returnFormat === 'text');
    expect(answer === '{"ok":true}').toBe(returnFormat === 'json');
  });

  test('agent denial happens before injected approval or sandbox hooks', async () => {
    writeAgent(['bash'], 'bashDeny: [rm]');
    await parent.bindExtensions({ mode: 'print' });
    const injected = vi.fn();
    registerSubagentInjection('runtime-security-probe', (pi: ExtensionAPI) => {
      pi.on('tool_call', () => {
        injected();
      });
    });
    let decision: unknown;
    promptImpl = async (session) => {
      decision = await session.extensionRunner.emitToolCall({
        type: 'tool_call',
        toolCallId: 'denied-call',
        toolName: 'bash',
        input: { command: 'rm example' },
      });
      finish(session);
    };
    await spawn('denied command');
    expect(decision).toMatchObject({ block: true });
    expect(injected).not.toHaveBeenCalled();
  });

  test('fork inherits history but retains the default-tool and no-recursion contracts', async () => {
    parent.sessionManager.appendMessage({ role: 'user', content: 'parent-only context marker', timestamp: 1 });
    let inherited: unknown;
    let tools: string[] = [];
    let receivedTask = '';
    promptImpl = async (session, text) => {
      inherited = session.state.messages;
      tools = session.getActiveToolNames();
      receivedTask = text;
      finish(session);
    };
    const result = await spawn('use inherited history', { fork: true });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(inherited)).toContain('parent-only context marker');
    expect(receivedTask).toContain('Review the task.');
    expect(receivedTask).toContain('use inherited history');
    expect(tools).toContain('bash');
    expect(tools).not.toContain('subagent');
    expect(tools).not.toContain('subagent_send');
  });

  test('deadline-bound shutdown isolates late completion from a replacement session', async () => {
    const started = gate();
    const release = gate();
    promptImpl = async (session) => {
      started.resolve();
      await release.promise;
      finish(session, 'old session answer');
    };
    await spawn('stubborn old child', { run_in_background: true });
    await started.promise;
    const shutdown = track(parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'new' }));
    await vi.advanceTimersByTimeAsync(1000);
    await shutdown;
    await parent.extensionRunner.emit({ type: 'session_start', reason: 'new' });
    promptImpl = async (session) => {
      finish(session, 'new session answer');
    };
    const current = await spawn('replacement session child');
    expect(current.isError).toBe(false);
    const auditBefore = parent.sessionManager.getEntries().filter((entry) => entry.type === 'custom');
    release.resolve();
    await Promise.allSettled(pending);
    const auditAfter = parent.sessionManager.getEntries().filter((entry) => entry.type === 'custom');
    expect(auditAfter).toEqual(auditBefore);
    expect(vi.getTimerCount()).toBe(1); // only the replacement child's status linger
  });
});
