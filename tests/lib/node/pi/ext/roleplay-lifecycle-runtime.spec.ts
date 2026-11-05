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
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import roleplay from '../../../../../config/pi/extensions/roleplay.ts';
import cacheReminders from '../../../../../config/pi/extensions/cache-reminders.ts';
import memoryExtension from '../../../../../config/pi/extensions/memory.ts';
import { setActivePersona, clearActivePersona } from '../../../../../lib/node/pi/persona/active.ts';
import { emptyCharacterMeta, emptyLoreMeta, serializeEntry } from '../../../../../lib/node/pi/roleplay/store.ts';
import { fileFor as memoryFileFor } from '../../../../../lib/node/pi/memory-paths.ts';
import { serializeMemory } from '../../../../../lib/node/pi/memory-reducer.ts';
import { REMINDER_SNAPSHOT_TYPE } from '../../../../../lib/node/pi/reminder-lifecycle.ts';
import { reminderRequestChars } from '../../../../../lib/node/pi/reminder-budget.ts';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { updateCharsPerToken } from '../../../../../lib/node/pi/roleplay/context-window.ts';
import type * as summarizeModule from '../../../../../lib/node/pi/roleplay/summarize.ts';
import type * as eventModule from '../../../../../lib/node/pi/roleplay/event.ts';
import type * as childModule from '../../../../../lib/node/pi/ext/roleplay-child-session.ts';
vi.mock('../../../../../lib/node/pi/ext/roleplay-child-session.ts', async (original) => ({
  ...(await original<typeof childModule>()),
  loadRoleplayAgent: () => null,
}));

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
  projected: () => Message[];
  command: (args: string) => Promise<void>;
  dispatch: (name: string, event?: unknown) => Promise<unknown>;
  seed: (cast: string, body: string) => void;
  stored: Record<string, unknown>[];
  ctx: ExtensionContext;
  abort: ReturnType<typeof vi.fn>;
  notify: Mock<(message: string, type?: 'info' | 'warning' | 'error') => void>;
  failEntry: (type: string | null) => void;
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
  if (typeof config._authorNote === 'string') {
    vi.stubEnv('PI_ROLEPLAY_DISABLE_DEPTH_INJECT', '');
    setActivePersona({
      name: 'cast-a',
      cast: 'cast-a',
      roleplay: true,
      tools: ['read', 'roleplay'],
      resolvedWriteRoots: [],
      authorNote: config._authorNote,
      authorNoteDepth: 0,
    });
  }
  const basePrompt = typeof config._systemText === 'string' ? config._systemText : 'STATIC_BASE';
  let systemPrompt = basePrompt;
  const hooks = new Map<string, Handler[]>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const stored: Record<string, unknown>[] = [];
  const bus = new EventEmitter();
  const abort = vi.fn();
  const notify = vi.fn<(message: string, type?: 'info' | 'warning' | 'error') => void>();
  let failingEntry: string | null = null;
  const pi = {
    on: (name: string, handler: Handler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand: (name: string, def: Parameters<ExtensionAPI['registerCommand']>[1]) => commands.set(name, def),
    registerTool: vi.fn(),
    getActiveTools: () => ['read', 'roleplay'],
    getAllTools: () => [{ name: 'read' }, { name: 'roleplay' }],
    setActiveTools: vi.fn(),
    appendEntry: (customType: string, data: unknown) => {
      if (customType === failingEntry) throw new Error('synthetic append failure');
      stored.push({ type: 'custom', customType, data });
    },
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
    ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
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
    model: {
      id: 'fixture',
      provider: 'fixture',
      contextWindow: typeof config._windowTokens === 'number' ? config._windowTokens : 128000,
    },
    getSystemPrompt: () => systemPrompt,
    modelRegistry: { find: () => undefined },
    abort,
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
    systemPrompt = basePrompt;
    for (const fn of hooks.get('before_agent_start') ?? []) {
      const out = (await fn(
        { type: 'before_agent_start', messageType: 'user', prompt, systemPrompt, systemPromptOptions: promptOptions },
        ctx,
      )) as Result;
      if (out?.systemPrompt) systemPrompt = out.systemPrompt;
    }
  };
  let projected: Message[] = [];
  const request = async (messages: Message[]): Promise<string> => {
    const out = await ExtensionRunner.prototype.emitContext.call(runner, [
      config._structuredHead === true
        ? { role: 'system', content: '', sections: { base: systemPrompt }, timestamp: 0 }
        : { role: 'system', content: systemPrompt, timestamp: 0 },
      ...messages,
    ]);
    expect(errors).toEqual([]);
    projected = out;
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
    projected: () => projected,
    command,
    dispatch,
    seed,
    stored,
    ctx,
    abort,
    notify,
    agent,
    failEntry: (type: string | null) => {
      failingEntry = type;
    },
    system: () => systemPrompt,
    carry: (cast: string) => join(agent, 'roleplay', 'casts', cast, 'summary', 'auto.md'),
  };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('roleplay: full-prompt target recaps before dropping a middle while preserving the opener', async () => {
  const h = await harness({ keepTurns: 50, pinSceneOpener: true, promptTokenTarget: 2500, recapMaxAdvance: 4 });
  const dialogue = history(12, 'TOKEN_TARGET');
  for (const message of dialogue)
    if ('content' in message && Array.isArray(message.content))
      message.content = [{ type: 'text', text: `${text(message)} ${'detail '.repeat(220)}` }];
  const before = JSON.stringify(dialogue);
  await h.start('latest scene');
  await h.request(dialogue);
  expect(h.abort).not.toHaveBeenCalled();
  expect(summary.detailed).toHaveBeenCalled();
  const projected = h.projected();
  expect(projected.some((message) => message.timestamp === dialogue[0].timestamp)).toBe(true);
  expect(projected.some((message) => message.timestamp === dialogue[2].timestamp)).toBe(false);
  expect(JSON.stringify(projected).indexOf('GENERATED_RECAP')).toBeGreaterThan(
    JSON.stringify(projected).indexOf('TOKEN_TARGET turn 0'),
  );
  expect(JSON.stringify(dialogue)).toBe(before);
  const audit = h.stored.filter((entry) => entry.customType === 'roleplay-context-recap');
  expect(audit.some((entry) => (entry.data as Record<string, unknown>).mode === 'budget')).toBe(true);
});

test('roleplay: a rejected soft-target recap keeps physically fitting history instead of aborting', async () => {
  const h = await harness({ keepTurns: 50, promptTokenTarget: 1500 });
  summary.detailed.mockResolvedValue({ recap: null, raw: null });
  const dialogue = [user('PRIVATE_PROTECTED ' + 'detail '.repeat(1800), 1), user('LATEST_ACTION', 2)];
  await h.start('LATEST_ACTION');
  const out = await h.request(dialogue);
  expect(out).toContain('PRIVATE_PROTECTED');
  expect(out).toContain('LATEST_ACTION');
  expect(h.abort).not.toHaveBeenCalled();
});

test('roleplay: request/debug defaults are content-free and content persistence is explicit', async () => {
  const h = await harness();
  const marker = 'PRIVATE_ROLEPLAY_MARKER';
  const dialogue = [user(marker, 1)];
  await h.start(marker);
  await h.request(dialogue);
  const notifications = h.notify;
  await h.command('request');
  expect(notifications.mock.calls.at(-1)?.[0]).not.toContain(marker);
  await h.command('debug --json');
  expect(notifications.mock.calls.at(-1)?.[0]).not.toContain(marker);
  expect(JSON.stringify(h.stored.filter((entry) => entry.customType === 'roleplay-request'))).not.toContain(marker);
  await h.command('request --section head --content');
  expect(notifications.mock.calls.at(-1)?.[0]).toContain(marker);
  await h.dispatch('session_tree');
  await h.command('request --section head --content');
  expect(notifications.mock.calls.at(-1)?.[0]).not.toContain(marker);
  await h.command('request capture on');
  await h.start(marker);
  await h.request(dialogue);
  await h.dispatch('session_tree');
  await h.command('request --section head --content');
  expect(notifications.mock.calls.at(-1)?.[0]).toContain(marker);
});

test('roleplay: a soft-target scheduling exception preserves hard-safe uncovered history', async () => {
  const h = await harness({ keepTurns: 50, promptTokenTarget: 1500, capture: true });
  h.failEntry('roleplay-extraction-job');
  const dialogue = [user('UNCOVERED_ORIGINAL ' + 'detail '.repeat(1800), 1), user('LATEST_ACTION', 2)];
  await h.start('LATEST_ACTION');
  const out = await h.request(dialogue);
  expect(out).toContain('UNCOVERED_ORIGINAL');
  expect(out).toContain('LATEST_ACTION');
  expect(h.abort).not.toHaveBeenCalled();
});

test('roleplay: overlapping captures cannot claim a delayed earlier response as latest usage', async () => {
  const h = await harness();
  await h.start('A');
  await h.request([user('A', 1)]);
  await h.start('B');
  await h.request([user('A', 1), user('B', 2)]);
  await h.dispatch('message_end', {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'EARLIER_A' }],
      timestamp: 3,
      model: 'fixture',
      provider: 'fixture',
      stopReason: 'stop',
      usage: { input: 123, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  });
  await h.command('request --json');
  const output = String(h.notify.mock.calls.at(-1)?.[0]);
  expect(JSON.parse(output)).toMatchObject({ turnOrdinal: 2, outcome: 'projected' });
  expect(output).not.toContain('reportedInputTokens');
});

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

