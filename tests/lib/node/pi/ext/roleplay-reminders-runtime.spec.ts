/* eslint-disable no-await-in-loop -- Dispatch actual hooks and requests in runtime order. */
import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  NormalizedBuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import cacheReminders from '../../../../../config/pi/extensions/cache-reminders.ts';
import roleplay from '../../../../../config/pi/extensions/roleplay.ts';
import secretRedactor from '../../../../../config/pi/extensions/secret-redactor.ts';
import memoryExtension from '../../../../../config/pi/extensions/memory.ts';
import { reminderRequestChars } from '../../../../../lib/node/pi/reminder-budget.ts';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { REMINDER_CAPABILITIES } from '../../../../../lib/node/pi/reminder-lifecycle.ts';
import { clearActivePersona, setActivePersona } from '../../../../../lib/node/pi/persona/active.ts';
import { readReminderSnapshots, REMINDER_SNAPSHOT_TYPE } from '../../../../../lib/node/pi/reminder-lifecycle.ts';
import { emptyLoreMeta, serializeEntry, type LoreMeta } from '../../../../../lib/node/pi/roleplay/store.ts';
import type * as eventModule from '../../../../../lib/node/pi/roleplay/event.ts';

// Scene events use the real command/deck/consume lifecycle, but never launch a child model.
vi.mock('../../../../../lib/node/pi/roleplay/event.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof eventModule>()),
  createEventGenerator: () => ({ isEnabled: () => false }),
}));

type Message = ContextEvent['messages'][number];
type ExtensionCommandDefinition = Parameters<ExtensionAPI['registerCommand']>[1];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type MessageResult = { messages?: Message[]; systemPrompt?: string } | undefined;
const dirs: string[] = [];
const shutdowns: (() => Promise<void>)[] = [];

beforeEach(() => {
  for (const flag of [
    'PI_ROLEPLAY_DISABLED',
    'PI_ROLEPLAY_DISABLE_AUTOINJECT',
    'PI_ROLEPLAY_DISABLE_LOREBOOK',
    'PI_ROLEPLAY_DISABLE_DEPTH_INJECT',
    'PI_ROLEPLAY_DISABLE_EVENTS',
    'PI_CACHE_REMINDERS_DISABLED',
    'PI_ROLEPLAY_ROOT',
    'PI_SECRET_REDACTOR_DISABLED',
    'PI_SECRET_REDACTOR_VERBOSE',
    'PI_SECRET_REDACTOR_TRACE',
  ])
    vi.stubEnv(flag, '');
  for (const aspect of ['CONTEXT_WINDOW', 'SUMMARIZE', 'AVATAR', 'SCENEGEN', 'REPETITION']) {
    vi.stubEnv(`PI_ROLEPLAY_DISABLE_${aspect}`, '1');
  }
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  clearActivePersona();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function user(content: string, timestamp = 1): Extract<Message, { role: 'user' }> {
  return { role: 'user', content: [{ type: 'text', text: content }], timestamp };
}

function custom(customType: string, content: string, timestamp = 1): Message & { role: 'custom' } {
  return { role: 'custom', customType, content: [{ type: 'text', text: content }], display: true, timestamp };
}

function toolExchange(keyword = 'spire', timestamp = 2): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `read-${timestamp}`, name: 'read', arguments: { path: 'scene.txt' } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'fixture',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp,
    },
    {
      role: 'toolResult',
      toolCallId: `read-${timestamp}`,
      toolName: 'read',
      content: [{ type: 'text', text: keyword }],
      isError: false,
      timestamp: timestamp + 1,
    },
  ];
}

function snapshots(messages: Message[]): Message[] {
  return messages.filter((message) => (message as unknown as Record<string, unknown>).cacheReminderSnapshot === true);
}

function text(message: Message): string {
  if (!('content' in message)) return '';
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => ('text' in part ? part.text : '')).join('\n');
}

interface Harness {
  lore: (id: string, body: string, meta?: Partial<LoreMeta>) => void;
  start: (message: Message) => Promise<void>;
  request: (history: Message[], pause?: () => Promise<void>) => Promise<Message[]>;
  aborts: () => number;
  mutateTargets: () => void;
  compact: () => Promise<void>;
  command: (name: string, args: string) => Promise<void>;
  dispatch: (name: string, event: unknown) => Promise<void>;
  records: () => ReturnType<typeof readReminderSnapshots>;
  queueEvent: () => Promise<void>;
  snapshotEntryCount: () => number;
}

