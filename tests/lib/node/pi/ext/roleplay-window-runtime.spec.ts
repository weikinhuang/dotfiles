/* eslint-disable no-await-in-loop -- Dispatch hooks in runtime order. */
import type { ContextEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import roleplay from '../../../../../config/pi/extensions/roleplay.ts';
import { clearActivePersona, setActivePersona } from '../../../../../lib/node/pi/persona/active.ts';
import { RECAP_PREFIX } from '../../../../../lib/node/pi/roleplay/context-window.ts';
import { emptyLoreMeta, serializeEntry } from '../../../../../lib/node/pi/roleplay/store.ts';
import type * as summarizeModule from '../../../../../lib/node/pi/roleplay/summarize.ts';
import type * as childSessionModule from '../../../../../lib/node/pi/ext/roleplay-child-session.ts';
import type * as spawnModule from '../../../../../lib/node/pi/subagent/spawn.ts';

// The recap roll runs through `createSummarizer`; stub it so no child model is spawned
// and each test scripts the summarizer's answers (and their timing).
const stub = vi.hoisted(() => ({
  enabled: true,
  summarizeDetailed:
    vi.fn<
      (
        ctx: { signal?: AbortSignal },
        spanText: string,
        prior?: string,
      ) => Promise<{ recap: string | null; raw: string | null }>
    >(),
}));
// Extractor children (fact / timeline): scripted per agent name, no model spawned.
const child = vi.hoisted(() => ({
  run: vi.fn<(agent: string, signal?: AbortSignal) => Promise<string | null>>(),
}));
vi.mock('../../../../../lib/node/pi/ext/roleplay-child-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof childSessionModule>()),
  loadRoleplayAgent: (opts: { name: string }) =>
    opts.name === 'roleplay-fact-extractor' || opts.name === 'roleplay-timeline-extractor' ? { name: opts.name } : null,
  runRoleplayChild: async (args: { agent: { name: string }; signal?: AbortSignal }) => ({
    stopReason: 'completed',
    finalText: await child.run(args.agent.name, args.signal),
  }),
}));
vi.mock('../../../../../lib/node/pi/subagent/spawn.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof spawnModule>()),
  resolveChildModel: () => ({ ok: true, model: { id: 'extractor', provider: 'fixture' } }),
}));
vi.mock('../../../../../lib/node/pi/roleplay/summarize.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof summarizeModule>()),
  createSummarizer: () => ({
    isEnabled: () => stub.enabled,
    summarizeDetailed: stub.summarizeDetailed,
    summarize: () => Promise.resolve(null),
  }),
}));

type Message = ContextEvent['messages'][number];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Stored =
  | { type: 'custom'; customType: string; data: unknown }
  | { type: 'compaction' }
  | { type: 'message'; id: string; message: Message };

const dirs: string[] = [];
const shutdowns: (() => Promise<void>)[] = [];

beforeEach(() => {
  for (const flag of [
    'PI_ROLEPLAY_DISABLED',
    'PI_ROLEPLAY_DISABLE_AUTOINJECT',
    'PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW',
    'PI_ROLEPLAY_DISABLE_SUMMARIZE',
    'PI_CACHE_REMINDERS_DISABLED',
    'PI_ROLEPLAY_ROOT',
  ])
    vi.stubEnv(flag, '');
  // This harness exercises only the context hook, without the final coordinator.
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '1');
  for (const aspect of ['LOREBOOK', 'DEPTH_INJECT', 'EVENTS', 'AVATAR', 'SCENEGEN', 'REPETITION']) {
    vi.stubEnv(`PI_ROLEPLAY_DISABLE_${aspect}`, '1');
  }
  vi.stubEnv('PI_ROLEPLAY_CONTEXT_DEBUG', '1');
  stub.summarizeDetailed.mockReset();
  stub.enabled = true;
  child.run.mockReset();
  child.run.mockResolvedValue(null);
});

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  clearActivePersona();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One turn = user, assistant tool call, tool result, assistant reply (4 messages). */
function turn(k: number): Message[] {
  const ts = k * 10;
  return [
    { role: 'user', content: [{ type: 'text', text: `turn ${k} prompt` }], timestamp: ts },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `call-${k}`, name: 'read', arguments: { path: 'scene.txt' } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'fixture',
      usage,
      stopReason: 'toolUse',
      timestamp: ts + 1,
    },
    {
      role: 'toolResult',
      toolCallId: `call-${k}`,
      toolName: 'read',
      content: [{ type: 'text', text: `turn ${k} tool output` }],
      isError: false,
      timestamp: ts + 2,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: `turn ${k} reply` }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'fixture',
      usage,
      stopReason: 'stop',
      timestamp: ts + 3,
    },
  ];
}

