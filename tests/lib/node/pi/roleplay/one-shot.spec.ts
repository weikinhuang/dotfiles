/**
 * Tests for lib/node/pi/roleplay/one-shot.ts: the shared child-model
 * settings cascade and the one-shot subagent adapter factory that back
 * both `summarize.ts` and `event.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { type AgentDef } from '../../../../../lib/node/pi/subagent/loader.ts';
import {
  createOneShotSubagentAdapter,
  type OneShotRunResult,
  resolveRoleplayChildModelSettings,
} from '../../../../../lib/node/pi/roleplay/one-shot.ts';

// ── Settings resolution ───────────────────────────────────────────────

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'rp-oneshot-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'rp-oneshot-home-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('resolveRoleplayChildModelSettings returns null when nothing is configured', () => {
  expect(
    resolveRoleplayChildModelSettings({ cwd, home, key: 'eventModel', filename: 'roleplay-event.json' }),
  ).toBeNull();
});

test('resolveRoleplayChildModelSettings reads the project file first', () => {
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'roleplay-event.json'), JSON.stringify({ eventModel: 'prov/proj-model' }));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ roleplay: { eventModel: 'prov/user' } }));
  const out = resolveRoleplayChildModelSettings({ cwd, home, key: 'eventModel', filename: 'roleplay-event.json' });
  expect(out).toEqual({ model: 'prov/proj-model', source: join(cwd, '.pi', 'roleplay-event.json') });
});

test('resolveRoleplayChildModelSettings falls back to settings.json roleplay.<key>', () => {
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ roleplay: { summarizeModel: 'prov/settings' } }),
  );
  const out = resolveRoleplayChildModelSettings({
    cwd,
    home,
    key: 'summarizeModel',
    filename: 'roleplay-summarize.json',
  });
  expect(out?.model).toBe('prov/settings');
});

test('resolveRoleplayChildModelSettings ignores a malformed model spec', () => {
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'roleplay-event.json'), JSON.stringify({ eventModel: 'no-slash' }));
  expect(
    resolveRoleplayChildModelSettings({ cwd, home, key: 'eventModel', filename: 'roleplay-event.json' }),
  ).toBeNull();
});

// ── Adapter factory ───────────────────────────────────────────────────

function fakeAgent(): AgentDef {
  return {
    name: 'roleplay-child',
    description: 'test',
    tools: [],
    model: 'inherit',
    thinkingLevel: undefined,
    maxTurns: 1,
    timeoutMs: 60000,
    isolation: 'shared-cwd',
    appendSystemPrompt: undefined,
    body: '',
  } as unknown as AgentDef;
}

interface FakeModel {
  id: string;
}

const registry = {
  find: (_provider: string, modelId: string): FakeModel | undefined => ({ id: modelId }),
  authStorage: {},
};

const ctx = { cwd: '/tmp/x', model: { id: 'parent' } as FakeModel, modelRegistry: registry };

function adapter(
  runOneShot: () => Promise<OneShotRunResult>,
): ReturnType<typeof createOneShotSubagentAdapter<FakeModel>> {
  return createOneShotSubagentAdapter<FakeModel>({ agent: fakeAgent(), runOneShot, timeoutMs: 60000, label: 'child' });
}

test('run returns finalText on a completed stop and forwards the task', async () => {
  const calls: { task: string }[] = [];
  const a = createOneShotSubagentAdapter<FakeModel>({
    agent: fakeAgent(),
    runOneShot: (args) => {
      calls.push({ task: args.task });
      return Promise.resolve({ finalText: '  raw text  ', stopReason: 'completed' });
    },
    timeoutMs: 60000,
    label: 'child',
  });
  // The adapter returns the un-validated finalText; the caller trims/caps.
  expect(await a.run(ctx, 'do it', 'prov/model')).toBe('  raw text  ');
  expect(calls[0].task).toBe('do it');
});

test('run returns null for an empty task without spawning', async () => {
  const calls: { task: string }[] = [];
  const a = createOneShotSubagentAdapter<FakeModel>({
    agent: fakeAgent(),
    runOneShot: (args) => {
      calls.push({ task: args.task });
      return Promise.resolve({ finalText: 'x', stopReason: 'completed' });
    },
    timeoutMs: 60000,
    label: 'child',
  });
  expect(await a.run(ctx, '   ')).toBeNull();
  expect(calls).toHaveLength(0);
});

test('run returns null on throw and on a non-completed stop reason', async () => {
  expect(await adapter(() => Promise.reject(new Error('boom'))).run(ctx, 'task')).toBeNull();
  expect(await adapter(() => Promise.resolve({ finalText: 'p', stopReason: 'max_turns' })).run(ctx, 'task')).toBeNull();
});

test('run returns null when model resolution fails', async () => {
  const a = createOneShotSubagentAdapter<FakeModel>({
    agent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: 'x', stopReason: 'completed' }),
    timeoutMs: 60000,
    label: 'child',
  });
  const badCtx = {
    cwd: '/tmp/x',
    model: { id: 'parent' } as FakeModel,
    modelRegistry: { find: () => undefined, authStorage: {} },
  };
  expect(await a.run(badCtx, 'task', 'prov/missing')).toBeNull();
});
