/* eslint-disable no-await-in-loop -- Exercise lifecycle races in runtime order. */
import {
  ExtensionRunner,
  type ExtensionAPI,
  type ExtensionContext,
  type ContextEvent,
  type NormalizedBuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import roleplay from '../../../../../config/pi/extensions/roleplay.ts';
import cacheReminders from '../../../../../config/pi/extensions/cache-reminders.ts';
import memoryExtension from '../../../../../config/pi/extensions/memory.ts';
import { setActivePersona, clearActivePersona } from '../../../../../lib/node/pi/persona/active.ts';
import { emptyCharacterMeta, emptyLoreMeta, serializeEntry } from '../../../../../lib/node/pi/roleplay/store.ts';
import { fileFor as memoryFileFor } from '../../../../../lib/node/pi/memory-paths.ts';
import { serializeMemory } from '../../../../../lib/node/pi/memory-reducer.ts';
import type * as summarizeModule from '../../../../../lib/node/pi/roleplay/summarize.ts';
import type * as eventModule from '../../../../../lib/node/pi/roleplay/event.ts';

const summary = vi.hoisted(() => ({
  detailed:
    vi.fn<
      (
        ctx: { signal?: AbortSignal },
        span: string,
        prior?: string,
      ) => Promise<{ recap: string | null; raw: string | null }>
    >(),
}));
const events = vi.hoisted(() => ({ enabled: false, generate: vi.fn<() => Promise<string | null>>() }));
vi.mock('../../../../../lib/node/pi/roleplay/summarize.ts', async (original) => ({
  ...(await original<typeof summarizeModule>()),
  createSummarizer: () => ({
    isEnabled: () => true,
    summarizeDetailed: summary.detailed,
    summarize: () => Promise.resolve(null),
  }),
}));
vi.mock('../../../../../lib/node/pi/roleplay/event.ts', async (original) => ({
  ...(await original<typeof eventModule>()),
  createEventGenerator: () => ({ isEnabled: () => events.enabled, generate: events.generate }),
}));

type Message = ContextEvent['messages'][number];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Result = { messages?: Message[]; systemPrompt?: string } | undefined;
const roots: string[] = [];
const shutdowns: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  for (const flag of [
    'PI_ROLEPLAY_DISABLED',
    'PI_ROLEPLAY_DISABLE_AUTOINJECT',
    'PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW',
    'PI_ROLEPLAY_DISABLE_SUMMARIZE',
    'PI_ROLEPLAY_DISABLE_EVENTS',
    'PI_CACHE_REMINDERS_DISABLED',
    'PI_ROLEPLAY_ROOT',
    'PI_ROLEPLAY_CAPTURE',
    'PI_ROLEPLAY_TIMELINE',
    'PI_MEMORY_DISABLED',
    'PI_MEMORY_READONLY',
    'PI_MEMORY_DISABLE_AUTOINJECT',
  ])
    vi.stubEnv(flag, '');
  for (const aspect of ['LOREBOOK', 'DEPTH_INJECT', 'AVATAR', 'SCENEGEN', 'REPETITION'])
    vi.stubEnv(`PI_ROLEPLAY_DISABLE_${aspect}`, '1');
  summary.detailed.mockReset();
  summary.detailed.mockResolvedValue({ recap: 'GENERATED_RECAP', raw: 'GENERATED_RECAP' });
  events.enabled = false;
  events.generate.mockReset();
});
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  clearActivePersona();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function persona(cast: string, enabled = true): void {
  setActivePersona({ name: cast, cast, roleplay: enabled, tools: ['read', 'roleplay'], resolvedWriteRoots: [] });
}
function user(text: string, timestamp: number): Message {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}
function text(message: Message): string {
  if (!('content' in message)) return '';
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((p) => ('text' in p ? p.text : '')).join('\n');
}
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function history(turns: number, marker = 'OLD_SCENE_MARKER', from = 0): Message[] {
  return Array.from({ length: turns }, (_, index) => {
    const i = index + from;
    return [
      user(`${marker} turn ${i}`, i * 2 + 1),
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: `${marker} reply ${i}` }],
        timestamp: i * 2 + 2,
        api: 'anthropic-messages' as const,
        provider: 'fixture',
        model: 'fixture',
        usage,
        stopReason: 'stop' as const,
      },
    ];
  }).flat();
}
interface LifecycleHarness {
  start: (prompt: string) => Promise<void>;
  request: (messages: Message[]) => Promise<string>;
  command: (args: string) => Promise<void>;
  dispatch: (name: string, event?: unknown) => Promise<unknown>;
  seed: (cast: string, body: string) => void;
  stored: Record<string, unknown>[];
  ctx: ExtensionContext;
  agent: string;
  system: () => string;
  carry: (cast: string) => string;
}

