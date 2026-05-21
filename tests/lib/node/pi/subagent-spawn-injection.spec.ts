/**
 * Tests that `runOneShotAgent` composes the global subagent-injection
 * registry with per-call `extensionFactories` in the right order, and
 * that the merged list reaches `DefaultResourceLoader`'s ctor args.
 *
 * The spawn helper accepts both a global registry (parent-side security
 * gates - bash-permissions, filesystem, sandbox - call
 * `registerSubagentInjection` once at extension load) and per-call
 * `extensionFactories`. Together they auto-mount inside every child
 * session, closing a pre-existing silent gap where children loaded with
 * `noExtensions: true` and bypassed the parent's `tool_call` chain.
 *
 * The DefaultResourceLoader stub captures its ctor args so the spec can
 * assert the composed order: globals first (parent-side registry),
 * per-call factories last - matching pi's last-registered-wins
 * semantics for handlers on the same event so a per-call factory can
 * override a globally-registered one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  clearSubagentInjections,
  registerSubagentInjection,
  type SubagentExtensionFactory,
} from '../../../../lib/node/pi/subagent-extension-injection.ts';
import { type AgentDef } from '../../../../lib/node/pi/subagent-loader.ts';
import {
  type AgentSessionEventLike,
  type AgentSessionLike,
  type DefaultResourceLoaderCtorArgs,
  type RunOneShotDeps,
  runOneShotAgent,
} from '../../../../lib/node/pi/subagent-spawn.ts';

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
  bashAllow: [],
  bashDeny: [],
  writeRoots: [],
  body: 'body',
  ...overrides,
});

const mkRegistry = (): { find(p: string, m: string): FakeModel | undefined; authStorage: unknown } => ({
  find: () => undefined,
  authStorage: {},
});

function makeSession(): AgentSessionLike {
  const subscribers: ((e: AgentSessionEventLike) => void)[] = [];
  return {
    subscribe(handler) {
      subscribers.push(handler);
      return () => {
        const i = subscribers.indexOf(handler);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    prompt: () => {
      // One synthetic turn so the helper completes naturally.
      for (const s of subscribers) s({ type: 'turn_end' });
      return Promise.resolve();
    },
    abort: () => Promise.resolve(),
    dispose() {
      /* noop */
    },
    get state() {
      return { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] as unknown };
    },
  };
}

interface CapturedCtorArgs {
  args?: DefaultResourceLoaderCtorArgs;
}

function makeDeps(captured: CapturedCtorArgs): RunOneShotDeps<FakeModel, { id: 'session-manager' }> {
  const session = makeSession();
  class CapturingLoader {
    constructor(args: DefaultResourceLoaderCtorArgs) {
      captured.args = args;
    }
    reload(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    createAgentSession: () => Promise.resolve({ session }),
    DefaultResourceLoader: CapturingLoader,
    SessionManager: { inMemory: () => ({ id: 'session-manager' as const }) },
    getAgentDir: () => '/fake/agent/dir',
  };
}

async function runOnce(opts: { extensionFactories?: SubagentExtensionFactory[] }): Promise<CapturedCtorArgs> {
  const captured: CapturedCtorArgs = {};
  await runOneShotAgent({
    deps: makeDeps(captured),
    cwd: '/tmp',
    agent: mkAgent(),
    model: { id: 'm' },
    task: 't',
    modelRegistry: mkRegistry(),
    ...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
  });
  return captured;
}

describe('runOneShotAgent + subagent-extension-injection', () => {
  beforeEach(() => {
    clearSubagentInjections();
  });
  afterEach(() => {
    clearSubagentInjections();
  });

  test('omits extensionFactories when both registry and per-call list are empty', async () => {
    const captured = await runOnce({});
    expect(captured.args).toBeDefined();
    expect(captured.args?.extensionFactories).toBeUndefined();
  });

  test('passes only registry factories when caller does not override', async () => {
    const globalA: SubagentExtensionFactory = () => 'A';
    const globalB: SubagentExtensionFactory = () => 'B';
    registerSubagentInjection('a', globalA);
    registerSubagentInjection('b', globalB);

    const captured = await runOnce({});
    expect(captured.args?.extensionFactories).toEqual([globalA, globalB]);
  });

  test('passes only per-call factories when registry is empty', async () => {
    const perCall: SubagentExtensionFactory = () => 'per-call';
    const captured = await runOnce({ extensionFactories: [perCall] });
    expect(captured.args?.extensionFactories).toEqual([perCall]);
  });

  test('composes registry first, per-call last (override semantics)', async () => {
    // Same id pattern as the real bash-permissions / filesystem
    // factories - registered once on extension load. Order matters:
    // pi's runner uses last-registered-wins for handlers on the same
    // event, so per-call factories overlay the globals.
    const globalA: SubagentExtensionFactory = () => 'global-a';
    const globalB: SubagentExtensionFactory = () => 'global-b';
    const perCall: SubagentExtensionFactory = () => 'per-call';
    registerSubagentInjection('a', globalA);
    registerSubagentInjection('b', globalB);

    const captured = await runOnce({ extensionFactories: [perCall] });
    expect(captured.args?.extensionFactories).toEqual([globalA, globalB, perCall]);
  });

  test('re-registering the same id replaces - no duplicate factories on /reload', async () => {
    const v1: SubagentExtensionFactory = () => 'v1';
    const v2: SubagentExtensionFactory = () => 'v2';
    registerSubagentInjection('reloadable', v1);
    registerSubagentInjection('reloadable', v2);

    const captured = await runOnce({});
    expect(captured.args?.extensionFactories).toEqual([v2]);
  });

  test('keeps `noExtensions: true` so on-disk extensions remain skipped', async () => {
    const f: SubagentExtensionFactory = () => 'x';
    registerSubagentInjection('f', f);

    const captured = await runOnce({});
    expect(captured.args?.noExtensions).toBe(true);
    expect(captured.args?.noSkills).toBe(true);
    expect(captured.args?.noPromptTemplates).toBe(true);
  });
});