test('roleplay: keepTurns 50 preserves the beginning through 13 structured-head requests and budget pressure', async () => {
  const h = await harness({
    keepTurns: 50,
    recapChunk: 8,
    recapStride: 8,
    capture: true,
    timeline: true,
    timelineMaxInjectChars: 3000,
    loreCharBudget: 8000,
    recapAsync: true,
    depthLoreInlineTail: true,
    _windowTokens: 53248,
    _systemText: 'SYSTEM_GUIDANCE '.repeat(7000),
    _structuredHead: true,
    _authorNote: 'AUTHOR_GUIDANCE '.repeat(270),
  });
  const dialogue: Message[] = [];
  const marker = 'SCENE_BEGINNING_MUST_SURVIVE';
  let firstSnapshot: Record<string, unknown> | undefined;
  let firstSnapshotBytes = '';
  summary.detailed.mockImplementation(async (_ctx, span, prior = '') => ({
    recap: `${prior}\n${span}`.slice(0, 5000),
    raw: `${prior}\n${span}`.slice(0, 5000),
  }));
  for (let turn = 1; turn <= 13; turn++) {
    const prompt = turn === 1 ? `${marker} ${'opening '.repeat(100)}` : `CONTINUE_${turn} ${'scene '.repeat(180)}`;
    const message = user(prompt, turn * 2);
    dialogue.push(message);
    await h.start(prompt);
    const output = await h.request(dialogue);
    expect(output).toContain(marker);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.projected()[0]).toMatchObject({ role: 'system', content: '', sections: { base: h.system() } });
    firstSnapshot ??= h.stored.find((entry) => entry.customType === REMINDER_SNAPSHOT_TYPE);
    expect(firstSnapshot).toBeDefined();
    firstSnapshotBytes ||= JSON.stringify(firstSnapshot);
    expect(JSON.stringify(firstSnapshot)).toBe(firstSnapshotBytes);
    // Synthetic provider usage tracks this exact request at three chars per input token.
    const inputTokens = Math.ceil(
      reminderRequestChars(h.projected() as unknown as readonly ReminderMessage[], h.system()) / 3,
    );
    const reply: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'REPLY '.repeat(350) },
        { type: 'thinking', thinking: 'THOUGHT '.repeat(300), thinkingSignature: 'fixture' },
      ],
      timestamp: turn * 2 + 1,
      api: 'anthropic-messages',
      provider: 'fixture',
      model: 'fixture',
      usage: { ...usage, input: inputTokens, output: 5000, totalTokens: inputTokens + 5000 },
      stopReason: 'stop',
    };
    dialogue.push(reply);
    await h.dispatch('message_end', { type: 'message_end', message: reply });
  }
  const emergency = h.stored
    .filter((entry) => entry.customType === 'roleplay-context-recap')
    .map((entry) => entry.data as Record<string, unknown>);
  expect(emergency.some((entry) => entry.mode === 'budget' && entry.applied === true)).toBe(true);
  expect(emergency.some((entry) => entry.mode === 'async')).toBe(false);
  expect(firstSnapshot).toBeDefined();
  expect(h.projected().some((message) => message.role === 'user' && message.timestamp === dialogue[0].timestamp)).toBe(
    false,
  );
});