async function harness(config: Record<string, unknown> = {}): Promise<LifecycleHarness> {
  const root = mkdtempSync(join(tmpdir(), 'roleplay-lifecycle-'));
  roots.push(root);
  const agent = join(root, 'agent');
  mkdirSync(agent);
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('PI_MEMORY_ROOT', join(root, 'memory'));
  writeFileSync(
    join(agent, 'roleplay.json'),
    JSON.stringify({
      imageMode: 'off',
      keepTurns: 32,
      recapStride: 1,
      summarizeMinMessages: 1,
      recapAsync: false,
      capture: false,
      timeline: false,
      events: ['OLD_EVENT_MARKER'],
      ...config,
    }),
  );
  writeFileSync(join(agent, 'roleplay-summarize.json'), JSON.stringify({ summarizeModel: 'fixture/fixture' }));
  persona('cast-a');
  const hooks = new Map<string, Handler[]>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const stored: Record<string, unknown>[] = [];
  const bus = new EventEmitter();
  const pi = {
    on: (name: string, handler: Handler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand: (name: string, def: Parameters<ExtensionAPI['registerCommand']>[1]) => commands.set(name, def),
    registerTool: vi.fn(),
    getActiveTools: () => ['read', 'roleplay'],
    getAllTools: () => [{ name: 'read' }, { name: 'roleplay' }],
    setActiveTools: vi.fn(),
    appendEntry: (customType: string, data: unknown) => stored.push({ type: 'custom', customType, data }),
    events: {
      on: (name: string, fn: (data: unknown) => void) => {
        bus.on(name, fn);
        return () => {
          bus.off(name, fn);
        };
      },
      emit: (name: string, data: unknown) => bus.emit(name, data),
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: {
      getBranch: () => stored,
      getSessionId: () => 'audit-session',
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00Z' }),
      buildSessionProjection: () => ({
        entries: stored
          .filter((entry) => entry.type === 'message')
          .map((entry) => ({ sourceEntry: entry, messages: [entry.message] })),
      }),
    },
    model: { id: 'fixture', provider: 'fixture', contextWindow: 128000 },
    modelRegistry: { find: () => undefined },
    abort: vi.fn(),
  } as unknown as ExtensionContext;
  if (config.memory === true) memoryExtension(pi);
  roleplay(pi);
  cacheReminders(pi);
  const errors: unknown[] = [];
  const runner = {
    extensions: [{ path: 'lifecycle-fixture', handlers: hooks }],
    createContext: () => ctx,
    emitError: (e: unknown) => errors.push(e),
  } as unknown as ExtensionRunner;
  const dispatch = async (name: string, event: unknown = { type: name }): Promise<unknown> => {
    let last: unknown;
    for (const fn of hooks.get(name) ?? []) {
      const result = await fn(event, ctx);
      if (result !== undefined) last = result;
    }
    return last;
  };
  let systemPrompt = 'STATIC_BASE';
  const promptOptions = {
    cwd: root,
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: '',
    sections: {},
    contextFiles: [],
    skills: [],
  } as NormalizedBuildSystemPromptOptions;
  const start = async (prompt: string): Promise<void> => {
    systemPrompt = 'STATIC_BASE';
    for (const fn of hooks.get('before_agent_start') ?? []) {
      const out = (await fn(
        { type: 'before_agent_start', messageType: 'user', prompt, systemPrompt, systemPromptOptions: promptOptions },
        ctx,
      )) as Result;
      if (out?.systemPrompt) systemPrompt = out.systemPrompt;
    }
  };
  const request = async (messages: Message[]): Promise<string> => {
    const out = await ExtensionRunner.prototype.emitContext.call(runner, [
      { role: 'system', content: systemPrompt, timestamp: 0 },
      ...messages,
    ]);
    expect(errors).toEqual([]);
    return out.map(text).join('\n');
  };
  const command = async (args: string): Promise<void> => {
    await commands
      .get('roleplay')!
      .handler(args, ctx as Parameters<Parameters<ExtensionAPI['registerCommand']>[1]['handler']>[1]);
  };
  const seed = (cast: string, body: string): void => {
    const dir = join(agent, 'roleplay', 'casts', cast, 'summary');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'auto.md'),
      serializeEntry({ name: 'Auto scene recap', description: 'seed', kind: 'summary', body }),
    );
  };
  await dispatch('session_start');
  shutdowns.push(() => dispatch('session_shutdown'));
  return {
    start,
    request,
    command,
    dispatch,
    seed,
    stored,
    ctx,
    agent,
    system: () => systemPrompt,
    carry: (cast: string) => join(agent, 'roleplay', 'casts', cast, 'summary', 'auto.md'),
  };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('roleplay: meaningful short spans wait for the summarizer minimum instead of being dropped', async () => {
  const h = await harness({ keepTurns: 2, recapStride: 2, summarizeMinMessages: 4 });
  await h.start('short scene');
  const out = await h.request(history(3, 'SILVER_COMPASS_MARKER'));
  expect(out).toContain('SILVER_COMPASS_MARKER turn 0');
  expect(summary.detailed).not.toHaveBeenCalled();
  const deferred = h.stored.find((entry) => entry.customType === 'roleplay-context-recap');
  expect(deferred).toBeDefined();
  expect((deferred?.data as Record<string, unknown> | undefined)?.trivial).not.toBe(true);
  await h.start('short scene');
  await h.request(history(4, 'SILVER_COMPASS_MARKER'));
  expect(summary.detailed).toHaveBeenCalledTimes(1);
  expect(summary.detailed.mock.calls[0][1]).toContain('SILVER_COMPASS_MARKER turn 0');
  const committed = h.stored.findLast((entry) => entry.customType === 'roleplay-context-recap')?.data;
  expect(committed).toMatchObject({ coveredFrom: 0, coveredTo: 4, applied: true });
});

test('roleplay: dormant mode never cancels coding threshold compaction', async () => {
  const h = await harness();
  clearActivePersona();
  await h.dispatch('session_start');
  expect(
    await h.dispatch('session_before_compact', {
      type: 'session_before_compact',
      reason: 'threshold',
      preparation: {},
    }),
  ).toBeUndefined();
});

test('roleplay: persona cast switches drop old history and hydrate the new cast seed', async () => {
  const h = await harness();
  h.seed('cast-a', 'CAST_A_RECAP_MARKER');
  h.seed('cast-b', 'CAST_B_RECAP_MARKER');
  await h.dispatch('session_start');
  await h.start('a');
  expect(await h.request([user('OLD_A_HISTORY', 1)])).toContain('CAST_A_RECAP_MARKER');
  persona('cast-b');
  await h.start('b');
  const out = await h.request([user('OLD_A_HISTORY', 1), user('NEW_B_HISTORY', 2)]);
  expect(out).not.toContain('CAST_A_RECAP_MARKER');
  expect(out).not.toContain('OLD_A_HISTORY');
  expect(out).toContain('CAST_B_RECAP_MARKER');
  expect(out).toContain('NEW_B_HISTORY');
});

test('roleplay: a cast switch keeps its persisted initiating input even when the marker follows it', async () => {
  const h = await harness();
  const a = user('OLD_A', 1);
  const b = user('NEW_B', 2);
  h.stored.push({ type: 'message', id: 'a', message: a });
  await h.start('OLD_A');
  await h.request([a]);
  h.stored.push({ type: 'message', id: 'b', message: b });
  persona('cast-b');
  await h.start('NEW_B');
  const out = await h.request([a, b]);
  expect(out).toContain('NEW_B');
  expect(out).not.toContain('OLD_A');
});

test('roleplay: explicit cast overrides survive reload without hydrating another cast recap', async () => {
  const h = await harness();
  h.seed('cast-b', 'CAST_B_RECAP_MARKER');
  h.stored.push({
    type: 'custom',
    customType: 'roleplay-context-recap',
    data: { applied: true, recap: 'CAST_A_BRANCH_RECAP', coveredTo: 0 },
  });
  await h.command('cast cast-b');
  await h.start('b');
  let out = await h.request([user('b', 1)]);
  expect(out).not.toContain('CAST_A_BRANCH_RECAP');
  expect(out).toContain('CAST_B_RECAP_MARKER');
  await h.dispatch('session_start');
  await h.start('b');
  out = await h.request([user('b', 1)]);
  expect(out).toContain('CAST_B_RECAP_MARKER');
  expect(out).not.toContain('CAST_A_BRANCH_RECAP');
});

test('roleplay: an override set while dormant survives reload and later activation', async () => {
  const h = await harness();
  h.seed('cast-b', 'DORMANT_OVERRIDE_SEED');
  clearActivePersona();
  await h.dispatch('session_start');
  await h.command('cast cast-b');
  await h.dispatch('session_start');
  persona('cast-a');
  await h.start('activate');
  expect(await h.request([user('activate', 1)])).toContain('DORMANT_OVERRIDE_SEED');
});

test('roleplay: stale async recap cannot overwrite another cast carry-over', async () => {
  const h = await harness({ keepTurns: 2, recapAsync: true });
  h.seed('cast-b', 'CAST_B_SEED_SHOULD_SURVIVE');
  let release!: (value: { recap: string; raw: string }) => void;
  const pending = new Promise<{ recap: string; raw: string }>((resolve) => {
    release = resolve;
  });
  summary.detailed.mockReturnValueOnce(pending);
  const old = history(6);
  await h.start('a');
  await h.request(old);
  const signal = summary.detailed.mock.calls[0][0].signal;
  persona('cast-b');
  await h.start('b');
  await h.request([...old, user('b', 100)]);
  expect(signal?.aborted).toBe(true);
  release({ recap: 'CAST_A_ASYNC_RECAP', raw: 'CAST_A_ASYNC_RECAP' });
  await flush();
  expect(readFileSync(h.carry('cast-b'), 'utf8')).toContain('CAST_B_SEED_SHOULD_SURVIVE');
  expect(readFileSync(h.carry('cast-b'), 'utf8')).not.toContain('CAST_A_ASYNC_RECAP');
});

test('roleplay: newscene excludes old transcript before recaps and survives reload', async () => {
  const h = await harness({ keepTurns: 2 });
  const old = history(6);
  await h.start('old');
  await h.request(old);
  await h.command('newscene');
  summary.detailed.mockClear();
  await h.start('NEW_SCENE');
  let out = await h.request([...old, user('NEW_SCENE', 100)]);
  expect(summary.detailed).not.toHaveBeenCalled();
  expect(out).not.toContain('OLD_SCENE_MARKER');
  expect(out).not.toContain('GENERATED_RECAP');
  await h.dispatch('session_start');
  await h.start('NEW_SCENE');
  out = await h.request([...old, user('NEW_SCENE', 100)]);
  expect(out).not.toContain('OLD_SCENE_MARKER');
  expect(summary.detailed).not.toHaveBeenCalled();
  await h.start('NEW_SCENE');
  await h.request([...old, ...history(3, 'NEW_SCENE', 50)]);
  expect(summary.detailed).toHaveBeenCalledTimes(1);
  expect(summary.detailed.mock.calls[0][1]).not.toContain('OLD_SCENE_MARKER');
  expect(summary.detailed.mock.calls[0][1]).toContain('NEW_SCENE');
});

test('roleplay: newscene does not inherit a carry-over recreated after its archive', async () => {
  const h = await harness();
  await h.command('newscene');
  h.seed('cast-a', 'FOREIGN_RECREATED_SEED');
  await h.start('NEW_SCENE');
  expect(await h.request([user('NEW_SCENE', 100)])).not.toContain('FOREIGN_RECREATED_SEED');
});

test('roleplay: queued director events do not survive newscene', async () => {
  const h = await harness();
  await h.command('event');
  await h.command('newscene');
  await h.start('NEW_SCENE');
  expect(await h.request([user('NEW_SCENE', 100)])).not.toContain('OLD_EVENT_MARKER');
});

test('roleplay: an event generated across newscene cannot queue on the new scene', async () => {
  const h = await harness();
  events.enabled = true;
  let release!: (value: string) => void;
  events.generate.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      release = resolve;
    }),
  );
  const command = h.command('event');
  await flush();
  expect(events.generate).toHaveBeenCalledTimes(1);
  await h.command('newscene');
  release('LATE_OLD_EVENT');
  await command;
  await h.start('NEW_SCENE');
  expect(await h.request([user('NEW_SCENE', 100)])).not.toContain('LATE_OLD_EVENT');
});

