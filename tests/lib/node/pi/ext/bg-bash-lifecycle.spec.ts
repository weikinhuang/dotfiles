import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { JobSummary } from '../../../../../lib/node/pi/bg-bash-reducer.ts';
import { BG_BASH_NUDGE_CUSTOM_TYPE } from '../../../../../lib/node/pi/bg-bash/nudge.ts';

interface Gate {
  promise: Promise<void>;
  release: () => void;
}
function deferred(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
type Content = AssistantMessage['content'];
interface Step {
  content: Content;
  gate?: Gate;
}
const reply = (text = 'Finished.'): Content => [{ type: 'text', text }];
const call = (id: string, args: JsonObject): Content => [{ type: 'toolCall', id, name: 'bg_bash', arguments: args }];

// Only the provider stream is replaced. prompt(), the agent loop, tool execution,
// loader, ExtensionRunner, boundary commits, and settlement are all the actual SDK.
describe('bg_bash actual SDK lifecycle (provider-free)', () => {
  let root: string;
  let session: AgentSession | undefined;
  let steps: Step[];
  let requests: Parameters<NonNullable<AgentSession>['agent']['streamFunction']>[1][];
  let gates: Gate[];
  let pending: Promise<unknown>[];
  let errors: string[];

  function gate(): Gate {
    const value = deferred();
    gates.push(value);
    return value;
  }
  function active(): AgentSession {
    if (!session) throw new Error('Session not initialized');
    return session;
  }
  function run(text = 'Run the background jobs.'): Promise<void> {
    const promise = active().prompt(text);
    pending.push(promise);
    return promise;
  }
  function until(predicate: () => boolean, description: string): Promise<void> {
    const deadline = performance.now() + 5000;
    const check = (): Promise<void> => {
      if (predicate()) return Promise.resolve();
      if (performance.now() > deadline)
        return Promise.reject(new Error(`Timed out: ${description}; ${errors.join('; ')}`));
      // Real libuv callbacks must run even though the extension's 250ms timer is fake.
      return setImmediate().then(check);
    };
    return check();
  }
  function jobs(): JobSummary[] {
    const snapshots = active()
      .sessionManager.getBranch()
      .filter((entry) => entry.type === 'custom' && entry.customType === 'bg-bash-state');
    const last = snapshots.at(-1);
    return last?.type === 'custom' ? (last.data as { jobs: JobSummary[] }).jobs : [];
  }
  function digests(): ReturnType<AgentSession['sessionManager']['getBranch']> {
    return active()
      .sessionManager.getBranch()
      .filter((entry) => entry.type === 'custom_message' && entry.customType === BG_BASH_NUDGE_CUSTOM_TYPE);
  }
  function requestText(index: number): string {
    return JSON.stringify(requests[index].messages);
  }
  function start(count = 1): Content {
    return Array.from({ length: count }, (_, index) => {
      const script = `process.stdin.once('data',()=>{console.log('child-${index}-done');process.exit(${index})})`;
      return call(`start-${index}`, {
        action: 'start',
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        label: `child-${index}`,
        interactiveStdin: true,
        nudge: true,
      });
    }).flat();
  }
  async function complete(index = 0): Promise<JobSummary> {
    const job = jobs()[index];
    if (!job) throw new Error(`Missing child ${index}: ${JSON.stringify(active().messages)}`);
    const tool = active().agent.state.tools.find((entry) => entry.name === 'bg_bash');
    if (!tool) throw new Error('Missing loaded bg_bash tool');
    // Control the real interactive child without manufacturing a toolResult message
    // (which would incorrectly acknowledge the completion being tested).
    await tool.execute(`release-${index}`, { action: 'stdin', id: job.id, text: 'finish\n' });
    await until(() => jobs().find((entry) => entry.id === job.id)?.status === 'exited', `child ${job.id} close`);
    return jobs().find((entry) => entry.id === job.id)!;
  }

  async function setup(options: { preserveDraft?: boolean; dropDigest?: boolean } = {}): Promise<void> {
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    mkdirSync(cwd);
    mkdirSync(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    vi.stubEnv('PI_BG_BASH_DISABLED', '');
    vi.stubEnv('PI_BG_BASH_DISABLE_NUDGE', '');
    // Prevent a separate reminder producer from acknowledging terminals implicitly.
    vi.stubEnv('PI_BG_BASH_DISABLE_AUTOINJECT', '1');
    vi.stubEnv('PI_BG_BASH_LOG_DIR', join(root, 'logs'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        errors.push('Network forbidden in bg-bash lifecycle spec');
        throw new Error('Network forbidden in bg-bash lifecycle spec');
      }),
    );
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), refreshOnCreate: false });
    const model = runtime.getModels()[0];
    if (!model) throw new Error('SDK static model catalog is empty');
    await runtime.setRuntimeApiKey(model.provider, 'provider-free-test-key');
    const paths: string[] = [];
    if (options.preserveDraft) {
      const prior = join(root, 'prior-boundary.ts');
      writeFileSync(
        prior,
        `export default function(pi) {
        let first = true;
        pi.on('agent_before_settle', event => {
          if (!first || event.outcome !== 'completed') return;
          first = false;
          return { entries: [...event.entries, {type:'custom_message',customType:'prior-draft',content:'PRESERVED_DRAFT',display:false}] };
        });
      }`,
      );
      paths.push(prior);
    }
    paths.push(resolve('config/pi/extensions/bg-bash.ts'));
    let drop = options.dropDigest === true;
    const later = (pi: ExtensionAPI): void => {
      pi.on('agent_before_settle', (event) => {
        if (
          !drop ||
          !event.entries.some(
            (entry) => entry.type === 'custom_message' && entry.customType === BG_BASH_NUDGE_CUSTOM_TYPE,
          )
        )
          return;
        drop = false;
        return {
          entries: event.entries.filter(
            (entry) => entry.type !== 'custom_message' || entry.customType !== BG_BASH_NUDGE_CUSTOM_TYPE,
          ),
          continue: false,
        };
      });
    };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      additionalExtensionPaths: paths,
      extensionFactories: [later],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
      tools: ['bg_bash'],
    }));
    session.agent.streamFunction = (requestModel, context, options) => {
      requests.push(structuredClone(context));
      const stream = createAssistantMessageEventStream();
      const step = steps.shift();
      if (!step) errors.push(`Unexpected model request ${requests.length}`);
      const produce = async (): Promise<void> => {
        if (step?.gate && !options?.signal?.aborted) {
          const abortedGate = deferred();
          const onAbort = (): void => abortedGate.release();
          const signal = options?.signal;
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
          try {
            await Promise.race([step.gate.promise, abortedGate.promise]);
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
        }
        const aborted = options?.signal?.aborted === true;
        const content = aborted ? [] : (step?.content ?? reply('Unexpected request.'));
        const message: AssistantMessage = {
          role: 'assistant',
          content,
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: aborted ? 'aborted' : content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
        if (aborted) stream.push({ type: 'error', reason: 'aborted', error: message });
        else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
        stream.end();
      };
      void produce();
      return stream;
    };
    await session.bindExtensions({ mode: 'print', onError: (error) => errors.push(error.error) });
    session.setActiveToolsByName(['bg_bash']);
    expect(session.getActiveToolNames()).toContain('bg_bash');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bg-bash-sdk-'));
    session = undefined;
    steps = [];
    requests = [];
    gates = [];
    pending = [];
    errors = [];
  });
  afterEach(async () => {
    for (const value of gates) value.release();
    if (session) {
      await session.abort();
      await Promise.allSettled(pending);
      // Shutdown uses real timers for SIGTERM/drain escalation.
      vi.useRealTimers();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  test('busy completions more than 250ms apart commit one digest and one continuation, preserving prior drafts', async () => {
    await setup({ preserveDraft: true });
    const held = gate();
    steps.push(
      { content: start(2) },
      { content: reply('Long-running turn finished.'), gate: held },
      { content: reply('Reviewed both completions.') },
    );
    const running = run();
    await until(() => requests.length === 2, 'gated long-running request');
    const first = await complete(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(active().getFollowUpMessages()).toEqual([]);
    expect(digests()).toHaveLength(0);
    const second = await complete(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(active().getFollowUpMessages()).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(digests()).toHaveLength(0);
    held.release();
    await running;
    expect(requests).toHaveLength(3);
    expect(digests()).toHaveLength(1);
    expect(JSON.stringify(digests())).toContain(first.id);
    expect(JSON.stringify(digests())).toContain(second.id);
    expect(requestText(2)).toContain(first.id);
    expect(requestText(2)).toContain(second.id);
    expect(requestText(2)).toContain('PRESERVED_DRAFT');
    expect(JSON.stringify(digests())).toContain('✗');
    expect(
      active()
        .sessionManager.getBranch()
        .filter((entry) => entry.type === 'custom_message' && entry.customType === 'prior-draft'),
    ).toHaveLength(1);
    // A boundary commit emits no message_end. Branch scanning must still retire it.
    steps.push({ content: reply('Next real user turn.') });
    await run('Continue.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(digests()).toHaveLength(1);
    expect(requests).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  test('actual terminal logs acknowledge a completed job before the wake timer fires', async () => {
    await setup();
    const held = gate();
    const afterLogs = gate();
    const logs: Step = { content: [], gate: held };
    steps.push({ content: start() }, logs, { content: reply('Read the terminal logs.'), gate: afterLogs });
    const running = run();
    await until(() => requests.length === 2, 'request before logs');
    const job = await complete();
    logs.content = call('terminal-logs', { action: 'logs', id: job.id });
    held.release();
    await until(() => requests.length === 3, 'request after actual logs toolResult');
    const result = active().messages.find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'terminal-logs',
    );
    expect(JSON.stringify(result)).toContain('child-0-done');
    // The model must receive an explicit terminal summary, not just result.details.
    expect(result?.role === 'toolResult' ? JSON.stringify(result.content) : '').toMatch(/exited 0|Exited:/);
    await vi.advanceTimersByTimeAsync(500);
    afterLogs.release();
    await running;
    expect(digests()).toHaveLength(0);
    expect(active().getFollowUpMessages()).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  test('abort retains pending completions but never resumes without the next real user run', async () => {
    await setup();
    const held = gate();
    steps.push({ content: start() }, { content: reply(), gate: held });
    const running = run();
    await until(() => requests.length === 2, 'request to abort');
    const job = await complete();
    await vi.advanceTimersByTimeAsync(300);
    await active().abort();
    await running;
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(2);
    expect(digests()).toHaveLength(0);
    expect(active().getFollowUpMessages()).toEqual([]);
    steps.push({ content: reply('Actual next user run.') }, { content: reply('Reviewed retained completion.') });
    await run('Resume now.');
    expect(digests()).toHaveLength(1);
    expect(requests).toHaveLength(4);
    expect(requestText(3)).toContain(job.id);
    expect(errors).toEqual([]);
  });

  test('idle completion coalesces for 250ms and triggers exactly one real model turn', async () => {
    await setup();
    steps.push(
      { content: start() },
      { content: reply('Job is running.') },
      { content: reply('Reviewed idle completion.') },
    );
    await run();
    const job = await complete();
    await vi.advanceTimersByTimeAsync(249);
    expect(requests).toHaveLength(2);
    expect(digests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => requests.length === 3, 'idle-triggered provider request');
    await active().waitForIdle();
    expect(digests()).toHaveLength(1);
    expect(requestText(2)).toContain(job.id);
    expect(active().getFollowUpMessages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  test('an idle-scheduled timer rechecks idleness when a real user run starts before it fires', async () => {
    await setup();
    steps.push({ content: start() }, { content: reply('Job is running.') });
    await run();
    const job = await complete();
    const held = gate();
    steps.push(
      { content: reply('User run finished.'), gate: held },
      { content: reply('Reviewed completion at settlement.') },
    );
    const running = run('New user work before the wake timer.');
    await until(() => requests.length === 3, 'new user run before idle wake');
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(3);
    expect(digests()).toHaveLength(0);
    expect(active().getFollowUpMessages()).toEqual([]);
    held.release();
    await running;
    expect(requests).toHaveLength(4);
    expect(digests()).toHaveLength(1);
    expect(requestText(3)).toContain(job.id);
    expect(errors).toEqual([]);
  });

  test('a later boundary handler dropping the digest does not acknowledge uncommitted drafts', async () => {
    await setup({ dropDigest: true });
    const held = gate();
    steps.push({ content: start() }, { content: reply(), gate: held });
    const running = run();
    await until(() => requests.length === 2, 'gated request before dropped boundary');
    const job = await complete();
    await vi.advanceTimersByTimeAsync(300);
    held.release();
    await running;
    expect(digests()).toHaveLength(0);
    expect(requests).toHaveLength(2);
    expect(active().getFollowUpMessages()).toEqual([]);
    steps.push({ content: reply('Next user request.') }, { content: reply('Finally reviewed completion.') });
    await run('Try again.');
    expect(digests()).toHaveLength(1);
    expect(requests).toHaveLength(4);
    expect(requestText(3)).toContain(job.id);
    expect(errors).toEqual([]);
  });
});