test('roleplay: a short emergency recap survives the next turn and reload above natural zero', async () => {
  const h = await harness({ keepTurns: 50, recapAsync: true, summarizeMinMessages: 20, _windowTokens: 4096 });
  const older = user('BEGINNING_MARKER ' + 'detail '.repeat(1800), 1);
  const latest = user('LATEST_SCENE', 2);
  summary.detailed.mockResolvedValue({ recap: 'BEGINNING_MARKER preserved', raw: 'BEGINNING_MARKER preserved' });
  await h.start('LATEST_SCENE');
  expect(await h.request([older, latest])).toContain('BEGINNING_MARKER');
  expect(summary.detailed).toHaveBeenCalledTimes(1);
  expect(summary.detailed.mock.calls[0][1]).toContain('BEGINNING_MARKER');
  expect(h.projected().some((message) => message.role === 'user' && message.timestamp === 1)).toBe(false);
  const audit = h.stored.find((entry) => entry.customType === 'roleplay-context-recap')?.data as
    | Record<string, unknown>
    | undefined;
  expect(audit).toMatchObject({ mode: 'budget', coveredFrom: 0, coveredTo: 1, applied: true });
  expect(typeof audit?.anchor).toBe('string');
  const next = user('NEXT_SCENE', 3);
  await h.start('NEXT_SCENE');
  expect(await h.request([older, latest, next])).toContain('BEGINNING_MARKER');
  await h.dispatch('session_start');
  await h.start('NEXT_SCENE');
  expect(await h.request([older, latest, next])).toContain('BEGINNING_MARKER');
  expect(h.projected().some((message) => message.role === 'user' && message.timestamp === 1)).toBe(false);
  expect(summary.detailed).toHaveBeenCalledTimes(1);
  expect(h.abort).not.toHaveBeenCalled();
});

