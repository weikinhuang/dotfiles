/**
 * Tests for lib/node/pi/subagent/spawn.ts.
 *
 * runOneShotAgent is exercised via injected mocks for the pi constructors
 * so the helper is testable without the pi runtime. resolveChildModel is
 * pure.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type AgentDef } from '../../../../../lib/node/pi/subagent/loader.ts';
import { formatRunResultText } from '../../../../../lib/node/pi/subagent/result.ts';
import {
  adaptCreateAgentSession,
  agentWithResolvedThinking,
  createChildRun,
  resolveChildModel,
  runOneShotAgent,
  type AgentSessionEventLike,
  type AgentSessionLike,
  type RunOneShotDeps,
} from '../../../../../lib/node/pi/subagent/spawn.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

interface FakeModel {
  readonly id: string;
}

const mkAgent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  path: '/fake/critic.md',
  source: 'project',
  name: 'critic',
  description: 'fake',
  tools: ['read'],
  model: 'inherit',
  thinkingLevel: undefined,
  maxTurns: 3,
  timeoutMs: 10_000,
  isolation: 'shared-cwd',
  context: 'fresh',
  appendSystemPrompt: undefined,
  bashAllow: [],
  bashDeny: [],
  writeRoots: [],
  body: 'body',
  ...overrides,
});

const mkRegistry = (
  entries: Record<string, FakeModel> = {},
): {
  find(p: string, m: string): FakeModel | undefined;
  authStorage: unknown;
} => ({
  find: (p, m) => entries[`${p}/${m}`],
  authStorage: {},
});

// ──────────────────────────────────────────────────────────────────────
// resolveChildModel
// ──────────────────────────────────────────────────────────────────────

describe('resolveChildModel', () => {
  test('override wins when provider/id resolves', () => {
    const registry = mkRegistry({ 'amazon-bedrock/foo': { id: 'foo' } });
    const r = resolveChildModel<FakeModel>({
      override: 'amazon-bedrock/foo',
      agent: mkAgent(),
      parent: { id: 'parent' },
      modelRegistry: registry,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.model.id).toBe('foo');
  });

  test('override fails fast on malformed string', () => {
    const r = resolveChildModel<FakeModel>({
      override: 'not-a-slash',
      agent: mkAgent(),
      parent: undefined,
      modelRegistry: mkRegistry(),
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/invalid modelOverride/);
  });

  test('override fails with registry diagnostic when unknown id', () => {
    const r = resolveChildModel<FakeModel>({
      override: 'amazon-bedrock/unknown-model',
      agent: mkAgent(),
      parent: undefined,
      modelRegistry: mkRegistry(),
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not registered/);
  });

  test('peels a trailing thinking-level suffix and carries the level back', () => {
    const registry = mkRegistry({ 'llama-cpp/qwen3-6-27b': { id: 'qwen3-6-27b' } });
    const r = resolveChildModel<FakeModel>({
      override: 'llama-cpp/qwen3-6-27b:off',
      agent: mkAgent(),
      parent: { id: 'parent' },
      modelRegistry: registry,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.model.id).toBe('qwen3-6-27b');
    expect(r.ok && r.thinkingLevel).toBe('off');
  });

  test('prefers an exact match over peeling a colon segment', () => {
    // A model whose id legitimately ends in `:0` (Bedrock inference profile)
    // must resolve exactly, never by stripping `:0`.
    const registry = mkRegistry({ 'amazon-bedrock/claude-v1:0': { id: 'claude-v1:0' } });
    const r = resolveChildModel<FakeModel>({
      override: 'amazon-bedrock/claude-v1:0',
      agent: mkAgent(),
      parent: undefined,
      modelRegistry: registry,
    });

    expect(r.ok && r.model.id).toBe('claude-v1:0');
    expect(r.ok && r.thinkingLevel).toBeUndefined();
  });

  test('leaves a non-thinking colon suffix as part of the id (no level)', () => {
    // `:exacto` is not a thinking level, so the whole id stays intact and the
    // registry miss surfaces as a normal not-registered diagnostic.
    const r = resolveChildModel<FakeModel>({
      override: 'openrouter/some-model:exacto',
      agent: mkAgent(),
      parent: undefined,
      modelRegistry: mkRegistry(),
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/openrouter\/some-model:exacto not registered/);
  });

  test('resolves a base id carrying both a colon segment and a thinking suffix', () => {
    const registry = mkRegistry({ 'openrouter/some-model:exacto': { id: 'some-model:exacto' } });
    const r = resolveChildModel<FakeModel>({
      override: 'openrouter/some-model:exacto:high',
      agent: mkAgent(),
      parent: undefined,
      modelRegistry: registry,
    });

    expect(r.ok && r.model.id).toBe('some-model:exacto');
    expect(r.ok && r.thinkingLevel).toBe('high');
  });

  test('falls back to agent model when no override and agent !== inherit', () => {
    const registry = mkRegistry({ 'openai/gpt-x': { id: 'gpt-x' } });
    const agent = mkAgent({ model: { provider: 'openai', modelId: 'gpt-x' } });
    const r = resolveChildModel<FakeModel>({
      override: undefined,
      agent,
      parent: { id: 'parent' },
      modelRegistry: registry,
    });

    expect(r.ok && r.model.id).toBe('gpt-x');
  });

  test('agent model fails with agent-prefix diagnostic when unknown', () => {
    const agent = mkAgent({ model: { provider: 'openai', modelId: 'gpt-missing' } });
    const r = resolveChildModel<FakeModel>({
      override: undefined,
      agent,
      parent: undefined,
      modelRegistry: mkRegistry(),
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^agent model openai\/gpt-missing not registered/);
  });

  test('inherits parent when override absent and agent === inherit', () => {
    const parent: FakeModel = { id: 'parent-model' };
    const r = resolveChildModel<FakeModel>({
      override: undefined,
      agent: mkAgent(),
      parent,
      modelRegistry: mkRegistry(),
    });

    expect(r.ok && r.model.id).toBe('parent-model');
  });

  test('fails when nothing is available (inherit + no parent)', () => {
    const r = resolveChildModel<FakeModel>({
      override: undefined,
      agent: mkAgent(),
      parent: undefined,
      modelRegistry: mkRegistry(),
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/no model available/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// agentWithResolvedThinking
// ──────────────────────────────────────────────────────────────────────

describe('agentWithResolvedThinking', () => {
  test('overrides the agent thinkingLevel when a level was resolved', () => {
    const agent = mkAgent({ thinkingLevel: 'low' });
    const out = agentWithResolvedThinking(agent, 'off');

    expect(out.thinkingLevel).toBe('off');
    // Original def is left untouched (new object).
    expect(agent.thinkingLevel).toBe('low');
    expect(out).not.toBe(agent);
  });

  test('returns the same agent reference when no level was resolved', () => {
    const agent = mkAgent({ thinkingLevel: 'low' });
    const out = agentWithResolvedThinking(agent, undefined);

    expect(out).toBe(agent);
    expect(out.thinkingLevel).toBe('low');
  });
});

// ──────────────────────────────────────────────────────────────────────
// runOneShotAgent - via injected mocks
// ──────────────────────────────────────────────────────────────────────

/** Build a fake session whose event stream the test script replays. */
function makeFakeSession(script: {
  events: AgentSessionEventLike[];
  finalText: string;
  promptThrows?: Error;
}): AgentSessionLike {
  const subscribers: ((e: AgentSessionEventLike) => void)[] = [];
  let aborted = false;
  const session: AgentSessionLike = {
    subscribe(handler) {
      subscribers.push(handler);
      return () => {
        const i = subscribers.indexOf(handler);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    prompt: (): Promise<void> => {
      for (const e of script.events) {
        if (aborted) break;
        for (const s of subscribers) s(e);
      }
      return script.promptThrows ? Promise.reject(script.promptThrows) : Promise.resolve();
    },
    abort: () => {
      aborted = true;
      return Promise.resolve();
    },
    dispose() {
      /* noop */
    },
    get state() {
      return {
        messages: [{ role: 'assistant', content: [{ type: 'text', text: script.finalText }] }] as unknown,
      };
    },
  };
  return session;
}

/** Build a deps bundle that returns the provided session. */
function mkDeps(session: AgentSessionLike): RunOneShotDeps<FakeModel, { id: 'session-manager' }> {
  class FakeLoader {
    reload(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    createAgentSession: () => Promise.resolve({ session }),
    DefaultResourceLoader: FakeLoader,
    SessionManager: { inMemory: () => ({ id: 'session-manager' as const }) },
    getAgentDir: () => '/fake/agent/dir',
  };
}

/** A manually driven session, including events emitted outside prompt's stack. */
function makeControlledSession(): {
  session: AgentSessionLike;
  subscribers: Set<(event: AgentSessionEventLike) => void>;
  emit(this: void, event: AgentSessionEventLike): void;
  finish(this: void): void;
} {
  const subscribers = new Set<(event: AgentSessionEventLike) => void>();
  let finish = (): void => {
    /* assigned synchronously by the promise constructor */
  };
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session: AgentSessionLike = {
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    prompt: () => pending,
    abort: () => {
      finish();
      return Promise.resolve();
    },
    dispose: () => undefined,
    state: { messages: [] },
  };
  return {
    session,
    subscribers,
    emit(event) {
      for (const subscriber of subscribers) subscriber(event);
    },
    finish: () => finish(),
  };
}

describe('createChildRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('a non-tool continuation cannot start another model step past the cap', async () => {
    const { session, emit } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort');
    const running = createChildRun({ session, maxTurns: 1, timeoutMs: 100 }).run('task');
    await Promise.resolve();
    emit({ type: 'turn_start' });
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text' }] } });
    emit({ type: 'turn_end' });
    expect(abort).not.toHaveBeenCalled();
    emit({ type: 'turn_start' });
    expect(await running).toMatchObject({ turns: 1, stopReason: 'max_turns' });
    expect(abort).toHaveBeenCalledOnce();
  });

  test('construction is inert and run starts exactly once', async () => {
    const { session, finish, subscribers } = makeControlledSession();
    const prompt = vi.spyOn(session, 'prompt');
    const subscribe = vi.spyOn(session, 'subscribe');
    const dispose = vi.spyOn(session, 'dispose');
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const child = createChildRun({ session, maxTurns: 2, timeoutMs: 100, signal: controller.signal });

    expect(subscribe).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const running = child.run('first');
    expect(child.run('ignored')).toBe(running);
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledExactlyOnceWith('first');
    expect(subscribers.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    finish();
    const result = await running;

    expect(result).toMatchObject({ turns: 0, stopReason: 'completed', finalText: '', session });
    expect(result.messages).toBe(session.state.messages);
    expect(child.run('also ignored')).toBe(running);
    expect(dispose).toHaveBeenCalledOnce();
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', addListener.mock.calls[0]?.[1]);
  });

  test('a pre-aborted signal never subscribes or prompts', async () => {
    const { session } = makeControlledSession();
    const prompt = vi.spyOn(session, 'prompt');
    const subscribe = vi.spyOn(session, 'subscribe');
    const abort = vi.spyOn(session, 'abort');
    const dispose = vi.spyOn(session, 'dispose');
    const controller = new AbortController();
    controller.abort();
    const child = createChildRun({ session, maxTurns: 2, timeoutMs: 100, signal: controller.signal });

    const result = await child.run('never sent');
    expect(result).toMatchObject({ turns: 0, stopReason: 'aborted', errorMessage: 'aborted' });
    expect(prompt).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('abort before run is immediately sticky, repeated once, and handles rejected abort and dispose', async () => {
    const { session } = makeControlledSession();
    const prompt = vi.spyOn(session, 'prompt');
    const abort = vi.spyOn(session, 'abort').mockRejectedValue(new Error('abort failed'));
    const dispose = vi.spyOn(session, 'dispose').mockRejectedValue(new Error('dispose failed'));
    const child = createChildRun({ session, maxTurns: 2, timeoutMs: 100 });

    const aborting = child.abort();
    expect(abort).toHaveBeenCalledOnce();
    const running = child.run('never sent');
    await expect(child.abort()).resolves.toBeUndefined();
    await expect(aborting).resolves.toBeUndefined();
    expect((await running).stopReason).toBe('aborted');
    await child.abort();
    expect(prompt).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  test('synchronous abort and disposal throws are best-effort', async () => {
    const { session } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort').mockImplementation(() => {
      throw new Error('abort failed');
    });
    vi.spyOn(session, 'dispose').mockImplementation(() => {
      throw new Error('dispose failed');
    });
    const child = createChildRun({ session, maxTurns: 1, timeoutMs: 100 });
    await child.abort();
    await expect(child.run('never sent')).resolves.toMatchObject({ stopReason: 'aborted' });
    expect(abort).toHaveBeenCalledOnce();
  });

  test('parent, callback, and registry abort handles share one abort attempt', async () => {
    const { session, emit, subscribers } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort');
    const controller = new AbortController();
    const child = createChildRun({
      session,
      maxTurns: 2,
      timeoutMs: 100,
      signal: controller.signal,
      onEvent: (event) => {
        event.abort();
        event.abort();
      },
    });
    const running = child.run('task');
    await Promise.resolve();
    emit({ type: 'turn_end' });
    controller.abort();
    await child.abort();
    expect((await running).stopReason).toBe('aborted');
    expect(abort).toHaveBeenCalledOnce();
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rejected abort during a run is handled without changing cancellation', async () => {
    const { session, finish } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort').mockRejectedValue(new Error('abort failed'));
    const child = createChildRun({ session, maxTurns: 1, timeoutMs: 100 });
    const running = child.run('task');
    await Promise.resolve();
    await child.abort();
    finish();
    expect((await running).stopReason).toBe('aborted');
    expect(abort).toHaveBeenCalledOnce();
  });

  test('callback errors from asynchronous events classify as errors and clean up', async () => {
    const { session, emit, subscribers } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort');
    const dispose = vi.spyOn(session, 'dispose');
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const child = createChildRun({
      session,
      maxTurns: 1,
      timeoutMs: 100,
      signal: controller.signal,
      onEvent: () => {
        throw new Error('callback exploded');
      },
    });
    const running = child.run('task');
    await Promise.resolve();
    expect(() => emit({ type: 'turn_end' })).not.toThrow();
    expect(await running).toMatchObject({ stopReason: 'error', errorMessage: 'callback exploded', turns: 1 });
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('timeout is distinguishable from cancellation and cleans all resources', async () => {
    const { session, subscribers } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort');
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const running = createChildRun({ session, maxTurns: 2, timeoutMs: 50, signal: controller.signal }).run('task');
    await vi.advanceTimersByTimeAsync(50);
    expect(await running).toMatchObject({ stopReason: 'aborted', errorMessage: 'timed out after 50ms' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(abort).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('keepSession skips disposal but not listener, timer, or subscription cleanup', async () => {
    const { session, finish, subscribers } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort');
    const dispose = vi.spyOn(session, 'dispose');
    const controller = new AbortController();
    const child = createChildRun({
      session,
      maxTurns: 2,
      timeoutMs: 100,
      signal: controller.signal,
      keepSession: true,
    });
    const running = child.run('task');
    await Promise.resolve();
    finish();
    await running;
    controller.abort();
    await child.abort();
    expect(dispose).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('subscription failures still remove the signal listener and dispose', async () => {
    const { session } = makeControlledSession();
    vi.spyOn(session, 'subscribe').mockImplementation(() => {
      throw new Error('subscribe failed');
    });
    const prompt = vi.spyOn(session, 'prompt');
    const dispose = vi.spyOn(session, 'dispose');
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await createChildRun({ session, maxTurns: 2, timeoutMs: 100, signal: controller.signal }).run(
      'task',
    );
    expect(result).toMatchObject({ stopReason: 'error', errorMessage: 'subscribe failed' });
    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['turn_end', 'message_end'] as const)('%s tool-call continuation hits the turn budget', async (source) => {
    const { session, emit } = makeControlledSession();
    const abort = vi.spyOn(session, 'abort');
    const seenTurns: number[] = [];
    const abortCounts: number[] = [];
    const running = createChildRun({
      session,
      maxTurns: 2,
      timeoutMs: 100,
      onEvent: ({ event, turn }) => {
        if (event.type === 'turn_end') seenTurns.push(turn);
      },
    }).run('task');
    await Promise.resolve();
    for (let i = 0; i < 2; i++) {
      emit({ type: 'turn_start' });
      emit({ type: source, message: { role: 'assistant', content: [{ type: 'toolCall' }] } });
      if (source === 'message_end') emit({ type: 'turn_end' });
      abortCounts.push(abort.mock.calls.length);
    }
    expect(abortCounts).toEqual([0, 1]);
    expect(await running).toMatchObject({ turns: 2, stopReason: 'max_turns', errorMessage: 'hit max turns (2)' });
    expect(seenTurns).toEqual([1, 2]);
    expect(abort).toHaveBeenCalledOnce();
  });

  test.each([1, 2])('natural final answer on budget turn %i completes', async (maxTurns) => {
    const events: AgentSessionEventLike[] = [];
    if (maxTurns === 2) {
      events.push({ type: 'turn_start' });
      events.push({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } });
    }
    events.push({ type: 'turn_start' });
    events.push({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text' }] } });
    const session = makeFakeSession({ events, finalText: 'done' });
    const abort = vi.spyOn(session, 'abort');
    const result = await createChildRun({ session, maxTurns, timeoutMs: 100 }).run('task');
    expect(result).toMatchObject({ turns: maxTurns, stopReason: 'completed', finalText: 'done' });
    expect(abort).not.toHaveBeenCalled();
  });

  test('turn_end message takes precedence over same-turn message_end tracking', async () => {
    const session = makeFakeSession({
      events: [
        { type: 'turn_start' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end', message: { content: [{ type: 'text' }] } },
      ],
      finalText: 'done',
    });
    expect((await createChildRun({ session, maxTurns: 1, timeoutMs: 100 }).run('task')).stopReason).toBe('completed');
  });

  test('a followup turn resets tool continuation from the preceding turn', async () => {
    const session = makeFakeSession({
      events: [
        { type: 'turn_start' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
        { type: 'turn_start' },
        { type: 'message_end', message: { role: 'toolResult' } },
        { type: 'turn_end' },
      ],
      finalText: 'done',
    });
    expect(await createChildRun({ session, maxTurns: 2, timeoutMs: 100 }).run('task')).toMatchObject({
      turns: 2,
      stopReason: 'completed',
    });
  });

  test.each(['message_end', 'turn_end'])(
    'errors on %s cannot become completed at the budget boundary',
    async (source) => {
      const session = makeFakeSession({
        events: [
          { type: source, message: { role: 'assistant', errorMessage: 'provider failed', content: [] } },
          ...(source === 'message_end' ? [{ type: 'turn_end' }] : []),
        ],
        finalText: '',
      });
      expect(await createChildRun({ session, maxTurns: 1, timeoutMs: 100 }).run('task')).toMatchObject({
        turns: 1,
        stopReason: 'error',
        errorMessage: 'provider failed',
      });
    },
  );
});

describe('runOneShotAgent', () => {
  test('adaptCreateAgentSession centralizes concrete registry and loader casts', async () => {
    const session = makeFakeSession({ events: [], finalText: '' });
    const concreteRegistry = { find: () => ({ id: 'm' }), authStorage: {}, marker: 'registry' };
    const concreteLoader = { reload: () => Promise.resolve(), marker: 'loader' };
    let seen: unknown;
    const createAgentSession = (args: {
      cwd: string;
      model: FakeModel;
      thinkingLevel: AgentDef['thinkingLevel'];
      tools: string[];
      modelRegistry: typeof concreteRegistry;
      resourceLoader: typeof concreteLoader;
      sessionManager: { id: 'session-manager' };
    }): Promise<{ session: AgentSessionLike }> => {
      seen = args;
      return Promise.resolve({ session });
    };
    const dep = adaptCreateAgentSession<
      FakeModel,
      { id: 'session-manager' },
      typeof concreteRegistry,
      typeof concreteLoader
    >(createAgentSession);

    await dep({
      cwd: '/tmp',
      model: { id: 'm' },
      thinkingLevel: undefined,
      tools: ['read'],
      modelRegistry: concreteRegistry,
      resourceLoader: concreteLoader,
      sessionManager: { id: 'session-manager' },
    });

    expect(seen).toMatchObject({ modelRegistry: concreteRegistry, resourceLoader: concreteLoader });
  });

  test('completes normally with finalText and completed stopReason', async () => {
    const session = makeFakeSession({
      events: [{ type: 'turn_end' }],
      finalText: 'ok',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 'do the thing',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('completed');
    expect(r.finalText).toBe('ok');
    expect(r.turns).toBe(1);
  });

  test('classifies max_turns when agent.maxTurns is hit and each turn wants more', async () => {
    const session = makeFakeSession({
      events: [
        { type: 'turn_start' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
        { type: 'turn_start' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
        { type: 'turn_start' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
      ],
      finalText: 'partial',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent({ maxTurns: 2 }),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('max_turns');
    expect(r.errorMessage).toMatch(/max turns/);
    expect(r.turns).toBe(2);
  });

  test('bare turn_ends with no wants-more signal classify as completed (default false)', async () => {
    // Regression: lastTurnWantsMore now defaults to false, so a subagent
    // that never signalled a pending tool call is treated as completed at
    // the cap rather than mis-flagged max_turns (which would discard its
    // finalText).
    const session = makeFakeSession({
      events: [{ type: 'turn_end' }, { type: 'turn_end' }],
      finalText: 'the answer',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent({ maxTurns: 2 }),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('completed');
    expect(r.finalText).toBe('the answer');
  });

  test('turn_start resets a stale wants-more flag from the prior turn', async () => {
    // turn 1 emits a tool call (wants more); turn 2 emits no message
    // detail. Without the turn_start reset the stale `true` would trip
    // the cap as max_turns; with it, turn 2 is a clean completion.
    const session = makeFakeSession({
      events: [
        { type: 'turn_start' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
        { type: 'turn_start' },
        { type: 'turn_end' },
      ],
      finalText: 'done after tool',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent({ maxTurns: 2 }),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('completed');
    expect(r.turns).toBe(2);
  });

  test('natural completion that lands on the maxTurns-th turn is completed, not max_turns', async () => {
    // Mirrors image-captioner: turn 1 calls a tool (read), turn 2 emits
    // the final text answer with no tool call. maxTurns is 2, so the
    // final turn lands exactly on the cap - but the agent is done, so
    // the good finalText must survive.
    const session = makeFakeSession({
      events: [
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text' }] } },
        { type: 'turn_end' },
      ],
      finalText: 'a dense caption',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent({ maxTurns: 2 }),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('completed');
    expect(r.finalText).toBe('a dense caption');
    expect(r.turns).toBe(2);
  });

  test('max_turns when the cap turn still wants to continue (pending tool call)', async () => {
    // Every turn ends with a tool call, so the agent intends to keep
    // going; hitting the cap is a real truncation.
    const session = makeFakeSession({
      events: [
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
        { type: 'turn_end' },
      ],
      finalText: '',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent({ maxTurns: 2 }),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('max_turns');
    expect(r.turns).toBe(2);
  });

  test('classifies error when child errorMessage is observed on assistant message_end', async () => {
    const session = makeFakeSession({
      events: [
        { type: 'message_end', message: { role: 'assistant', errorMessage: 'provider exploded' } },
        { type: 'turn_end' },
      ],
      finalText: '',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toBe('provider exploded');
  });

  test('classifies error when child.prompt throws a non-abort Error', async () => {
    const session = makeFakeSession({
      events: [],
      finalText: '',
      promptThrows: new Error('network down'),
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
    });

    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toBe('network down');
  });

  test('wall-clock timeout classifies aborted with a timed-out errorMessage', async () => {
    // A prompt that only settles once aborted, so the timeoutMs timer is
    // the thing that ends the run - distinct errorMessage from a plain
    // user/parent abort.
    let resolvePrompt: (() => void) | undefined;
    const subscribers: ((e: AgentSessionEventLike) => void)[] = [];
    const session: AgentSessionLike = {
      subscribe(handler) {
        subscribers.push(handler);
        return () => {
          const i = subscribers.indexOf(handler);
          if (i >= 0) subscribers.splice(i, 1);
        };
      },
      prompt: () => new Promise<void>((resolve) => (resolvePrompt = resolve)),
      abort: () => {
        resolvePrompt?.();
        return Promise.resolve();
      },
      dispose() {
        /* noop */
      },
      get state() {
        return { messages: [] as unknown };
      },
    };

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
      timeoutMs: 5,
    });

    expect(r.stopReason).toBe('aborted');
    expect(r.errorMessage).toMatch(/timed out after 5ms/);
  });

  test('classifies aborted when parent signal fires', async () => {
    const session = makeFakeSession({
      events: [],
      finalText: '',
      promptThrows: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    });
    const controller = new AbortController();
    controller.abort();

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
      signal: controller.signal,
    });

    expect(r.stopReason).toBe('aborted');
  });

  test('onEvent callback receives events with turn and abort handle', async () => {
    const events: string[] = [];
    const session = makeFakeSession({
      events: [{ type: 'turn_end' }],
      finalText: 'done',
    });

    const r = await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
      onEvent: ({ event, turn }) => {
        events.push(`${event.type}@${turn}`);
      },
    });

    expect(r.stopReason).toBe('completed');
    expect(events).toEqual(['turn_end@1']);
  });

  test('onEvent exposes assistant message_end usage.cost.total for cost aggregation', async () => {
    const session = makeFakeSession({
      events: [
        {
          type: 'message_end',
          message: { role: 'assistant', usage: { cost: { total: 0.0125 } } },
        },
        { type: 'turn_end' },
      ],
      finalText: 'ok',
    });

    const costs: number[] = [];
    await runOneShotAgent({
      deps: mkDeps(session),
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
      onEvent: ({ event }) => {
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const usd = event.message.usage?.cost?.total;
          if (typeof usd === 'number') costs.push(usd);
        }
      },
    });

    expect(costs).toEqual([0.0125]);
  });

  test('caller-supplied sessionManager overrides the in-memory default', async () => {
    const session = makeFakeSession({
      events: [{ type: 'turn_end' }],
      finalText: 'ok',
    });
    const sentinel = { id: 'session-manager' as const };
    const sentinelB = { id: 'session-manager' as const };

    // `createAgentSession` captures whatever `sessionManager` we
    // pass - use that to confirm `runOneShotAgent` threaded our
    // override instead of falling back to `SessionManager.inMemory`.
    let seen: unknown = undefined;
    const deps: RunOneShotDeps<FakeModel, { id: 'session-manager' }> = {
      createAgentSession: (args) => {
        seen = args.sessionManager;
        return Promise.resolve({ session });
      },
      DefaultResourceLoader: class {
        reload(): Promise<void> {
          return Promise.resolve();
        }
      },
      SessionManager: { inMemory: () => sentinelB },
      getAgentDir: () => '/fake',
    };

    await runOneShotAgent({
      deps,
      cwd: '/tmp',
      agent: mkAgent(),
      model: { id: 'm' },
      task: 't',
      modelRegistry: mkRegistry(),
      sessionManager: sentinel,
    });

    expect(seen).toBe(sentinel);
    expect(seen).not.toBe(sentinelB);
  });
});

describe('createChildRun wall-clock timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('a child past its wall clock reports timedOut + touched files; the result text leads with the timeout', async () => {
    const { session, emit } = makeControlledSession();
    session.state.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Now update the tests.' }] }];
    const run = createChildRun({ session, maxTurns: 50, timeoutMs: 300_000 });
    const running = run.run('implement the feature');
    await Promise.resolve();

    emit({ type: 'turn_start' });
    emit({ type: 'tool_execution_start', toolName: 'write', args: { path: 'src/feature.ts', content: 'x' } });
    emit({ type: 'tool_execution_start', toolName: 'read', args: { path: 'src/other.ts' } });
    emit({
      type: 'tool_execution_start',
      toolName: 'apply_patch',
      args: { patch: '*** Begin Patch\n*** Update File: src/index.ts\n@@\n-a\n+b\n*** End Patch' },
    });
    emit({ type: 'tool_execution_start', toolName: 'edit', args: { path: 'src/feature.ts', edits: [] } });
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } });
    emit({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'toolCall' }] } });
    expect(run.touchedFiles()).toEqual(['src/feature.ts', 'src/index.ts']);

    await vi.advanceTimersByTimeAsync(300_000);
    const result = await running;
    expect(result).toMatchObject({
      stopReason: 'aborted',
      timedOut: true,
      turns: 1,
      touchedFiles: ['src/feature.ts', 'src/index.ts'],
      errorMessage: 'timed out after 300000ms',
    });

    const text = formatRunResultText({
      agent: 'general-purpose',
      stopReason: result.stopReason,
      timedOut: result.timedOut,
      timeoutMs: 300_000,
      durationMs: 300_000,
      turns: result.turns,
      maxTurns: 50,
      touchedFiles: result.touchedFiles,
      errorMessage: result.errorMessage,
      finalText: result.finalText,
    });
    const [first, ...rest] = text.split('\n');
    expect(first).toBe('subagent "general-purpose" timed out after 300s (1 turn); partial changes may be on disk:');
    expect(rest.slice(0, 2)).toEqual(['- src/feature.ts', '- src/index.ts']);
    expect(text).toContain('Last message:\nNow update the tests.');
  });

  test('a parent abort is not reported as a timeout', async () => {
    const { session } = makeControlledSession();
    const controller = new AbortController();
    const running = createChildRun({ session, maxTurns: 5, timeoutMs: 300_000, signal: controller.signal }).run('t');
    await Promise.resolve();
    controller.abort();
    expect(await running).toMatchObject({ stopReason: 'aborted', timedOut: false, touchedFiles: [] });
  });
});
