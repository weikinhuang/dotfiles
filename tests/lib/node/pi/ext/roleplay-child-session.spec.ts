import { SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type * as spawnModule from '../../../../../lib/node/pi/subagent/spawn.ts';
import { makeNodeReadLayer, type AgentDef } from '../../../../../lib/node/pi/subagent/loader.ts';

const runOneShotAgent = vi.fn<(options: unknown) => Promise<unknown>>();
vi.mock('../../../../../lib/node/pi/subagent/spawn.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof spawnModule>()),
  runOneShotAgent: (options: unknown) => runOneShotAgent(options),
}));

const { loadRoleplayAgent, requestOptionsGateFactory, roleplayChildSessionManager, runRoleplayChild } =
  await import('../../../../../lib/node/pi/ext/roleplay-child-session.ts');

const dirs: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roleplay-child-session-'));
  dirs.push(root);
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'));
  vi.stubEnv('PI_SUBAGENT_SESSION_ROOT', '');
  runOneShotAgent.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const trackedParent = (): { getSessionId: () => string; getSessionDir: () => string } => ({
  getSessionId: () => 'parent-id',
  getSessionDir: () => join(root, 'sessions'),
});

function agent(over: Partial<AgentDef> = {}): AgentDef {
  return { name: 'fixture', model: 'inherit', body: '', tools: [], ...over } as unknown as AgentDef;
}

describe('roleplayChildSessionManager', () => {
  test('persists under the parent session subagent tree', () => {
    const sm = roleplayChildSessionManager(trackedParent(), 'roleplay-summarize', root);
    expect(sm.isPersisted()).toBe(true);
    expect(sm.getSessionDir()).toBe(join(root, 'sessions', 'parent-id', 'subagents'));
  });

  test.each([
    ['untracked', { getSessionId: () => undefined, getSessionDir: () => undefined }],
    [
      'throwing',
      {
        getSessionId: () => {
          throw new Error('no session');
        },
        getSessionDir: () => '',
      },
    ],
  ])('falls back to in-memory for an %s parent', (_label, parent) => {
    const sm = roleplayChildSessionManager(parent, 'roleplay-event', root);
    expect(sm).toBeInstanceOf(SessionManager);
    expect(sm.isPersisted()).toBe(false);
  });
});

describe('loadRoleplayAgent', () => {
  test('resolves a named agent from the extension-relative global layer, null when missing', () => {
    const extensionDir = join(root, 'ext', 'extensions');
    mkdirSync(join(root, 'ext', 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'ext', 'agents', 'roleplay-fixture.md'),
      '---\nname: roleplay-fixture\ndescription: fixture\ntools: []\nmodel: inherit\n---\nBODY\n',
    );
    const opts = { extensionDir, cwd: root, knownToolNames: new Set<string>(), fs: makeNodeReadLayer() };
    expect(loadRoleplayAgent({ ...opts, name: 'roleplay-fixture' })?.name).toBe('roleplay-fixture');
    expect(loadRoleplayAgent({ ...opts, name: 'missing' })).toBeNull();
  });

  test('swallows a throwing read layer', () => {
    const fs = {
      listMarkdownFiles: () => {
        throw new Error('boom');
      },
      readFile: () => null,
    };
    expect(
      loadRoleplayAgent({ name: 'x', extensionDir: root, cwd: root, knownToolNames: new Set<string>(), fs }),
    ).toBeNull();
  });
});

describe('requestOptionsGateFactory', () => {
  test('only builds a gate when the agent pins request options', () => {
    expect(requestOptionsGateFactory(agent())).toBeNull();
    expect(typeof requestOptionsGateFactory(agent({ requestOptions: { temperature: 0.3 } }))).toBe('function');
  });
});

describe('runRoleplayChild', () => {
  const base = {
    extensionLabel: 'roleplay-summarize',
    parentSessionManager: trackedParent(),
    cwd: '/work',
    model: { id: 'm' } as never,
    task: 'TASK',
    modelRegistry: {} as never,
  };

  test('pins request options, persists the transcript, and forwards signal + timeout', async () => {
    runOneShotAgent.mockResolvedValue({ finalText: 'OUT', stopReason: 'completed', errorMessage: 'warn' });
    const signal = new AbortController().signal;
    const result = await runRoleplayChild({
      ...base,
      parentSessionManager: trackedParent(),
      agent: agent({ requestOptions: { temperature: 0.3 } }),
      pinRequestOptions: true,
      signal,
      timeoutMs: 60000,
    });
    expect(result).toEqual({ finalText: 'OUT', stopReason: 'completed', errorMessage: 'warn' });
    const call = runOneShotAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(call).toMatchObject({ cwd: '/work', task: 'TASK', signal, timeoutMs: 60000 });
    expect(call.extensionFactories).toHaveLength(1);
    expect((call.sessionManager as SessionManager).isPersisted()).toBe(true);
    expect(Object.keys(call.deps as object).sort()).toEqual([
      'DefaultResourceLoader',
      'SessionManager',
      'createAgentSession',
      'getAgentDir',
    ]);
  });

  test('omits the gate, signal and timeout when not requested and drops an absent errorMessage', async () => {
    runOneShotAgent.mockResolvedValue({ finalText: '', stopReason: 'error' });
    const result = await runRoleplayChild({
      ...base,
      agent: agent({ requestOptions: { temperature: 0.3 } }),
      pinRequestOptions: false,
    });
    expect(result).toEqual({ finalText: '', stopReason: 'error' });
    const call = runOneShotAgent.mock.calls[0][0] as Record<string, unknown>;
    expect('extensionFactories' in call).toBe(false);
    expect('signal' in call).toBe(false);
    expect('timeoutMs' in call).toBe(false);
  });
});