test('roleplay: a failed safety summarizer aborts before snapshot or capture side effects', async () => {
  const h = await harness({ keepTurns: 50, recapAsync: true, capture: true, timeline: true, _windowTokens: 4096 });
  summary.detailed.mockResolvedValue({ recap: null, raw: null });
  await h.start('LATEST_SCENE');
  const out = await h.request([user('UNcovered_START ' + 'detail '.repeat(1800), 1), user('LATEST_SCENE', 2)]);
  expect(h.abort).toHaveBeenCalledTimes(1);
  expect(out).not.toContain('UNcovered_START');
  expect(out).not.toContain('LATEST_SCENE');
  expect(existsSync(h.carry('cast-a'))).toBe(false);
  expect(h.stored.some((entry) => entry.customType === REMINDER_SNAPSHOT_TYPE)).toBe(false);
  expect(h.stored.some((entry) => entry.customType === 'roleplay-timeline')).toBe(false);
  expect(h.stored.some((entry) => entry.customType === 'roleplay-context-window-state')).toBe(false);
  expect(h.stored.find((entry) => entry.customType === 'roleplay-context-recap')?.data).toMatchObject({
    applied: false,
    mode: 'budget',
  });
});

test.each(['accept', 'reset'] as const)(
  'roleplay: urgent budget wait handles a normal async recap on %s',
  async (outcome) => {
    const h = await harness({ keepTurns: 2, recapAsync: true });
    interface Recap {
      recap: string | null;
      raw: string | null;
    }
    let release!: (value: Recap) => void;
    summary.detailed.mockReturnValueOnce(
      new Promise<Recap>((resolve) => {
        release = resolve;
      }),
    );
    const dialogue = history(6, 'ASYNC_BEGINNING ' + 'detail '.repeat(400));
    await h.start('continue');
    // Normal age-based async recap must not block the request.
    expect(await h.request(dialogue)).toContain('ASYNC_BEGINNING');
    expect(summary.detailed).toHaveBeenCalledTimes(1);
    h.ctx.model!.contextWindow = 4096;
    let settled = false;
    const urgent = h.request(dialogue).then((output) => {
      settled = true;
      return output;
    });
    await flush();
    expect(settled).toBe(false);
    if (outcome === 'reset') await h.command('newscene');
    release({ recap: 'ASYNC_BEGINNING safely preserved', raw: 'ASYNC_BEGINNING safely preserved' });
    const output = await urgent;
    const accepted = outcome === 'accept';
    expect(output.includes('ASYNC_BEGINNING safely preserved')).toBe(accepted);
    expect(output.includes('ASYNC_BEGINNING')).toBe(accepted);
    expect(h.abort).toHaveBeenCalledTimes(accepted ? 0 : 1);
    expect(summary.detailed).toHaveBeenCalledTimes(1);
    expect(existsSync(h.carry('cast-a'))).toBe(accepted);
    const audits = h.stored
      .filter((entry) => entry.customType === 'roleplay-context-recap')
      .map((entry) => entry.data as { mode?: unknown; applied?: unknown });
    expect(audits.map((audit) => [audit.mode, audit.applied])).toEqual(accepted ? [['async', true]] : []);
  },
);