function history(turns: number, from = 0): Message[] {
  const out: Message[] = [];
  for (let k = from; k < from + turns; k++) out.push(...turn(k));
  return out;
}

function text(message: Message | undefined): string {
  if (!message || !('content' in message)) return '';
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => ('text' in part ? part.text : '')).join('\n');
}

interface DebugEntry {
  messagesIn: number;
  messagesOut: number;
  natural: number;
  committedCutoff: number;
  recapCutoff: number;
  recapChars: number;
}

interface Harness {
  request: (messages: Message[]) => Promise<Message[]>;
  dispatch: (name: string) => Promise<void>;
  compact: () => Promise<void>;
  /** Run `session_before_compact` with `reason` and return the first handler result. */
  beforeCompact: (reason: string) => Promise<unknown>;
  recaps: () => {
    coveredFrom: number;
    coveredTo: number;
    mode: string;
    applied: boolean;
    recap: string;
    trivial?: boolean;
  }[];
  /** Custom entries of `type` appended so far. */
  customs: (type: string) => Record<string, unknown>[];
  debug: () => DebugEntry[];
  carryOver: string;
  castDir: string;
  tool: (params: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
  /** Run `/roleplay <args>` and return the last notification text. */
  command: (args: string) => Promise<string>;
  seedTranscript: (messages: Message[]) => void;
  failEntry: (type: string | null) => void;
}

async function harness(config: Record<string, unknown>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'roleplay-window-runtime-'));
  dirs.push(dir);
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.stubEnv('PI_MEMORY_ROOT', join(dir, 'memory'));
  writeFileSync(
    join(agentDir, 'roleplay.json'),
    JSON.stringify({
      imageMode: 'off',
      keepTurns: 2,
      summarizeMinMessages: 1,
      capture: false,
      timeline: false,
      ...config,
    }),
  );
  setActivePersona({
    name: 'window-fixture',
    cast: 'window-fixture',
    roleplay: true,
    tools: ['roleplay', 'read'],
    resolvedWriteRoots: [],
  });
  const hooks = new Map<string, Handler[]>();
  const stored: Stored[] = [];
  let failingEntry: string | null = null;
  const bus = new EventEmitter();
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const pi = {
    on: (name: string, handler: Handler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand,
    registerTool,
    getActiveTools: () => ['read', 'roleplay'],
    getAllTools: () => [{ name: 'read' }, { name: 'roleplay' }],
    setActiveTools: vi.fn(),
    appendEntry: (customType: string, data: unknown) => {
      if (customType === failingEntry) throw new Error('synthetic append failure');
      stored.push({ type: 'custom', customType, data });
    },
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
  const ctx = {
    cwd: dir,
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: { getBranch: () => stored, getSessionId: () => 'window-fixture' },
    modelRegistry: {},
    signal: undefined,
  } as unknown as ExtensionContext;
  roleplay(pi);
  const dispatch = async (name: string): Promise<void> => {
    for (const handler of hooks.get(name) ?? []) await handler({ type: name }, ctx);
  };
  await dispatch('session_start');
  shutdowns.push(() => dispatch('session_shutdown'));
  const customs = <T>(type: string): T[] =>
    stored.flatMap((entry) => (entry.type === 'custom' && entry.customType === type ? [entry.data as T] : []));
  return {
    seedTranscript: (messages) => {
      stored.push(...messages.map((message, index) => ({ type: 'message' as const, id: `m${index}`, message })));
    },
    failEntry: (type) => {
      failingEntry = type;
    },
    request: async (messages) => {
      let current = structuredClone(messages);
      for (const handler of hooks.get('context') ?? []) {
        const result = (await handler({ type: 'context', messages: current }, ctx)) as
          | { messages?: Message[] }
          | undefined;
        if (result?.messages) current = result.messages;
      }
      return current;
    },
    dispatch,
    compact: async () => {
      stored.push({ type: 'compaction' });
      await dispatch('session_compact');
    },
    beforeCompact: async (reason) => {
      for (const handler of hooks.get('session_before_compact') ?? []) {
        const result = await handler({ type: 'session_before_compact', reason, preparation: {} }, ctx);
        if (result !== undefined) return result;
      }
      return undefined;
    },
    recaps: () => customs('roleplay-context-recap'),
    customs: (type) => customs<Record<string, unknown>>(type),
    debug: () => customs<DebugEntry>('roleplay-context-window-debug'),
    carryOver: join(agentDir, 'roleplay', 'casts', 'window-fixture', 'summary', 'auto.md'),
    castDir: join(agentDir, 'roleplay', 'casts', 'window-fixture'),
    tool: async (params) => {
      const def = registerTool.mock.calls
        .map((call) => call[0] as { name: string; execute: (...args: unknown[]) => Promise<unknown> })
        .find((d) => d.name === 'roleplay')!;
      const result = (await def.execute('call', params, undefined, undefined, ctx)) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { text: result.content[0].text, isError: result.isError };
    },
    command: async (args) => {
      const def = registerCommand.mock.calls.find((call) => call[0] === 'roleplay')![1] as {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      };
      await def.handler(args, ctx);
      const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
      return String(calls.at(-1)?.[0] ?? '');
    },
  };
}

/** Resolve-later promise for the async recap path. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('sync recap roll bounded mid tool-call drops a prefix that starts on a user message', async () => {
  // 6 turns x 4 messages, keepTurns 2 => natural 16. recapMaxAdvance 6 lands on a tool
  // result (index 6), so the roll must snap back to the user message at index 4.
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 6 });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'RECAP ONE', raw: 'RECAP ONE' });
  const messages = history(6);
  const out = await h.request(messages);

  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  const span = stub.summarizeDetailed.mock.calls[0][1];
  expect(span).toContain('turn 0 prompt');
  expect(span).not.toContain('turn 1');

  expect(h.recaps()).toEqual([
    expect.objectContaining({ coveredFrom: 0, coveredTo: 4, mode: 'sync', applied: true, recap: 'RECAP ONE' }),
  ]);
  expect(messages[4].role).toBe('user');
  expect(out).toHaveLength(messages.length - 4);
  expect(out[0].role).toBe('user');
  expect(text(out[0]).startsWith(`${RECAP_PREFIX}\nRECAP ONE\n]\n\n`)).toBe(true);
  expect(text(out[0])).toContain('turn 1 prompt');
  expect(h.debug().at(-1)).toMatchObject({ natural: 16, committedCutoff: 16, recapCutoff: 4 });
  expect(existsSync(h.carryOver)).toBe(true);

  // Same transcript again: the frozen boundary has not advanced by a stride, so no new roll.
  const again = await h.request(messages);
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  expect(again).toEqual(out);
});

test('session_compact resets index coverage but keeps the recap text', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 6 });
  stub.summarizeDetailed.mockResolvedValueOnce({ recap: 'KEPT RECAP', raw: 'KEPT RECAP' });
  await h.request(history(6));
  expect(h.debug().at(-1)).toMatchObject({ recapCutoff: 4, committedCutoff: 16 });

  await h.compact();
  // The post-compaction array is a NEW list whose natural cutoff (32) is past the old
  // committed boundary, so only session_compact can invalidate the stale indices. The
  // first pass afterwards anchors committedCutoff at natural WITHOUT rolling, so the
  // compaction summary + already-recapped kept messages are not re-summarized.
  const compacted: Message[] = [
    { role: 'compactionSummary', summary: 'PI COMPACTION SUMMARY', tokensBefore: 1, timestamp: 1 },
    ...history(10, 6),
  ];
  const out = await h.request(compacted);
  const last = h.debug().at(-1)!;
  expect(last).toMatchObject({ natural: 33, recapCutoff: 0, committedCutoff: 33, recapChars: 'KEPT RECAP'.length });
  expect(last.messagesOut).toBe(compacted.length); // nothing dropped against stale indices
  expect(text(out[1]).startsWith(`${RECAP_PREFIX}\nKEPT RECAP\n]`)).toBe(true);
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  expect(h.recaps()).toHaveLength(1);

  // A later stride roll summarizes the new aged span. pi's compaction summary is
  // in that span too: the roll drops it, so it must be folded, never discarded.
  stub.summarizeDetailed.mockResolvedValueOnce({ recap: 'KEPT RECAP PLUS', raw: 'KEPT RECAP PLUS' });
  await h.request([...compacted, ...history(1, 16)]);
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(2);
  const span = stub.summarizeDetailed.mock.calls[1][1];
  expect(span).toContain('PI COMPACTION SUMMARY');
  expect(span).toContain('turn 6 prompt');
});

test('a short first turn before a long tool turn never wedges coverage (minSpan + trivial backstop)', async () => {
  // u0 a0 | u1 + 15 tool call/result pairs | 10 short turns. keepTurns 4, recapMaxAdvance 24:
  // the legacy snap-down landed on index 2 (a 2-message span below summarizeMinMessages 4),
  // so planning returned null forever and recapCutoff stayed 0.
  const h = await harness({
    recapAsync: false,
    recapStride: 1,
    recapMaxAdvance: 24,
    keepTurns: 4,
    summarizeMinMessages: 4,
  });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'WEDGE RECAP', raw: 'WEDGE RECAP' });
  const msgs: Message[] = [
    { role: 'user', content: 'u0', timestamp: 0 },
    { role: 'assistant', content: [{ type: 'text', text: 'a0' }], timestamp: 1 } as Message,
    { role: 'user', content: 'u1 go', timestamp: 2 },
  ];
  for (let i = 0; i < 15; i++) {
    msgs.push(
      { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'read', arguments: {} }] } as Message,
      {
        role: 'toolResult',
        toolCallId: `c${i}`,
        toolName: 'read',
        content: [{ type: 'text', text: `r${i}` }],
      } as Message,
    );
  }
  for (let t = 0; t < 10; t++) {
    msgs.push({ role: 'user', content: `u${t + 2}`, timestamp: 100 + t }, {
      role: 'assistant',
      content: [{ type: 'text', text: `a${t + 2}` }],
      timestamp: 200 + t,
    } as Message);
  }
  await h.request(msgs);
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  expect(h.recaps().at(-1)).toMatchObject({ coveredFrom: 0, coveredTo: 33, applied: true });
  expect(h.debug().at(-1)).toMatchObject({ recapCutoff: 33 });
});

test('a small raw-message advance still reaches the non-empty text minimum', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 4, summarizeMinMessages: 4 });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'TOOL RECAP', raw: 'TOOL RECAP' });
  await h.request(history(6));
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  expect(stub.summarizeDetailed.mock.calls[0][1]).toContain('turn 0 prompt');
  expect(h.recaps().at(-1)).toMatchObject({ coveredFrom: 0, coveredTo: 8, applied: true });
});

test('a meaningful span below the planning minimum remains uncovered', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 6, summarizeMinMessages: 50 });
  const out = await h.request(history(6));
  expect(stub.summarizeDetailed).not.toHaveBeenCalled();
  expect(h.recaps()).toEqual([expect.objectContaining({ coveredFrom: 0, coveredTo: 8, applied: false })]);
  expect(h.recaps()[0].trivial).not.toBe(true);
  expect(h.debug().at(-1)).toMatchObject({ recapCutoff: 0 });
  expect(out.map(text).join('\n')).toContain('turn 0 prompt');
});

test('a genuinely empty text span can advance coverage without a recap', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 6, summarizeMinMessages: 50 });
  const blank: Message[] = [];
  for (let i = 0; i < 6; i++) {
    blank.push({ role: 'user', content: ' ', timestamp: i * 2 }, {
      role: 'assistant',
      content: [{ type: 'text', text: ' ' }],
      timestamp: i * 2 + 1,
    } as Message);
  }
  await h.request(blank);
  expect(stub.summarizeDetailed).not.toHaveBeenCalled();
  expect(h.customs('roleplay-context-recap')[0]).toMatchObject({ applied: false, trivial: true, emptySpan: true });
  expect(h.debug().at(-1)?.recapCutoff).toBeGreaterThan(0);
});

test('pinned opener stays before recap and is not copied into a tail reminder', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, pinSceneOpener: true });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'PINNED_RECAP', raw: 'PINNED_RECAP' });
  const original = history(4);
  const out = await h.request(original);
  expect(text(out[0])).toBe('turn 0 prompt');
  expect(out.filter((message) => text(message) === 'turn 0 prompt')).toHaveLength(1);
  expect(JSON.stringify(out).indexOf('PINNED_RECAP')).toBeGreaterThan(JSON.stringify(out).indexOf('turn 0 prompt'));
  expect(JSON.stringify(original)).not.toContain('PINNED_RECAP');
  expect(await h.command('opener')).toContain('pin on');
  await h.command('opener unpin');
  expect(await h.command('opener')).toContain('off');
});

test('immediate recap commits eligible history without another context pass', async () => {
  const h = await harness({ recapAsync: false, recapStride: 500 });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'IMMEDIATE_RECAP', raw: 'IMMEDIATE_RECAP' });
  await h.request(history(5));
  expect(stub.summarizeDetailed).not.toHaveBeenCalled();
  const debugCount = h.debug().length;
  await h.command('recap now');
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  expect(h.debug()).toHaveLength(debugCount);
  expect(await h.command('summary')).toContain('IMMEDIATE_RECAP');
});

test.each([false, true])('failed job scheduling cannot commit a normal recap (async=%s)', async (recapAsync) => {
  const h = await harness({ recapAsync, recapStride: 1, recapMaxAdvance: 4, timeline: true });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'DURABLE_RECAP', raw: 'DURABLE_RECAP' });
  h.failEntry('roleplay-extraction-job');
  const messages = history(4);
  const failure = await h.request(messages).then(
    () => null,
    (error: unknown) => error,
  );
  await flush();
  expect(failure instanceof Error ? failure.message : null).toBe(recapAsync ? null : 'synthetic append failure');
  expect(h.recaps()).toEqual([]);
  expect(existsSync(h.carryOver)).toBe(false);
  expect(child.run).not.toHaveBeenCalled();
  await h.dispatch('session_tree');
  stub.summarizeDetailed.mockResolvedValue({ recap: null, raw: null });
  expect((await h.request(messages)).map(text).join('\n')).toContain('turn 0 prompt');
  await flush();
  expect(h.recaps().some((recap) => recap.applied)).toBe(false);
  h.failEntry(null);
  await h.dispatch('session_tree');
  stub.summarizeDetailed.mockResolvedValue({ recap: 'DURABLE_RECAP', raw: 'DURABLE_RECAP' });
  await h.request(messages);
  await flush();
  expect(h.recaps().at(-1)).toMatchObject({ applied: true });
  expect(h.customs('roleplay-extraction-job').at(-1)).toMatchObject({ timeline: { status: 'failed' } });
  expect(h.customs('roleplay-context-recap').at(-1)?.extractionJobId).toBeTypeOf('string');
});

test('immediate recap schedules before accepting coverage and reuses an unaccepted job safely', async () => {
  const h = await harness({ recapAsync: false, recapStride: 500, timeline: true });
  h.seedTranscript(history(4));
  stub.summarizeDetailed.mockResolvedValue({ recap: 'COMMAND_RECAP', raw: 'COMMAND_RECAP' });
  h.failEntry('roleplay-extraction-job');
  await h.command('recap now');
  expect(h.recaps()).toEqual([]);
  await h.dispatch('session_start');
  expect(await h.command('summary')).not.toContain('COMMAND_RECAP');
  h.failEntry('roleplay-context-recap');
  await h.command('recap now');
  expect(h.customs('roleplay-extraction-job')).toHaveLength(1);
  expect(child.run).not.toHaveBeenCalled();
  await h.dispatch('session_tree');
  await h.command('jobs retry all');
  expect(child.run).not.toHaveBeenCalled();
  h.failEntry(null);
  await h.command('recap now');
  expect(h.recaps()).toHaveLength(1);
  const jobs = h.customs('roleplay-extraction-job');
  expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
  expect(child.run).toHaveBeenCalledTimes(1);
});

test.each([
  { timeline: true, beats: true },
  { timeline: true, beats: false },
  { timeline: false, beats: false },
])('immediate recap hydrates carry-over before the first context pass: %j', async ({ timeline, beats }) => {
  const h = await harness({ recapAsync: false, recapStride: 500, capture: true, timeline });
  for (const [kind, body] of [
    ['summary', 'INHERITED_SUMMARY'],
    ['timeline', '- [day 1] INHERITED_BEAT'],
    ['facts', ''],
  ]) {
    mkdirSync(join(h.castDir, kind), { recursive: true });
    writeFileSync(
      join(h.castDir, kind, 'auto.md'),
      serializeEntry({
        name: kind === 'facts' ? 'Inherited fact' : `Auto ${kind}`,
        description: 'INHERITED_FACT',
        kind: kind === 'timeline' ? 'timeline' : 'summary',
        body,
      }),
    );
  }
  const messages = history(4);
  h.seedTranscript(messages);
  await h.dispatch('session_start');
  stub.summarizeDetailed.mockImplementation((_ctx, _span, prior) =>
    Promise.resolve({ recap: `${prior ?? ''} NEW_RECAP`, raw: `${prior ?? ''} NEW_RECAP` }),
  );
  child.run.mockImplementation((agent) =>
    Promise.resolve(
      agent === 'roleplay-timeline-extractor' ? (beats ? '[{"when":"day 2","summary":"NEW_BEAT"}]' : '[]') : '[]',
    ),
  );
  await h.command('recap now');
  expect(h.debug()).toEqual([]);
  expect(await h.command('summary')).toContain('INHERITED_SUMMARY NEW_RECAP');
  expect(h.customs('roleplay-timeline')[0]).toMatchObject({
    version: 2,
    base: '- [day 1] INHERITED_BEAT',
    skip: 'seed',
  });
  expect(h.customs('roleplay-capture').filter((entry) => entry.seeded)).toHaveLength(1);
  await h.dispatch('session_start');
  await h.request(messages);
  expect(await h.command('timeline --all')).toContain('INHERITED_BEAT');
  expect((await h.command('timeline --all')).includes('NEW_BEAT')).toBe(beats);
  expect(h.customs('roleplay-capture').filter((entry) => entry.seeded)).toHaveLength(1);
  expect(await h.command('facts --content')).toContain('INHERITED_FACT');
  await h.command('newscene');
  await h.command('recap now');
  expect(await h.command('timeline --all')).not.toContain('INHERITED_BEAT');
  expect(await h.command('facts --content')).not.toContain('INHERITED_FACT');
});

test('legacy accepted jobs without an explicit audit link remain retryable', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 4, timeline: true });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'LEGACY_RECAP', raw: 'LEGACY_RECAP' });
  const messages = history(4);
  await h.request(messages);
  delete h.customs('roleplay-context-recap')[0].extractionJobId;
  const legacyId = h.customs('roleplay-extraction-job')[0].id;
  await h.dispatch('session_tree');
  await h.request(messages);
  child.run.mockResolvedValue('[{"summary":"RETRIED_LEGACY_BEAT"}]');
  await h.command('jobs retry timeline');
  expect(h.customs('roleplay-extraction-job').findLast((job) => job.id === legacyId)).toMatchObject({
    timeline: { status: 'complete' },
  });
  expect(h.customs('roleplay-timeline').some((entry) => String(entry.beats).includes('RETRIED_LEGACY_BEAT'))).toBe(
    true,
  );
});

test('immediate recap after a cast switch cannot seed the previous cast before context', async () => {
  const h = await harness({ capture: true, timeline: false });
  for (const kind of ['summary', 'timeline', 'facts']) {
    mkdirSync(join(h.castDir, kind), { recursive: true });
    writeFileSync(
      join(h.castDir, kind, 'auto.md'),
      serializeEntry({
        name: 'Old cast seed',
        description: 'OLD_CAST_FACT',
        kind: kind === 'timeline' ? 'timeline' : 'summary',
        body: 'OLD_CAST_MEMORY',
      }),
    );
  }
  h.seedTranscript(history(4));
  await h.dispatch('session_start');
  setActivePersona({ name: 'other', cast: 'other', roleplay: true, tools: ['roleplay'], resolvedWriteRoots: [] });
  await h.command('recap now');
  expect(await h.command('summary')).not.toContain('OLD_CAST_MEMORY');
  expect(await h.command('timeline --all')).not.toContain('OLD_CAST_MEMORY');
  expect(h.customs('roleplay-capture').filter((entry) => entry.seeded)).toEqual([]);
});

test('an interrupted timeline job survives tree restore and retries only unfinished work', async () => {
  const h = await harness({ keepTurns: 2, recapAsync: true, recapStride: 1, recapMaxAdvance: 4, timeline: true });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'JOB_RECAP', raw: 'JOB_RECAP' });
  const pending = deferred<string | null>();
  child.run.mockReturnValueOnce(pending.promise);
  await h.request(history(3));
  await flush();
  expect(h.recaps()).toHaveLength(1);
  expect(h.customs('roleplay-extraction-job').at(-1)).toMatchObject({ timeline: { status: 'running' } });
  await h.dispatch('session_tree');
  pending.resolve('[{"summary":"STALE_BEAT"}]');
  await flush();
  expect(h.customs('roleplay-timeline')).toEqual([]);
  await h.request(history(3));
  expect(await h.command('jobs')).toContain('interrupted');
  child.run.mockResolvedValue('[{"when":"day 1","summary":"RECOVERED_BEAT"}]');
  await h.command('jobs retry timeline');
  expect(h.customs('roleplay-timeline').at(-1)).toMatchObject({ beats: '- [day 1] RECOVERED_BEAT' });
  expect(h.customs('roleplay-extraction-job').at(-1)).toMatchObject({ timeline: { status: 'complete' } });
  const calls = child.run.mock.calls.length;
  await h.command('jobs retry timeline');
  expect(child.run).toHaveBeenCalledTimes(calls);
  expect(h.recaps()).toHaveLength(1);
});

test('sync recap that resolves after a reset is not committed', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 6 });
  const pending = deferred<{ recap: string | null; raw: string | null }>();
  stub.summarizeDetailed.mockReturnValueOnce(pending.promise);
  const inFlight = h.request(history(6));
  await flush();
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  await h.dispatch('session_tree');
  pending.resolve({ recap: 'STALE SYNC', raw: 'STALE SYNC' });
  const out = await inFlight;
  expect(h.recaps()).toEqual([]);
  expect(existsSync(h.carryOver)).toBe(false);
  expect(JSON.stringify(out)).not.toContain('STALE SYNC');
});

test('fact capture that resolves after a reset writes nothing', async () => {
  const h = await harness({ recapAsync: true, recapStride: 1, recapMaxAdvance: 6, capture: true });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'RECAP', raw: 'RECAP' });
  const facts = deferred<string | null>();
  child.run.mockImplementation((agent) =>
    agent === 'roleplay-fact-extractor' ? facts.promise : Promise.resolve(null),
  );
  await h.request(history(6));
  await flush();
  expect(child.run).toHaveBeenCalledWith('roleplay-fact-extractor', expect.anything());
  await h.dispatch('session_tree');
  facts.resolve('[{"name":"Stale fact","description":"must not be written"}]');
  await flush();
  expect(h.customs('roleplay-capture')).toEqual([]);
  expect(existsSync(join(h.castDir, 'facts'))).toBe(false);
});

test('a carry-over timeline seed survives a resume via the v2 base stamped at hydration', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 6, timeline: true });
  mkdirSync(join(h.castDir, 'timeline'), { recursive: true });
  writeFileSync(
    join(h.castDir, 'timeline', 'auto.md'),
    serializeEntry({ name: 'Auto timeline', description: 'd', kind: 'timeline', body: '- [day 1] seed beat\n' }),
  );
  stub.summarizeDetailed.mockResolvedValue({ recap: 'RECAP', raw: 'RECAP' });
  child.run.mockImplementation((agent) =>
    Promise.resolve(agent === 'roleplay-timeline-extractor' ? '[{"when":"day 2","summary":"new beat"}]' : null),
  );
  await h.request(history(6));
  const entries = h.customs('roleplay-timeline');
  // The seed is stamped as a base when it is adopted, before any roll; the roll carries only its delta.
  expect(entries).toEqual([
    expect.objectContaining({ version: 2, beats: '', skip: 'seed' }),
    expect.objectContaining({ version: 2, beats: '- [day 2] new beat' }),
  ]);
  expect(entries[0].base).toContain('seed beat');
  expect(entries[1].base).toBeUndefined();

  // Resume: the branch carries a recap, so hydration reads the branch timeline.
  await h.dispatch('session_start');
  const resumed = await h.request(history(6));
  const head = text(resumed[0]);
  expect(head).toContain('seed beat');
  expect(head).toContain('new beat');
});

test('session_tree clears the /roleplay context snapshot', async () => {
  const h = await harness({ recapAsync: false, recapStride: 1, recapMaxAdvance: 6 });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'RECAP', raw: 'RECAP' });
  await h.request(history(6));
  expect(await h.command('context')).toContain('snapshot of last turn');
  await h.dispatch('session_tree');
  expect(await h.command('context')).toContain('has not engaged yet');
});

test('async recap result lands on a later turn when still current', async () => {
  const h = await harness({ recapAsync: true, recapStride: 1, recapMaxAdvance: 6 });
  const pending = deferred<{ recap: string | null; raw: string | null }>();
  stub.summarizeDetailed.mockReturnValueOnce(pending.promise);
  const messages = history(6);
  const first = await h.request(messages);
  expect(JSON.stringify(first)).not.toContain('ASYNC RECAP');
  pending.resolve({ recap: 'ASYNC RECAP', raw: 'ASYNC RECAP' });
  await flush();
  expect(h.recaps()).toEqual([expect.objectContaining({ mode: 'async', coveredTo: 4, applied: true })]);
  const next = await h.request(messages);
  expect(text(next[0]).startsWith(`${RECAP_PREFIX}\nASYNC RECAP\n]`)).toBe(true);
});

test('async recap result that resolves after session_tree is discarded as stale', async () => {
  const h = await harness({ recapAsync: true, recapStride: 1, recapMaxAdvance: 6 });
  const pending = deferred<{ recap: string | null; raw: string | null }>();
  stub.summarizeDetailed.mockReturnValueOnce(pending.promise);
  const messages = history(6);
  await h.request(messages);
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  const signal = stub.summarizeDetailed.mock.calls[0][0].signal;
  expect(signal?.aborted).toBe(false);

  await h.dispatch('session_tree');
  expect(signal?.aborted).toBe(true);
  pending.resolve({ recap: 'STALE RECAP', raw: 'STALE RECAP' });
  await flush();

  expect(h.recaps()).toEqual([]);
  expect(existsSync(h.carryOver)).toBe(false);
  stub.summarizeDetailed.mockResolvedValue({ recap: null, raw: null });
  const next = await h.request(messages);
  await flush();
  expect(JSON.stringify(next)).not.toContain('STALE RECAP');
  expect(h.debug().at(-1)).toMatchObject({ recapCutoff: 0, recapChars: 0 });
});

test('roleplay tool applies planned writes before removes and refreshes the index', async () => {
  const h = await harness({});
  const saved = await h.tool({ action: 'save', name: 'Mira', description: 'lead', body: 'MIRA BODY' });
  expect(saved.text).toContain('Saved [window-fixture/character] mira - Mira');
  expect(existsSync(join(h.castDir, 'character', 'mira.md'))).toBe(true);
  const reserved = await h.tool({ action: 'save', kind: 'summary', name: 'auto', description: 'd', body: 'b' });
  expect(reserved).toMatchObject({ isError: true });
  expect(reserved.text).toContain('reserved');

  const renamed = await h.tool({ action: 'update', id: 'mira', name: 'Mira Vale' });
  expect(renamed.text).toContain('Updated [window-fixture/character] mira-vale - Mira Vale');
  expect(existsSync(join(h.castDir, 'character', 'mira.md'))).toBe(false);
  expect(readFileSync(join(h.castDir, 'character', 'mira-vale.md'), 'utf8')).toContain('MIRA BODY');
  expect(readFileSync(join(h.castDir, 'INDEX.md'), 'utf8')).toContain('mira-vale');

  // Same id under another kind (only reachable via disk), picked up by a rescan.
  mkdirSync(join(h.castDir, 'lore'), { recursive: true });
  writeFileSync(
    join(h.castDir, 'lore', 'mira-vale.md'),
    serializeEntry({ name: 'Mira Vale', description: 'place', kind: 'lore', body: 'PLACE', lore: emptyLoreMeta() }),
  );
  await h.dispatch('session_tree');
  const ambiguous = await h.tool({ action: 'remove', id: 'mira-vale' });
  expect(ambiguous.isError).toBe(true);
  const removed = await h.tool({ action: 'remove', id: 'mira-vale', kind: 'lore' });
  expect(removed.text).toContain('Removed [window-fixture/lore] mira-vale');
  expect(existsSync(join(h.castDir, 'lore', 'mira-vale.md'))).toBe(false);
  expect(existsSync(join(h.castDir, 'character', 'mira-vale.md'))).toBe(true);
  expect((await h.tool({ action: 'search', query: 'mira body' })).text).toContain('[character] mira-vale');
});

test('/roleplay recap force rolls the next pass off-stride, then clears', async () => {
  const h = await harness({ recapAsync: false, recapStride: 100, recapMaxAdvance: 6 });
  stub.summarizeDetailed.mockResolvedValue({ recap: 'FORCED RECAP', raw: 'FORCED RECAP' });
  const messages = history(6);
  await h.request(messages);
  expect(stub.summarizeDetailed).not.toHaveBeenCalled();

  expect(await h.command('recap force')).toContain('Forced recap armed');
  expect(await h.command('recap')).toContain('forced roll armed');
  const out = await h.request(messages);
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  expect(text(out[0]).startsWith(`${RECAP_PREFIX}\nFORCED RECAP\n]`)).toBe(true);
  expect(h.recaps()).toEqual([expect.objectContaining({ coveredFrom: 0, coveredTo: 4, applied: true })]);

  // One-shot: the next pass is back on the stride gate.
  await h.request(messages);
  expect(stub.summarizeDetailed).toHaveBeenCalledTimes(1);
  const shown = await h.command('recap show');
  expect(shown).toContain('coverage : recap=4  committed=16  natural(last pass)=16');
  expect(shown).toContain('status   : idle');
  expect(shown).toContain('FORCED RECAP');
});

test('/roleplay recap force is refused when recap mode is off', async () => {
  vi.stubEnv('PI_ROLEPLAY_DISABLE_SUMMARIZE', '1');
  const h = await harness({});
  expect(await h.command('recap force')).toContain('Cannot force a recap: recap mode is off (summarize is disabled');
});

test('/roleplay export writes a V2 card once and /roleplay rel lists relationships', async () => {
  const h = await harness({});
  await h.tool({ action: 'save', name: 'Mira', description: 'lead', body: 'MIRA BODY' });
  expect(await h.command('rel')).toContain('no relationship records');

  const msg = await h.command('export');
  expect(msg).toContain('Exported "Mira"');
  const out = join(h.castDir, '..', '..', '..', '..', 'mira.card.json');
  const card = JSON.parse(readFileSync(out, 'utf8')) as { spec: string; data: { name: string; description: string } };
  expect(card).toMatchObject({ spec: 'chara_card_v2', data: { name: 'Mira', description: 'MIRA BODY' } });
  expect(await h.command('export mira')).toContain('already exists; pick another path');
  expect(await h.command('export nobody')).toContain('no character "nobody"');
  expect(await h.command('export mira sub/m.json')).toContain('sub/m.json');
});

test('/roleplay export resolves a multi-word name and reports dropped data as warnings', async () => {
  const h = await harness({});
  await h.tool({ action: 'save', name: 'Mira Vale', description: 'lead', body: 'MIRA BODY', aliases: ['MV'] });
  const msg = await h.command('export Mira Vale out/mv.json');
  expect(msg).toContain('Exported "Mira Vale"');
  expect(msg).toContain('out/mv.json');
  expect(msg).toContain('Warnings:');
  expect(msg).toContain('character "Mira Vale": card has no field for');
});

test('recap mode cancels threshold compaction only when a summarizer resolves', async () => {
  const h = await harness({});
  expect(await h.beforeCompact('threshold')).toStrictEqual({ cancel: true });
  // Manual compaction is never cancelled.
  expect(await h.beforeCompact('manual')).toBeUndefined();
});

test('recap mode lets pi run threshold compaction when no summarizer resolves', async () => {
  stub.enabled = false;
  const h = await harness({});
  expect(await h.beforeCompact('threshold')).toBeUndefined();
  expect(stub.summarizeDetailed).not.toHaveBeenCalled();
});
