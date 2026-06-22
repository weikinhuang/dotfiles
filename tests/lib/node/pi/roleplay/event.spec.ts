/**
 * Tests for lib/node/pi/roleplay/event.ts: pure helpers (task builder,
 * director framing, deck pick, validation), the settings resolver, and
 * the generator's null-on-any-failure / inherit-parent-model contract.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { type AgentDef } from '../../../../../lib/node/pi/subagent/loader.ts';
import {
  buildEventTask,
  createEventGenerator,
  type EventGenerator,
  type EventRunResult,
  formatEventDirector,
  pickDeckEvent,
  resolveEventSettings,
  validateEvent,
} from '../../../../../lib/node/pi/roleplay/event.ts';

// ── Pure helpers ──────────────────────────────────────────────────────

test('buildEventTask includes cast, scene, and the closing instruction', () => {
  const task = buildEventTask({
    recentScene: 'user: hi\n\nassistant: hello',
    sheets: ['Exusiai: cheerful courier', 'Texas: quiet driver'],
    openThreads: ['the unanswered dinner invite'],
    seedThreads: true,
  });
  expect(task).toContain('Exusiai: cheerful courier');
  expect(task).toContain('the unanswered dinner invite');
  expect(task).toContain('user: hi');
  expect(task).toContain('ONE short in-world complication');
  expect(task).toContain('reply with the literal string null');
});

test('buildEventTask omits open threads when seedThreads is false', () => {
  const task = buildEventTask({
    recentScene: 'scene',
    sheets: [],
    openThreads: ['secret thread'],
    seedThreads: false,
  });
  expect(task).not.toContain('secret thread');
});

test('buildEventTask folds a hint and handles an empty scene', () => {
  const task = buildEventTask({
    recentScene: '   ',
    sheets: [],
    openThreads: [],
    hint: 'bring up the heist',
    seedThreads: true,
  });
  expect(task).toContain('the scene has just opened');
  expect(task).toContain('Steer the complication toward: bring up the heist');
});

test('formatEventDirector frames the event as a private stage direction', () => {
  const out = formatEventDirector('  A courier bursts in with bad news.  ');
  expect(out).toContain('Director note');
  expect(out).toContain('A courier bursts in with bad news.');
});

test('pickDeckEvent draws deterministically and skips blanks', () => {
  expect(pickDeckEvent([], () => 0)).toBeUndefined();
  expect(pickDeckEvent(['  ', ''], () => 0)).toBeUndefined();
  expect(pickDeckEvent(['a', 'b', 'c'], () => 0)).toBe('a');
  expect(pickDeckEvent(['a', 'b', 'c'], () => 0.99)).toBe('c');
  expect(pickDeckEvent([' x ', 'y'], () => 0)).toBe('x');
});

test('validateEvent trims, rejects empty/null, truncates over-cap', () => {
  expect(validateEvent('   ', 100)).toBeNull();
  expect(validateEvent('null', 100)).toBeNull();
  expect(validateEvent('  a real event  ', 100)).toBe('a real event');
  const out = validateEvent('X'.repeat(50), 10);
  expect(out).not.toBeNull();
  expect(out!.length).toBe(10);
});

// ── Settings resolution ───────────────────────────────────────────────

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'rp-event-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'rp-event-home-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('resolveEventSettings returns null when nothing is configured', () => {
  expect(resolveEventSettings({ cwd, home })).toBeNull();
});

test('resolveEventSettings reads the project file first', () => {
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'roleplay-event.json'), JSON.stringify({ eventModel: 'prov/proj-model' }));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ roleplay: { eventModel: 'prov/user-model' } }),
  );
  expect(resolveEventSettings({ cwd, home })?.eventModel).toBe('prov/proj-model');
});

test('resolveEventSettings falls back to settings.json roleplay.eventModel', () => {
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ roleplay: { eventModel: 'prov/settings-model' } }),
  );
  expect(resolveEventSettings({ cwd, home })?.eventModel).toBe('prov/settings-model');
});

test('resolveEventSettings ignores a malformed model spec', () => {
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'roleplay-event.json'), JSON.stringify({ eventModel: 'no-slash' }));
  expect(resolveEventSettings({ cwd, home })).toBeNull();
});

// ── Adapter ───────────────────────────────────────────────────────────

function fakeAgent(): AgentDef {
  return {
    name: 'roleplay-event',
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

test('isEnabled is false only when the agent is missing (model is optional)', () => {
  const noAgent = createEventGenerator<FakeModel>({
    settings: null,
    eventAgent: null,
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(noAgent.isEnabled()).toBe(false);

  const inheritModel = createEventGenerator<FakeModel>({
    settings: null,
    eventAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: '', stopReason: 'completed' }),
  });
  expect(inheritModel.isEnabled()).toBe(true);
});

test('generate returns the validated event on a completed run', async () => {
  const calls: { task: string }[] = [];
  const gen = createEventGenerator<FakeModel>({
    settings: null,
    eventAgent: fakeAgent(),
    runOneShot: (args) => {
      calls.push({ task: args.task });
      return Promise.resolve({ finalText: '  A storm rolls in off the harbor.  ', stopReason: 'completed' });
    },
  });
  expect(await gen.generate(ctx, 'do the thing')).toBe('A storm rolls in off the harbor.');
  expect(calls[0].task).toBe('do the thing');
});

test('generate returns null for empty task, throw, non-completed, and null sentinel', async () => {
  const base = (result: Promise<EventRunResult>): EventGenerator<FakeModel> =>
    createEventGenerator<FakeModel>({ settings: null, eventAgent: fakeAgent(), runOneShot: () => result });

  expect(await base(Promise.resolve({ finalText: 'x', stopReason: 'completed' })).generate(ctx, '   ')).toBeNull();
  expect(await base(Promise.reject(new Error('boom'))).generate(ctx, 'task')).toBeNull();
  expect(
    await base(Promise.resolve({ finalText: 'partial', stopReason: 'max_turns' })).generate(ctx, 'task'),
  ).toBeNull();
  expect(await base(Promise.resolve({ finalText: 'null', stopReason: 'completed' })).generate(ctx, 'task')).toBeNull();
});

test('generate returns null when model resolution fails', async () => {
  const gen = createEventGenerator<FakeModel>({
    settings: { eventModel: 'prov/missing', source: 's' },
    eventAgent: fakeAgent(),
    runOneShot: () => Promise.resolve({ finalText: 'x', stopReason: 'completed' }),
  });
  const badCtx = {
    cwd: '/tmp/x',
    model: { id: 'parent' } as FakeModel,
    modelRegistry: { find: () => undefined, authStorage: {} },
  };
  expect(await gen.generate(badCtx, 'task')).toBeNull();
});