test('roleplay: pinned character folds ignore same-id records of other kinds', async () => {
  const h = await harness();
  const cast = join(h.agent, 'roleplay', 'casts', 'cast-a');
  mkdirSync(join(cast, 'character'), { recursive: true });
  writeFileSync(
    join(cast, 'character', 'mira.md'),
    serializeEntry({
      name: 'Mira',
      description: 'character',
      kind: 'character',
      body: 'PINNED_CHARACTER_BODY',
      character: { ...emptyCharacterMeta(), pinned: true },
    }),
  );
  mkdirSync(join(cast, 'lore'), { recursive: true });
  writeFileSync(
    join(cast, 'lore', 'mira.md'),
    serializeEntry({
      name: 'Mira background lore',
      description: 'lore',
      kind: 'lore',
      body: 'LORE_BODY',
      lore: emptyLoreMeta(),
    }),
  );
  await h.dispatch('session_start');
  await h.start('ordinary prompt');
  expect(h.system()).toContain('PINNED_CHARACTER_BODY');
});

test('roleplay: newscene clears owned fact notes but preserves unrelated session notes', async () => {
  const h = await harness({ capture: true });
  const dir = join(h.agent, 'roleplay', 'casts', 'cast-a', 'facts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'old-scene-secret.md'),
    serializeEntry({ name: 'Old scene secret', description: 'OLD_SCENE_SECRET_MARKER', kind: 'summary', body: '' }),
  );
  const unrelated = memoryFileFor('session', 'note', 'user-note', h.ctx.cwd, 'audit-session');
  mkdirSync(join(unrelated, '..'), { recursive: true });
  writeFileSync(
    unrelated,
    serializeMemory({ name: 'User note', description: 'UNRELATED_USER_NOTE', type: 'note', body: 'User authored' }),
  );
  await h.dispatch('session_start');
  await h.start('old');
  await h.request([user('old', 1)]);
  const memory = memoryFileFor('session', 'note', 'old-scene-secret', h.ctx.cwd, 'audit-session');
  expect(readFileSync(memory, 'utf8')).toContain('roleplayFactCast');
  await h.command('newscene');
  expect(existsSync(memory)).toBe(false);
  expect(readFileSync(unrelated, 'utf8')).toContain('UNRELATED_USER_NOTE');
});

