/**
 * Tests for lib/node/pi/subagent-spawn.ts.
 *
 * runOneShotAgent is exercised via injected mocks for the pi constructors
 * so the helper is testable without the pi runtime. resolveChildModel is
 * pure.
 */

import { describe, expect, test } from 'vitest';

import { type AgentDef } from '../../../../lib/node/pi/subagent-loader.ts';
import {
  resolveChildModel,
  runOneShotAgent,
  type AgentSessionEventLike,
  type AgentSessionLike,
  type RunOneShotDeps,
} from '../../../../lib/node/pi/subagent-spawn.ts';

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
  appendSystemPrompt: undefined,
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
// runOneShotAgent — via injected mocks
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
        for (const s of [...subscribers]) s(e);
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

describe('runOneShotAgent', () => {
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

  test('classifies max_turns when agent.maxTurns is hit', async () => {
    const session = makeFakeSession({
      events: [{ type: 'turn_end' }, { type: 'turn_end' }, { type: 'turn_end' }],
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
});
