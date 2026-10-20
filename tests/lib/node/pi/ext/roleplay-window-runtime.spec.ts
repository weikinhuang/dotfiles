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

// The recap roll runs through `createSummarizer`; stub it so no child model is spawned
// and each test scripts the summarizer's answers (and their timing).
const stub = vi.hoisted(() => ({
  summarizeDetailed:
    vi.fn<
      (
        ctx: { signal?: AbortSignal },
        spanText: string,
        prior?: string,
      ) => Promise<{ recap: string | null; raw: string | null }>
    >(),
}));
vi.mock('../../../../../lib/node/pi/roleplay/summarize.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof summarizeModule>()),
  createSummarizer: () => ({
    isEnabled: () => true,
    summarizeDetailed: stub.summarizeDetailed,
    summarize: () => Promise.resolve(null),
  }),
}));

type Message = ContextEvent['messages'][number];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Stored = { type: 'custom'; customType: string; data: unknown } | { type: 'compaction' };

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
  for (const aspect of ['LOREBOOK', 'DEPTH_INJECT', 'EVENTS', 'AVATAR', 'SCENEGEN', 'REPETITION']) {
    vi.stubEnv(`PI_ROLEPLAY_DISABLE_${aspect}`, '1');
  }
  vi.stubEnv('PI_ROLEPLAY_CONTEXT_DEBUG', '1');
  stub.summarizeDetailed.mockReset();
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
  recaps: () => { coveredFrom: number; coveredTo: number; mode: string; applied: boolean; recap: string }[];
  debug: () => DebugEntry[];
  carryOver: string;
  castDir: string;
  tool: (params: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
}

async function harness(config: Record<string, unknown>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'roleplay-window-runtime-'));
  dirs.push(dir);
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
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
  const bus = new EventEmitter();
  const registerTool = vi.fn();
  const pi = {
    on: (name: string, handler: Handler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand: vi.fn(),
    registerTool,
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
    recaps: () => customs('roleplay-context-recap'),
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
  // next roll's recap is rejected so coverage stays where session_compact left it.
  stub.summarizeDetailed.mockResolvedValueOnce({ recap: null, raw: null });
  const compacted = history(10, 6);
  const out = await h.request(compacted);
  const last = h.debug().at(-1)!;
  expect(last).toMatchObject({ natural: 32, recapCutoff: 0, committedCutoff: 32, recapChars: 'KEPT RECAP'.length });
  expect(last.messagesOut).toBe(compacted.length); // nothing dropped against stale indices
  expect(text(out[0]).startsWith(`${RECAP_PREFIX}\nKEPT RECAP\n]`)).toBe(true);
  expect(h.recaps().at(-1)).toMatchObject({ coveredFrom: 0, applied: false });
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