test('roleplay: safety recaps advance in bounded user-aligned increments', async () => {
  const h = await harness({ keepTurns: 50, recapAsync: true, recapMaxAdvance: 2, _windowTokens: 4096 });
  summary.detailed.mockResolvedValue({
    recap: 'BOUNDED_BEGINNING safely preserved',
    raw: 'BOUNDED_BEGINNING safely preserved',
  });
  const dialogue = history(6, 'BOUNDED_BEGINNING ' + 'detail '.repeat(400));
  await h.start('continue');
  expect(await h.request(dialogue)).toContain('BOUNDED_BEGINNING safely preserved');
  const audits = h.stored
    .filter((entry) => entry.customType === 'roleplay-context-recap')
    .map((entry) => entry.data as { mode: string; applied: boolean; coveredFrom: number; coveredTo: number });
  expect(audits.length).toBeGreaterThan(1);
  let covered = 0;
  for (const audit of audits) {
    expect(audit).toMatchObject({ mode: 'budget', applied: true, coveredFrom: covered });
    expect(audit.coveredTo - audit.coveredFrom).toBeLessThanOrEqual(2);
    expect(dialogue[audit.coveredTo].role).toBe('user');
    covered = audit.coveredTo;
  }
  expect(h.abort).not.toHaveBeenCalled();
});

test('roleplay: calibration pairs full structured-head request with input-only message_end usage', async () => {
  const h = await harness({ _systemText: 'STATIC_GUIDANCE '.repeat(1000), _structuredHead: true });
  const input = user('small scene', 1);
  await h.start('small scene');
  await h.request([input]);
  const chars = reminderRequestChars(h.projected() as unknown as readonly ReminderMessage[], h.system());
  const reply = history(1)[1];
  if (reply.role !== 'assistant') throw new Error('fixture must be assistant');
  reply.usage = { ...usage, input: 10000, cacheRead: 2000, cacheWrite: 3000, output: 40000, totalTokens: 55000 };
  await h.dispatch('message_end', { type: 'message_end', message: reply });
  await h.start('next scene');
  await h.request([input, user('next scene', 2)]);
  const checkpoint = h.stored.findLast((entry) => entry.customType === 'roleplay-context-window-state')?.data as {
    charsPerToken: number;
  };
  expect(checkpoint.charsPerToken).toBeCloseTo(updateCharsPerToken(4, chars, 15000));
  expect(checkpoint.charsPerToken).not.toBeCloseTo(updateCharsPerToken(4, chars, 55000));
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