test('roleplay: implicit cast switching invalidates the real memory injector before its first reply', async () => {
  const h = await harness({ capture: true, memory: true });
  const dir = join(h.agent, 'roleplay', 'casts', 'cast-a', 'facts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'private-fact.md'),
    serializeEntry({ name: 'Private fact', description: 'CAST_A_PRIVATE_FACT', kind: 'summary', body: '' }),
  );
  await h.dispatch('session_start');
  await h.start('a');
  await h.request([user('a', 1)]);
  expect(existsSync(memoryFileFor('session', 'note', 'private-fact', h.ctx.cwd, 'audit-session'))).toBe(true);
  persona('cast-b');
  await h.start('b');
  expect(await h.request([user('a', 1), user('b', 3)])).not.toContain('CAST_A_PRIVATE_FACT');
});

test('roleplay: sync recap results are discarded after a scene reset during the await', async () => {
  const h = await harness({ keepTurns: 2 });
  let release!: (value: { recap: string; raw: string }) => void;
  summary.detailed.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await h.start('old');
  const request = h.request(history(6));
  await flush();
  expect(summary.detailed).toHaveBeenCalledTimes(1);
  await h.command('newscene');
  release({ recap: 'STALE_SYNC_RECAP', raw: 'STALE_SYNC_RECAP' });
  await request;
  expect(existsSync(h.carry('cast-a'))).toBe(false);
  expect(h.stored.filter((entry) => entry.customType === 'roleplay-context-recap')).toEqual([]);
});