async function harness(
  options: {
    note?: boolean;
    inline?: boolean;
    authorDepth?: number;
    loreDepth?: number;
    noteText?: string;
    windowTokens?: number;
    redactor?: 'before' | 'after';
    disableCache?: boolean;
    failSanitizer?: boolean;
    confirmReveal?: boolean;
    memory?: boolean;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'roleplay-reminder-runtime-'));
  dirs.push(dir);
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  if (options.windowTokens) vi.stubEnv('PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW', '');
  if (options.disableCache) vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '1');
  if (options.memory) {
    vi.stubEnv('PI_MEMORY_ROOT', join(dir, 'memory'));
    for (const name of [
      'PI_MEMORY_DISABLED',
      'PI_MEMORY_READONLY',
      'PI_MEMORY_DISABLE_CAPTURE',
      'PI_MEMORY_DISABLE_AUTOINJECT',
      'PI_MEMORY_CAPTURE_TURN',
    ])
      vi.stubEnv(name, '');
  }
  writeFileSync(
    join(agentDir, 'roleplay.json'),
    JSON.stringify({
      imageMode: 'off',
      depthLoreInlineTail: options.inline ?? true,
      events: ['QUEUED_EVENT_MARKER'],
    }),
  );
  setActivePersona({
    name: 'runtime-fixture',
    cast: 'runtime-fixture',
    roleplay: true,
    tools: ['roleplay', 'read'],
    resolvedWriteRoots: [],
    ...(options.note
      ? {
          authorNote: options.noteText ?? 'AUTHOR_NOTE {{random:alpha,beta}}',
          authorNoteDepth: options.authorDepth ?? 0,
        }
      : {}),
  });
  const lore = (id: string, body: string, meta: Partial<LoreMeta> = {}): void => {
    const path = join(agentDir, 'roleplay', 'casts', 'runtime-fixture', 'lore', `${id}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      serializeEntry({
        name: id,
        description: `${id} fixture`,
        kind: 'lore',
        body,
        lore: { ...emptyLoreMeta(), ...meta },
      }),
    );
  };
  lore('reef-primary', 'PRIMARY_REEF {{random:alpha,beta}}', { triggers: ['reef'], depth: 0 });
  lore('reef-secondary', 'SECONDARY_REEF {{random:alpha,beta}}', { triggers: ['reef'], depth: options.loreDepth ?? 0 });
  lore('spire-secondary', 'TOOL_ONLY_LORE', { triggers: ['spire'], depth: 0 });
  lore('reef-keyword', 'KEYWORD_REEF {{random:alpha,beta}}', { triggers: ['reef'] });
  lore('spire-keyword', 'KEYWORD_SPIRE', { triggers: ['spire'] });
  lore('delayed', 'DELAYED_LORE_MARKER', { triggers: ['vault'], delay: 2 });

  const hooks = new Map<string, Handler[]>();
  const commands = new Map<string, ExtensionCommandDefinition>();
  const stored: ({ type: 'custom'; customType: string; data: unknown } | { type: 'compaction' })[] = [];
  const bus = new EventEmitter();
  const pi = {
    on: (name: string, handler: Handler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () =>
        hooks.set(
          name,
          hooks.get(name)!.filter((entry) => entry !== handler),
        );
    },
    registerCommand: (name: string, definition: ExtensionCommandDefinition) => commands.set(name, definition),
    registerTool: vi.fn(),
    getActiveTools: () => ['read', 'roleplay'],
    getAllTools: () => [{ name: 'read' }, { name: 'roleplay' }],
    setActiveTools: vi.fn(),
    appendEntry: (customType: string, data: unknown) => stored.push({ type: 'custom', customType, data }),
    events: {
      on: (name: string, listener: (data: unknown) => void) => {
        bus.on(name, listener);
        return () => {
          bus.off(name, listener);
        };
      },
      emit: (name: string, data: unknown) => {
        bus.emit(name, data);
      },
    },
  } as unknown as ExtensionAPI;
  const notify = vi.fn();
  let aborts = 0;
  let beforeProjection: (() => Promise<void>) | undefined;
  let changeTargets = false;
  const ctx = {
    cwd: dir,
    hasUI: false,
    ui: { notify, setStatus: vi.fn(), setWidget: vi.fn(), confirm: vi.fn(async () => options.confirmReveal === true) },
    sessionManager: { getBranch: () => stored, getSessionId: () => 'runtime-fixture' },
    modelRegistry: {},
    ...(options.windowTokens ? { model: { contextWindow: options.windowTokens } } : {}),
    abort: () => {
      aborts += 1;
    },
  } as unknown as ExtensionContext;
  if (options.redactor === 'before') secretRedactor(pi);
  if (options.memory) memoryExtension(pi);
  roleplay(pi);
  pi.on('context', (event) =>
    changeTargets
      ? {
          messages: event.messages.map((message) =>
            message.role === 'assistant'
              ? {
                  ...message,
                  content: message.content.map((part) =>
                    part.type === 'toolCall' ? { ...part, arguments: {} } : part,
                  ),
                }
              : message,
          ),
        }
      : undefined,
  );
  pi.on('context_with_system', async () => {
    const pause = beforeProjection;
    beforeProjection = undefined;
    await pause?.();
  });
  cacheReminders(pi);
  if (options.redactor === 'after') secretRedactor(pi);
  if (options.failSanitizer)
    pi.events.on(REMINDER_CAPABILITIES, (request) => {
      (request as { sanitizerRequired: boolean }).sanitizerRequired = true;
    });
  // Use the installed SDK's two-phase runner, including system restoration
  // and its error path, rather than a hand-written context-hook simulation.
  const errors: unknown[] = [];
  const runner = {
    extensions: [{ path: 'runtime-fixture', handlers: hooks }],
    createContext: () => ctx,
    emitError: (error: unknown) => errors.push(error),
  } as unknown as ExtensionRunner;

  const dispatch = async (name: string, event: unknown): Promise<void> => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  const promptOptions: NormalizedBuildSystemPromptOptions = {
    cwd: dir,
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: '',
    sections: {},
    contextFiles: [],
    skills: [],
  };
  let systemPrompt = 'STATIC_BASE';
  const start = async (message: Message): Promise<void> => {
    const base = {
      type: 'before_agent_start' as const,
      systemPrompt: 'STATIC_BASE',
      systemPromptOptions: promptOptions,
    };
    const event: BeforeAgentStartEvent =
      message.role === 'custom'
        ? { ...base, messageType: 'custom', message }
        : { ...base, messageType: 'user', prompt: text(message) };
    systemPrompt = 'STATIC_BASE';
    for (const handler of hooks.get('before_agent_start') ?? []) {
      const result = (await handler({ ...event, systemPrompt }, ctx)) as MessageResult;
      if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
    }
  };
  const request = async (history: Message[], pause?: () => Promise<void>): Promise<Message[]> => {
    beforeProjection = pause;
    const messages: Message[] = [{ role: 'system', content: systemPrompt, timestamp: 0 }, ...structuredClone(history)];
    const result = await ExtensionRunner.prototype.emitContext.call(runner, messages);
    expect(errors).toEqual([]);
    return result;
  };
  await dispatch('session_start', { type: 'session_start' });
  shutdowns.push(() => dispatch('session_shutdown', { type: 'session_shutdown' }));
  return {
    lore,
    start,
    request,
    dispatch,
    aborts: () => aborts,
    mutateTargets: () => {
      changeTargets = true;
    },
    compact: async () => {
      stored.push({ type: 'compaction' });
      await dispatch('session_compact', { type: 'session_compact' });
    },
    command: async (name, args) => {
      await commands.get(name)!.handler(args, ctx as ExtensionCommandContext);
    },
    records: () => readReminderSnapshots(stored),
    queueEvent: async () => {
      await commands.get('roleplay')!.handler('event', ctx as ExtensionCommandContext);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('QUEUED_EVENT_MARKER'), 'info');
    },
    snapshotEntryCount: () =>
      stored.filter((entry) => entry.type === 'custom' && entry.customType === REMINDER_SNAPSHOT_TYPE).length,
  };
}

test('actual lore and author-note snapshot freezes input order and the request prefix', async () => {
  const h = await harness({ note: true });
  const input = user('reef');
  await h.start(input);
  const first = await h.request([input]);
  expect(first).toHaveLength(3); // system, initiating input, one managed snapshot.
  expect(first[1].role).toBe('user');
  expect(text(first[1])).toBe('reef');
  expect(snapshots(first)).toEqual([first[2]]);
  const body = text(first[2]);
  expect(body).toContain('<system-reminder id="roleplay-depth">');
  expect(body).toContain('PRIMARY_REEF alpha');
  expect(body).toContain('SECONDARY_REEF alpha');
  expect(body).toContain('AUTHOR_NOTE alpha');
  expect(body).toContain('<system-reminder id="roleplay-lore">');
  expect(body).toContain('KEYWORD_REEF alpha');
  expect(body.indexOf('id="roleplay-depth"')).toBeLessThan(body.indexOf('id="roleplay-lore"'));
  expect(text(first[0])).not.toMatch(/PRIMARY_REEF|SECONDARY_REEF|AUTHOR_NOTE|KEYWORD_REEF/);
  expect(h.records()[0].specs.map((spec) => spec.id)).toEqual(['roleplay-depth', 'roleplay-lore']);
  const bytes = JSON.stringify(first);
  const count = h.snapshotEntryCount();

  vi.mocked(Math.random).mockReturnValue(0.99);
  h.lore('reef-primary', 'EDITED_PRIMARY beta', { triggers: ['reef'], depth: 0 });
  h.lore('reef-secondary', 'EDITED_SECONDARY beta', { triggers: ['reef'], depth: 0 });
  h.lore('reef-keyword', 'EDITED_KEYWORD beta', { triggers: ['reef'] });
  const exchange = toolExchange();
  for (const tail of [[exchange[0]], exchange]) {
    const next = await h.request([input, ...tail]);
    expect(JSON.stringify(next.slice(0, first.length))).toBe(bytes);
    expect(snapshots(next)).toEqual(snapshots(first));
    expect(JSON.stringify(next)).not.toMatch(/TOOL_ONLY_LORE|KEYWORD_SPIRE|EDITED_/);
    expect(h.snapshotEntryCount()).toBe(count);
  }

  const toolHistory = [input, ...exchange];
  for (let i = 0; i < 8; i++) {
    toolHistory.push(...toolExchange('spire', 4 + i * 2));
    const continued = await h.request(toolHistory);
    expect(JSON.stringify(continued.slice(0, first.length))).toBe(bytes);
    expect(snapshots(continued)).toEqual(snapshots(first));
    expect(h.snapshotEntryCount()).toBe(count);
  }

  const nextInput = user('reef spire', 30);
  await h.start(nextInput);
  const fresh = await h.request([...toolHistory, nextInput]);
  expect(JSON.stringify(fresh.slice(0, first.length))).toBe(bytes);
  expect(snapshots(fresh)).toHaveLength(2);
  expect(fresh.at(-2)?.role).toBe('user');
  expect(fresh.at(-2)?.timestamp).toBe(nextInput.timestamp);
  expect(text(fresh.at(-2)!)).toBe('reef spire');
  expect(text(fresh.at(-1)!)).toContain('EDITED_PRIMARY beta');
  expect(text(fresh.at(-1)!)).toContain('EDITED_KEYWORD beta');
  expect(text(fresh.at(-1)!)).toContain('AUTHOR_NOTE beta');
  expect(text(fresh.at(-1)!)).toContain('TOOL_ONLY_LORE');
  expect(text(fresh.at(-1)!)).toContain('KEYWORD_SPIRE');
  expect(h.snapshotEntryCount()).toBe(count + 1);
});

test('standalone positive lore and author-note depths resolve once and survive tools and branch restore', async () => {
  const h = await harness({ note: true, inline: false, authorDepth: 1, loreDepth: 2 });
  const oldInput = user('older scene', 1);
  const reply = {
    ...(toolExchange('unused', 2)[0] as Extract<Message, { role: 'assistant' }>),
    content: [{ type: 'text' as const, text: 'older reply' }],
    stopReason: 'stop' as const,
  };
  const input = user('reef', 3);
  const history = [oldInput, reply, input];
  await h.start(input);
  const first = await h.request(history);
  const bodies = first.map(text);
  const secondary = bodies.findIndex((body) => body.includes('SECONDARY_REEF'));
  const note = bodies.findIndex((body) => body.includes('AUTHOR_NOTE'));
  const primary = bodies.findIndex((body) => body.includes('PRIMARY_REEF'));
  expect(secondary).toBeLessThan(bodies.indexOf('older reply'));
  expect(note).toBeGreaterThan(bodies.indexOf('older reply'));
  expect(note).toBeLessThan(bodies.indexOf('reef'));
  expect(primary).toBeGreaterThan(bodies.indexOf('reef'));
  expect(h.records()[0].placements).toHaveLength(3);
  expect(h.records()[0].specs.map((spec) => spec.id)).toEqual(['roleplay-lore']);
  const record = structuredClone(h.records()[0]);
  const bytes = JSON.stringify(first);
  const exchange = toolExchange('spire', 4);
  vi.mocked(Math.random).mockReturnValue(0.99);
  h.lore('reef-secondary', 'UPDATED_SECONDARY beta', { triggers: ['reef'], depth: 2 });
  for (let i = 0; i < 3; i++) {
    const grown = await h.request([...history, ...exchange]);
    expect(JSON.stringify(grown.slice(0, first.length))).toBe(bytes);
    expect(JSON.stringify(grown)).not.toMatch(/UPDATED_SECONDARY|TOOL_ONLY_LORE/);
    expect(h.records()[0]).toEqual(record);
  }
  await h.dispatch('session_tree', { type: 'session_tree' });
  const restored = await h.request([...history, ...exchange]);
  expect(JSON.stringify(restored.slice(0, first.length))).toBe(bytes);

  const next = user('reef', 10);
  await h.start(next);
  const refreshed = await h.request([...history, ...exchange, next]);
  expect(JSON.stringify(refreshed.slice(0, first.length))).toBe(bytes);
  expect(h.records()[0]).toEqual(record);
  expect(h.records()).toHaveLength(2);
  expect(h.records()[1].placements?.some((placement) => placement.text.includes('UPDATED_SECONDARY beta'))).toBe(true);
  const updatedIndex = refreshed.findIndex((message) => text(message).includes('UPDATED_SECONDARY beta'));
  const toolIndex = refreshed.findIndex((message) => message.role === 'assistant' && message.timestamp === 4);
  expect(updatedIndex).toBeLessThan(toolIndex); // Depth would land inside this tool batch; move before it instead.
});

test('placement-only depth-zero author note follows its initiating input without an empty generic snapshot', async () => {
  const h = await harness({ note: true, inline: false, authorDepth: 0 });
  const input = user('quiet scene');
  await h.start(input);
  const first = await h.request([input]);
  expect(first).toHaveLength(3);
  expect(text(first[1])).toBe('quiet scene');
  expect(text(first[2])).toBe("[Author's note: AUTHOR_NOTE alpha]");
  expect(h.records()[0].specs).toEqual([]);
  expect(h.records()[0].placements).toHaveLength(1);
  expect((await h.request([input, ...toolExchange()])).slice(0, first.length)).toEqual(first);
});

test('an initially empty lore selection cannot be activated by a tool keyword, but a new user can activate it', async () => {
  const h = await harness();
  const input = user('ordinary conversation');
  await h.start(input);
  const first = await h.request([input]);
  expect(snapshots(first)).toHaveLength(0);
  const count = h.snapshotEntryCount();
  const exchange = toolExchange();
  const afterTool = await h.request([input, ...exchange]);
  expect(afterTool.slice(0, first.length)).toEqual(first);
  expect(JSON.stringify(afterTool)).not.toMatch(/TOOL_ONLY_LORE|KEYWORD_SPIRE|roleplay-depth|roleplay-lore/);
  expect(h.snapshotEntryCount()).toBe(count);
  const next = user('spire', 10);
  await h.start(next);
  const activated = await h.request([input, ...exchange, next]);
  expect(snapshots(activated)).toHaveLength(1);
  expect(activated.at(-2)?.timestamp).toBe(10);
  expect(text(activated.at(-1)!)).toContain('TOOL_ONLY_LORE');
  expect(text(activated.at(-1)!)).toContain('KEYWORD_SPIRE');
});

test.each(['bg-bash-completion', 'verify-before-claim-steer'])(
  '%s does not create roleplay specs, consume queued events, or advance delayed lore timing',
  async (customType) => {
    const h = await harness({ note: true });
    await h.queueEvent();
    const notice = custom(customType, 'reef vault');
    await h.start(notice);
    const operational = await h.request([notice]);
    expect(
      h
        .records()
        .flatMap((record) => record.specs)
        .filter((spec) => spec.id.startsWith('roleplay-')),
    ).toEqual([]);
    expect(JSON.stringify(operational)).not.toMatch(/AUTHOR_NOTE|PRIMARY_REEF|KEYWORD_REEF|QUEUED_EVENT_MARKER/);

    const input = user('vault', 10);
    await h.start(input);
    const firstNarrative = await h.request([notice, input]);
    expect(text(snapshots(firstNarrative).at(-1)!)).toContain('QUEUED_EVENT_MARKER');
    expect(JSON.stringify(firstNarrative)).not.toContain('DELAYED_LORE_MARKER');

    const second = user('vault', 20);
    await h.start(second);
    const secondNarrative = await h.request([notice, input, second]);
    const freshBody = text(snapshots(secondNarrative).at(-1)!);
    expect(freshBody).toContain('DELAYED_LORE_MARKER');
    expect(freshBody).not.toContain('QUEUED_EVENT_MARKER');
    expect(snapshots(secondNarrative)[0]).toEqual(snapshots(firstNarrative)[0]);
  },
);

test('scheduled-prompt custom starts remain narrative eligible and anchor both lore blocks after the custom input', async () => {
  const h = await harness({ note: true });
  await h.queueEvent();
  const input = custom('scheduled-prompt', 'reef vault');
  await h.start(input);
  const first = await h.request([input]);
  expect(first[1]).toMatchObject(input);
  expect(snapshots(first)).toEqual([first[2]]);
  expect(text(first[2])).toContain('SECONDARY_REEF alpha');
  expect(text(first[2])).toContain('AUTHOR_NOTE alpha');
  expect(text(first[2])).toContain('KEYWORD_REEF alpha');
  expect(text(first[2])).toContain('QUEUED_EVENT_MARKER');
  expect(text(first[2])).not.toContain('DELAYED_LORE_MARKER');
  const next = custom('scheduled-prompt', 'vault', 10);
  await h.start(next);
  const second = await h.request([input, next]);
  expect(second.slice(0, first.length)).toEqual(first);
  expect(text(second.at(-1)!)).toContain('DELAYED_LORE_MARKER');
  expect(text(second.at(-1)!)).not.toContain('QUEUED_EVENT_MARKER');
});

test('depth injection can be disabled independently without suppressing keyword lore', async () => {
  vi.stubEnv('PI_ROLEPLAY_DISABLE_DEPTH_INJECT', '1');
  const h = await harness({ note: true });
  const input = user('reef');
  await h.start(input);
  const result = await h.request([input]);
  expect(text(snapshots(result)[0])).toContain('KEYWORD_REEF');
  expect(JSON.stringify(result)).not.toContain('AUTHOR_NOTE');
  expect(h.records()[0].specs.map((spec) => spec.id)).toEqual(['roleplay-lore']);
});

test('restoring a branch then requesting a non-user tool tail never captures a fresh snapshot', async () => {
  const h = await harness({ note: true });
  const input = user('reef');
  await h.start(input);
  const first = await h.request([input]);
  const count = h.snapshotEntryCount();
  await h.dispatch('session_tree', { type: 'session_tree' });
  vi.mocked(Math.random).mockReturnValue(0.99);
  h.lore('reef-primary', 'RESTORED_EDIT', { triggers: ['reef'], depth: 0 });
  const grown = await h.request([input, ...toolExchange('reef spire')]);
  expect(grown.slice(0, first.length)).toEqual(first);
  expect(snapshots(grown)).toEqual(snapshots(first));
  expect(h.snapshotEntryCount()).toBe(count);
  expect(JSON.stringify(grown)).not.toMatch(/RESTORED_EDIT|TOOL_ONLY_LORE/);
});

test('later request-local tool-call collapse does not invalidate a frozen placement target', async () => {
  const h = await harness({ inline: false, loreDepth: 3 });
  const previous = user('earlier', 1);
  const exchange = toolExchange('earlier result', 2);
  const input = user('reef', 4);
  const history = [previous, ...exchange, input];
  await h.start(input);
  const first = await h.request(history);
  const placed = snapshots(first).find((message) => text(message).includes('SECONDARY_REEF'));
  expect(placed).toBeDefined();
  h.mutateTargets();
  const continued = await h.request([...history, ...toolExchange('new result', 5)]);
  expect(snapshots(continued)).toEqual(snapshots(first));
  const noteIndex = continued.findIndex((message) => text(message).includes('SECONDARY_REEF'));
  const callIndex = continued.findIndex((message) => message.role === 'assistant' && message.timestamp === 2);
  expect(noteIndex).toBeLessThan(callIndex);
  expect(h.records()).toHaveLength(1);
});

test('metadata-only identity stamping does not collapse incremental SDK system messages', async () => {
  const h = await harness();
  clearActivePersona();
  const input = user('quiet', 3);
  await h.start(input);
  const output = await h.request([user('older', 1), { role: 'system', content: 'SYSTEM_UPDATE', timestamp: 2 }, input]);
  expect(output.filter((message) => message.role === 'system')).toHaveLength(2);
});

test('post-compaction capture-assist waits for a captured user turn rather than disappearing during a tool continuation', async () => {
  const h = await harness({ memory: true });
  const first = user('quiet first');
  await h.start(first);
  await h.request([first]);
  await h.dispatch('session_before_compact', { type: 'session_before_compact' });
  await h.compact();
  const tools = toolExchange();
  expect(JSON.stringify(await h.request([first, ...tools]))).not.toContain('memory-capture');
  const notice = custom('bg-bash-completion', 'job complete', 10);
  await h.start(notice);
  expect(JSON.stringify(await h.request([first, ...tools, notice]))).not.toContain('memory-capture');
  const next = user('quiet second', 20);
  await h.start(next);
  expect(JSON.stringify(await h.request([first, ...tools, notice, next]))).toContain('memory-capture');
  const count = h.records().filter((root) => root.specs.some((spec) => spec.id === 'memory-capture')).length;
  expect(count).toBe(1);
  const third = user('quiet third', 30);
  await h.start(third);
  await h.request([first, ...tools, notice, next, third]);
  expect(h.records().filter((root) => root.specs.some((spec) => spec.id === 'memory-capture'))).toHaveLength(1);
});

const SYNTHETIC_KEY = 'sk-proj-' + 'A'.repeat(32); // Detector fixture, never a credential.

test.each(['before', 'after'] as const)(
  'final projection redacts notes and lore with sanitizer registered %s the coordinator',
  async (redactor) => {
    const h = await harness({
      note: true,
      inline: false,
      authorDepth: 0,
      noteText: 'note ' + SYNTHETIC_KEY,
      redactor,
      confirmReveal: true,
    });
    h.lore('reef-primary', 'lore ' + SYNTHETIC_KEY, { triggers: ['reef'], depth: 0 });
    h.lore('reef-keyword', 'keyword ' + SYNTHETIC_KEY, { triggers: ['reef'] });
    const input = user('reef ' + SYNTHETIC_KEY);
    await h.start(input);
    const first = await h.request([input]);
    expect(JSON.stringify(first)).not.toContain(SYNTHETIC_KEY);
    expect(JSON.stringify(first)).toContain('REDACTED:openai-key');
    expect(JSON.stringify(first)).toContain("[Author's note: note");
    expect(JSON.stringify(h.records())).toContain(SYNTHETIC_KEY); // Sanitize copies, not frozen metadata.
    const continued = await h.request([input, ...toolExchange()]);
    expect(continued.slice(0, first.length)).toEqual(first);
    expect(h.aborts()).toBe(0);
    const handle = /#([a-z0-9_-]+)\]/i.exec(JSON.stringify(first))?.[1];
    expect(handle).toBeDefined();
    await h.command('unredact', '#' + (handle ?? ''));
    expect(JSON.stringify(await h.request([input, ...toolExchange()]))).toContain(SYNTHETIC_KEY);
  },
);

test('sanitizer fallback still protects custom inputs when snapshot delivery is disabled', async () => {
  const h = await harness({ redactor: 'before', disableCache: true });
  const input = custom('scheduled-prompt', 'private ' + SYNTHETIC_KEY);
  await h.start(input);
  const result = await h.request([input]);
  expect(JSON.stringify(result)).not.toContain(SYNTHETIC_KEY);
  expect(JSON.stringify(result)).toContain('REDACTED:openai-key');
  expect(h.records()).toEqual([]);
});

test('startup messages stay after the narrative input and its depth-zero snapshot', async () => {
  const h = await harness({ note: true, inline: false, authorDepth: 0 });
  const input = user('reef');
  const nextTurn = custom('startup-guidance', 'operational startup guide', 2);
  const handlerMessage = custom('handler-guidance', 'second startup guide', 3);
  await h.start(input);
  const result = await h.request([input, nextTurn, handlerMessage]);
  const contents = result.map(text);
  const inputIndex = contents.indexOf('reef');
  const guideIndex = contents.indexOf('operational startup guide');
  for (const marker of ['PRIMARY_REEF', 'AUTHOR_NOTE', 'KEYWORD_REEF']) {
    const index = contents.findIndex((body) => body.includes(marker));
    expect(index).toBeGreaterThan(inputIndex);
    expect(index).toBeLessThan(guideIndex);
  }
  expect(contents.indexOf('second startup guide')).toBeGreaterThan(guideIndex);
});

test('compaction preserves delivered frozen placements while their input and targets survive', async () => {
  const h = await harness({ note: true, inline: false, authorDepth: 0 });
  const input = user('reef');
  await h.start(input);
  const first = await h.request([input]);
  const count = h.snapshotEntryCount();
  await h.compact();
  vi.mocked(Math.random).mockReturnValue(0.99);
  h.lore('reef-primary', 'must not refresh', { triggers: ['reef'], depth: 0 });
  const continued = await h.request([input, ...toolExchange()]);
  expect(continued.slice(0, first.length)).toEqual(first);
  expect(h.snapshotEntryCount()).toBe(count);
});

test('identical event text queued during context preparation is delivered on the following narrative turn', async () => {
  const h = await harness();
  await h.queueEvent();
  const firstInput = user('quiet first');
  await h.start(firstInput);
  const first = await h.request([firstInput], () => h.queueEvent());
  expect(text(snapshots(first).at(-1)!)).toContain('QUEUED_EVENT_MARKER');
  const secondInput = user('quiet second', 10);
  await h.start(secondInput);
  const second = await h.request([firstInput, secondInput]);
  expect(h.records()).toHaveLength(2);
  expect(text(snapshots(second).at(-1)!)).toContain('QUEUED_EVENT_MARKER');
  const thirdInput = user('quiet third', 20);
  await h.start(thirdInput);
  await h.request([firstInput, secondInput, thirdInput]);
  expect(h.records()).toHaveLength(2);
});

test('final safety floor accounts historical snapshots and pending notes on every turn', async () => {
  const h = await harness({
    note: true,
    inline: false,
    authorDepth: 0,
    noteText: 'tone '.repeat(600),
    windowTokens: 4096,
  });
  const history: Message[] = [];
  for (let i = 0; i < 8; i++) {
    const input = user('quiet scene ' + i, i + 1);
    history.push(input);
    await h.start(input);
    const output = await h.request(history);
    expect(reminderRequestChars(output as unknown as ReminderMessage[]) / 4).toBeLessThanOrEqual(3072);
    expect(output.some((message) => message.role === 'user' && message.timestamp === input.timestamp)).toBe(true);
  }
  expect(h.aborts()).toBe(0);
  expect(h.records()).toHaveLength(8);
});

test.each(['sanitizer', 'oversize'] as const)(
  'failed %s safety pass aborts without exposing context, persisting, or consuming the event',
  async (kind) => {
    const h = await harness({
      note: true,
      inline: false,
      authorDepth: 0,
      failSanitizer: kind === 'sanitizer',
      windowTokens: kind === 'oversize' ? 4096 : undefined,
      noteText: kind === 'oversize' ? 'private '.repeat(10000) : 'private ' + SYNTHETIC_KEY,
    });
    await h.queueEvent();
    const input = user('private input ' + SYNTHETIC_KEY);
    await h.start(input);
    const output = await h.request([input]);
    expect(h.aborts()).toBe(1);
    expect(JSON.stringify(output)).not.toContain(SYNTHETIC_KEY);
    expect(JSON.stringify(output)).not.toContain('QUEUED_EVENT_MARKER');
    expect(h.records()).toEqual([]);
  },
);
