/* eslint-disable no-await-in-loop -- Dispatch hooks and requests in runtime order. */
/**
 * Review reproductions for the roleplay history-preservation invariants.
 *
 * Each test asserts the CORRECT behavior; a failure reproduces a finding.
 * Harness: real roleplay + cache-reminders extensions through the SDK's
 * two-phase `ExtensionRunner.emitContext`, a scripted summarizer, scripted
 * fact/timeline extractors, and a synthetic persisted-message projection so
 * message identities are entry ids as in production. Synthetic data only.
 */
import {
  ExtensionRunner,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type NormalizedBuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import cacheReminders from '../../../../../config/pi/extensions/cache-reminders.ts';
import roleplay from '../../../../../config/pi/extensions/roleplay.ts';
import secretRedactor from '../../../../../config/pi/extensions/secret-redactor.ts';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { clearActivePersona, setActivePersona } from '../../../../../lib/node/pi/persona/active.ts';
import {
  PI_CONTEXT_SAFETY_TOKENS,
  piFallbackTokens,
  reminderRequestChars,
} from '../../../../../lib/node/pi/reminder-budget.ts';
import { RECAP_PREFIX, TIMELINE_PREFIX } from '../../../../../lib/node/pi/roleplay/context-window.ts';
import { serializeEntry } from '../../../../../lib/node/pi/roleplay/store.ts';
import type * as childModule from '../../../../../lib/node/pi/ext/roleplay-child-session.ts';
import type * as spawnModule from '../../../../../lib/node/pi/subagent/spawn.ts';
import type * as summarizeModule from '../../../../../lib/node/pi/roleplay/summarize.ts';

const summary = vi.hoisted(() => ({
  detailed:
    vi.fn<
      (
        ctx: { signal?: AbortSignal },
        span: string,
        prior?: string,
      ) => Promise<{ recap: string | null; raw: string | null }>
    >(),
  compact: vi.fn<(ctx: unknown, span: string, prior?: string) => Promise<string | null>>(),
}));
const child = vi.hoisted(() => ({
  run: vi.fn<(agent: string, signal?: AbortSignal) => Promise<string | null>>(),
}));
vi.mock('../../../../../lib/node/pi/roleplay/summarize.ts', async (original) => ({
  ...(await original<typeof summarizeModule>()),
  createSummarizer: () => ({
    isEnabled: () => true,
    summarizeDetailed: summary.detailed,
    summarize: summary.compact,
  }),
}));
vi.mock('../../../../../lib/node/pi/ext/roleplay-child-session.ts', async (original) => ({
  ...(await original<typeof childModule>()),
  loadRoleplayAgent: (opts: { name: string }) =>
    opts.name === 'roleplay-fact-extractor' || opts.name === 'roleplay-timeline-extractor' ? { name: opts.name } : null,
  runRoleplayChild: async (args: { agent: { name: string }; signal?: AbortSignal }) => ({
    stopReason: 'completed',
    finalText: await child.run(args.agent.name, args.signal),
  }),
}));
vi.mock('../../../../../lib/node/pi/subagent/spawn.ts', async (original) => ({
  ...(await original<typeof spawnModule>()),
  resolveChildModel: () => ({ ok: true, model: { id: 'extractor', provider: 'fixture' } }),
}));

type Message = ContextEvent['messages'][number];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Entry = Record<string, unknown>;

const roots: string[] = [];
const shutdowns: (() => Promise<unknown>)[] = [];
/** Every span the summarizer was asked to fold (sync, async, budget). */
let spans: string[] = [];

beforeEach(() => {
  for (const flag of [
    'PI_ROLEPLAY_DISABLED',
    'PI_ROLEPLAY_DISABLE_AUTOINJECT',
    'PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW',
    'PI_ROLEPLAY_DISABLE_SUMMARIZE',
    'PI_CACHE_REMINDERS_DISABLED',
    'PI_ROLEPLAY_ROOT',
    'PI_ROLEPLAY_CAPTURE',
    'PI_ROLEPLAY_TIMELINE',
    'PI_ROLEPLAY_RECAP_ASYNC',
    'PI_ROLEPLAY_CONTEXT_DEBUG',
    'PI_SECRET_REDACTOR_DISABLED',
  ])
    vi.stubEnv(flag, '');
  for (const aspect of ['LOREBOOK', 'DEPTH_INJECT', 'EVENTS', 'AVATAR', 'SCENEGEN', 'REPETITION'])
    vi.stubEnv(`PI_ROLEPLAY_DISABLE_${aspect}`, '1');
  spans = [];
  let n = 0;
  summary.detailed.mockReset();
  summary.detailed.mockImplementation(async (_ctx, span, prior = '') => {
    spans.push(span);
    n += 1;
    const recap = `${prior.trim()} RECAP_${n}`.trim();
    return { recap, raw: recap };
  });
  summary.compact.mockReset();
  summary.compact.mockResolvedValue(null);
  child.run.mockReset();
  child.run.mockResolvedValue(null);
});

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  clearActivePersona();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(body: string, timestamp: number): Message {
  return { role: 'user', content: [{ type: 'text', text: body }], timestamp };
}

function assistant(body: string, timestamp: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: body }],
    api: 'anthropic-messages',
    provider: 'fixture',
    model: 'fixture',
    usage,
    stopReason: 'stop',
    timestamp,
  };
}

function toolPair(id: string, body: string, timestamp: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'read', arguments: { path: 'scene.txt' } }],
      api: 'anthropic-messages',
      provider: 'fixture',
      model: 'fixture',
      usage,
      stopReason: 'toolUse',
      timestamp,
    },
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'read',
      content: [{ type: 'text', text: body }],
      isError: false,
      timestamp: timestamp + 1,
    },
  ];
}

/** Turn `i`: marker tokens `T<i>U` / `T<i>A` identify the messages; `pad` adds prose. */
function turn(i: number, pad = 0): Message[] {
  const prose =
    pad > 0 ? ' ' + 'Mira walks the pier and studies the tide. '.repeat(Math.ceil(pad / 42)).slice(0, pad) : '';
  return [user(`T${i}U${prose}`, 1000 + i * 10), assistant(`T${i}A${prose}`, 1000 + i * 10 + 1)];
}

function turns(count: number, pad = 0, from = 0): Message[] {
  const out: Message[] = [];
  for (let i = from; i < from + count; i++) out.push(...turn(i, pad));
  return out;
}

function text(message: Message): string {
  if (!('content' in message) || message.content === undefined) {
    const summaryText = (message as { summary?: unknown }).summary;
    return typeof summaryText === 'string' ? summaryText : '';
  }
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((p) => ('text' in p ? p.text : '')).join('\n');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface HarnessOptions {
  config?: Record<string, unknown>;
  /** Session model context window; `null` omits the field. */
  windowTokens?: number | null;
  /** What `modelRegistry.find` returns for the summarizer model spec. */
  recapModel?: { id: string; provider: string; contextWindow?: number };
  systemText?: string;
  structuredHead?: boolean;
  entries?: Entry[];
  carryTimeline?: string;
  redactor?: boolean;
}

interface Harness {
  start: (prompt: string) => Promise<void>;
  startCustom: (message: Message) => Promise<void>;
  request: (messages: Message[]) => Promise<Message[]>;
  messageEnd: (inputTokens: number) => Promise<void>;
  dispatch: (name: string, event?: unknown) => Promise<unknown>;
  stored: Entry[];
  /** Entries on other branches of the same session file (getEntries only). */
  offBranch: Entry[];
  abort: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  system: () => string;
  agent: string;
  windowTokens: number | undefined;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'roleplay-review-'));
  roots.push(root);
  const agent = join(root, 'agent');
  mkdirSync(agent);
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('PI_MEMORY_ROOT', join(root, 'memory'));
  writeFileSync(
    join(agent, 'roleplay.json'),
    JSON.stringify({
      imageMode: 'off',
      keepTurns: 2,
      recapStride: 1,
      summarizeMinMessages: 1,
      recapAsync: false,
      capture: false,
      timeline: false,
      ...options.config,
    }),
  );
  writeFileSync(join(agent, 'roleplay-summarize.json'), JSON.stringify({ summarizeModel: 'fixture/recap' }));
  if (options.carryTimeline) {
    const dir = join(agent, 'roleplay', 'casts', 'review-cast', 'timeline');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'auto.md'),
      serializeEntry({ name: 'Timeline', description: 'carry', kind: 'timeline', body: options.carryTimeline }),
    );
  }
  setActivePersona({
    name: 'review-cast',
    cast: 'review-cast',
    roleplay: true,
    tools: ['read', 'roleplay'],
    resolvedWriteRoots: [],
  });
  const basePrompt = options.systemText ?? 'STATIC_BASE';
  let systemPrompt = basePrompt;
  const hooks = new Map<string, Handler[]>();
  const stored: Entry[] = structuredClone(options.entries ?? []);
  const offBranch: Entry[] = [];
  const bus = new EventEmitter();
  const abort = vi.fn();
  const notify = vi.fn();
  /** Persisted-message projection mirroring the last request (entry ids keyed by role + timestamp). */
  let projection: Message[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    getActiveTools: () => ['read', 'roleplay'],
    getAllTools: () => [{ name: 'read' }, { name: 'roleplay' }],
    setActiveTools: vi.fn(),
    appendEntry: (customType: string, data: unknown) =>
      stored.push({ type: 'custom', id: `c${stored.length}`, customType, data: structuredClone(data) }),
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
  const windowTokens = options.windowTokens === null ? undefined : (options.windowTokens ?? 128000);
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: {
      getBranch: () => stored,
      getEntries: () => [...offBranch, ...stored],
      getSessionId: () => 'review-session',
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00Z' }),
      buildSessionProjection: () => ({
        entries: projection.map((message) => ({
          sourceEntry: { id: `m-${message.role}-${message.timestamp}` },
          messages: [message],
        })),
      }),
    },
    model: {
      id: 'fixture',
      provider: 'fixture',
      ...(windowTokens === undefined ? {} : { contextWindow: windowTokens }),
    },
    getSystemPrompt: () => systemPrompt,
    modelRegistry: { find: () => options.recapModel },
    abort,
  } as unknown as ExtensionContext;
  if (options.redactor) secretRedactor(pi);
  roleplay(pi);
  cacheReminders(pi);
  const errors: unknown[] = [];
  const runner = {
    extensions: [{ path: 'review-fixture', handlers: hooks }],
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
      )) as { systemPrompt?: string } | undefined;
      if (out?.systemPrompt) systemPrompt = out.systemPrompt;
    }
  };
  const startCustom = async (message: Message): Promise<void> => {
    systemPrompt = basePrompt;
    for (const fn of hooks.get('before_agent_start') ?? []) {
      const out = (await fn(
        {
          type: 'before_agent_start',
          messageType: 'custom',
          message,
          systemPrompt,
          systemPromptOptions: promptOptions,
        },
        ctx,
      )) as { systemPrompt?: string } | undefined;
      if (out?.systemPrompt) systemPrompt = out.systemPrompt;
    }
  };
  const request = async (messages: Message[]): Promise<Message[]> => {
    projection = structuredClone(messages);
    const head: Message = options.structuredHead
      ? ({ role: 'system', content: '', sections: { base: systemPrompt }, timestamp: 0 } as unknown as Message)
      : ({ role: 'system', content: systemPrompt, timestamp: 0 } as unknown as Message);
    const out = await ExtensionRunner.prototype.emitContext.call(runner, [head, ...structuredClone(messages)]);
    expect(errors).toEqual([]);
    return out;
  };
  const messageEnd = async (inputTokens: number): Promise<void> => {
    await dispatch('message_end', {
      type: 'message_end',
      message: { ...assistant('reply', 0), usage: { ...usage, input: inputTokens } },
    });
  };
  await dispatch('session_start');
  shutdowns.push(() => dispatch('session_shutdown'));
  return {
    start,
    startCustom,
    request,
    messageEnd,
    dispatch,
    stored,
    offBranch,
    abort,
    notify,
    system: () => systemPrompt,
    agent,
    windowTokens,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Markers of transcript messages missing from the projected request. */
function missingMarkers(history: Message[], out: Message[]): string[] {
  const body = out.map(text).join('\n');
  const missing: string[] = [];
  for (const message of history) {
    const marker = /^T\d+[UA]|^R\d+/.exec(text(message))?.[0];
    if (marker && !new RegExp(`(^|\\s)${marker}(\\s|$)`).test(body)) missing.push(marker);
  }
  return missing;
}

/** A dropped marker is acceptable only when some summarizer span carried it. */
function uncoveredDrops(history: Message[], out: Message[]): string[] {
  const folded = spans.join('\n');
  return missingMarkers(history, out).filter((marker) => !new RegExp(`(^|\\s)${marker}(\\s|$)`).test(folded));
}

// ──────────────────────────────────────────────────────────────────────
// P1: recap coverage drops history but scene memory is never injected
// ──────────────────────────────────────────────────────────────────────

test.each([
  ['zero', 0],
  ['missing', null],
] as const)(
  'review: a %s model contextWindow never drops covered history without injecting the recap',
  async (_label, windowTokens) => {
    // Virtual models default contextWindow to 0. The context hook defers recap
    // injection to the cache-reminders limiter (deferMemory), but the limiter
    // listener returns before finalizeBudget when the window is not positive.
    const h = await harness({ windowTokens });
    const history = turns(6);
    await h.start('T5U');
    const out = await h.request(history);
    expect(summary.detailed).toHaveBeenCalled();
    // Coverage advanced and the covered prefix was dropped...
    expect(missingMarkers(history, out).length).toBeGreaterThan(0);
    // ...so the recap that replaces it must reach the request.
    expect(out.map(text).join('\n')).toContain(RECAP_PREFIX);
    expect(out.map(text).join('\n')).toContain('RECAP_1');
  },
);

// ──────────────────────────────────────────────────────────────────────
// P1: non-content message kinds are dropped without reaching a summarizer
// ──────────────────────────────────────────────────────────────────────

test('review: a normal roll never drops a pi compaction summary that no recap folded', async () => {
  const h = await harness({ config: { keepTurns: 2 } });
  await h.start('T0U');
  await h.request(turns(4));
  // Manual compaction whose roleplay side-write fails (summarizer returned null):
  // pi still compacts, so its summary message is the only record of the evicted span.
  summary.compact.mockResolvedValueOnce(null);
  await h.dispatch('session_before_compact', {
    type: 'session_before_compact',
    reason: 'manual',
    preparation: { messagesToSummarize: turns(4) },
  });
  h.stored.push({ type: 'compaction', id: 'compaction-1' });
  await h.dispatch('session_compact');
  const compacted: Message[] = [
    {
      role: 'compactionSummary',
      summary: 'PI_COMPACTION_ONLY_RECORD of turns 0-3',
      tokensBefore: 1,
      timestamp: 5,
    },
    ...turns(4, 0, 4),
  ];
  await h.start('T7U');
  await h.request(compacted);
  // Two more turns age the kept messages past the stride: a normal roll fires.
  const later = [...compacted, ...turns(2, 0, 8)];
  await h.start('T9U');
  const out = await h.request(later);
  const body = out.map(text).join('\n');
  const folded = spans.join('\n');
  expect(body.includes('PI_COMPACTION_ONLY_RECORD') || folded.includes('PI_COMPACTION_ONLY_RECORD')).toBe(true);
});

test('review: a normal roll never drops a branch summary without folding it', async () => {
  const h = await harness({ config: { keepTurns: 2 } });
  const history: Message[] = [
    ...turns(1),
    { role: 'branchSummary', summary: 'BRANCH_SUMMARY_ONLY_RECORD', fromId: 'x', timestamp: 1015 },
    ...turns(4, 0, 2),
  ];
  await h.start('T5U');
  const out = await h.request(history);
  expect(summary.detailed).toHaveBeenCalled();
  const body = out.map(text).join('\n');
  expect(body.includes('BRANCH_SUMMARY_ONLY_RECORD') || spans.join('\n').includes('BRANCH_SUMMARY_ONLY_RECORD')).toBe(
    true,
  );
});

// ──────────────────────────────────────────────────────────────────────
// P1: span text truncation while coverage advances over the whole span
// ──────────────────────────────────────────────────────────────────────

test('review: coverage never claims messages that renderSpan omitted from the summarizer input', async () => {
  // A distinct, smaller recap model: maxSpanChars = (3000 - 1024) * 4 = 7904.
  const h = await harness({
    config: { keepTurns: 2, recapMaxAdvance: 24, recapAsync: false },
    recapModel: { id: 'recap', provider: 'recap-endpoint', contextWindow: 3000 },
  });
  const history = turns(12, 900);
  await h.start('T11U');
  const out = await h.request(history);
  expect(spans).toHaveLength(1);
  // The span is bounded to what the summarizer reads: nothing is front-truncated.
  expect(spans[0]).not.toContain('[...earlier turns omitted...]');
  expect(uncoveredDrops(history, out)).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// P2: reload rebuilds a timeline the live session never had
// ──────────────────────────────────────────────────────────────────────

test('review: resuming a branch with a recap but no timeline beats does not adopt a foreign carry-over timeline', async () => {
  child.run.mockImplementation(async (agent) => (agent === 'roleplay-timeline-extractor' ? '[]' : null));
  const live = await harness({ config: { keepTurns: 2, timeline: true } });
  const history = turns(6);
  await live.start('T5U');
  const liveOut = await live.request(history);
  expect(liveOut.map(text).join('\n')).not.toContain(TIMELINE_PREFIX);
  // Another same-cast session writes the shared carry-over after this one started.
  const reloaded = await harness({
    config: { keepTurns: 2, timeline: true },
    entries: live.stored,
    carryTimeline: '- [Day 9] FOREIGN_SESSION_BEAT',
  });
  await reloaded.start('T5U');
  const out = await reloaded.request(history);
  expect(out.map(text).join('\n')).not.toContain('FOREIGN_SESSION_BEAT');
});

// ──────────────────────────────────────────────────────────────────────
// Synthetic long run: keepTurns 50, recapChunk 8, async, capture + timeline,
// 53248-token window, large structured system head, tool continuations, reload.
// ──────────────────────────────────────────────────────────────────────

test.each([50, 4])(
  'review: 22-turn structured-head run (keepTurns %i) never drops uncovered history and injects memory once',
  async (keepTurns) => {
    let beat = 0;
    // Async normal rolls land a macrotask later, so some land between a user
    // request and its tool continuation.
    summary.detailed.mockImplementation(async (_ctx, span, prior = '') => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      spans.push(span);
      const recap = `${prior.trim()} RECAP_${spans.length}`.trim();
      return { recap, raw: recap };
    });
    child.run.mockImplementation(async (agent) => {
      if (agent === 'roleplay-fact-extractor')
        return JSON.stringify([{ name: `Mira fact ${beat}`, description: `fact ${beat}` }]);
      beat += 1;
      return JSON.stringify([{ when: `Day ${beat}`, summary: `Beat number ${beat} happens on the pier` }]);
    });
    const config = {
      keepTurns,
      recapChunk: 8,
      recapStride: 0,
      recapAsync: true,
      capture: true,
      timeline: true,
      summarizeMinMessages: 4,
    };
    const options: HarnessOptions = {
      config,
      windowTokens: 53248,
      systemText: 'You are the narrator. '.repeat(6400),
      structuredHead: true,
    };
    let h = await harness(options);
    const history: Message[] = [];
    const failures: string[] = [];
    let aborts = 0;
    let maxDropped = 0;
    const check = (label: string, out: Message[]): void => {
      if (h.abort.mock.calls.length > aborts) {
        aborts = h.abort.mock.calls.length;
        failures.push(`${label}: aborted (${String(h.notify.mock.calls.at(-1)?.[0])})`);
        return;
      }
      const body = out.map(text).join('\n');
      maxDropped = Math.max(maxDropped, missingMarkers(history, out).length);
      const uncovered = uncoveredDrops(history, out);
      if (uncovered.length > 0) failures.push(`${label}: uncovered drops ${uncovered.join(',')}`);
      if (count(body, RECAP_PREFIX) > 1) failures.push(`${label}: recap injected ${count(body, RECAP_PREFIX)}x`);
      if (count(body, TIMELINE_PREFIX) > 1)
        failures.push(`${label}: timeline injected ${count(body, TIMELINE_PREFIX)}x`);
      if (missingMarkers(history, out).length > 0 && count(body, RECAP_PREFIX) !== 1)
        failures.push(`${label}: history dropped without a recap`);
      const tokens = reminderRequestChars(out as unknown as ReminderMessage[], h.system()) / 4;
      if (tokens > 53248 - 1024) failures.push(`${label}: projected ${Math.round(tokens)} tokens`);
      // pi-ai clamps max_tokens to window - its 3.5 chars/token estimate - 4096; the reply needs real room.
      const piRoom =
        53248 - piFallbackTokens(out as unknown as ReminderMessage[], h.system()) - PI_CONTEXT_SAFETY_TOKENS;
      if (piRoom < 1024) failures.push(`${label}: pi max_tokens clamp leaves ${piRoom}`);
      const last = history.at(-1)!;
      if (!out.some((m) => m.timestamp === last.timestamp && m.role === last.role))
        failures.push(`${label}: latest message missing`);
    };
    for (let i = 0; i < 22; i++) {
      if (i === 16) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await flush();
        h = await harness({ ...options, entries: h.stored });
        aborts = 0;
      }
      const [u, a] = turn(i, 2600);
      history.push(u);
      await h.start(text(u));
      let out = await h.request(history);
      check(`turn ${i}`, out);
      await h.messageEnd(Math.round(reminderRequestChars(out as unknown as ReminderMessage[], h.system()) / 4));
      if (i % 3 === 1) {
        history.push(...toolPair(`call-${i}`, `R${i} tool output about the tide`, 1000 + i * 10 + 5));
        await new Promise((resolve) => setTimeout(resolve, 0));
        out = await h.request(history);
        check(`turn ${i} tool`, out);
        await h.messageEnd(Math.round(reminderRequestChars(out as unknown as ReminderMessage[], h.system()) / 4));
      }
      history.push({ ...a, timestamp: 1000 + i * 10 + 8 });
      if (i % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
    }
    expect(failures).toEqual([]);
    // The run must actually exercise budget cuts, safety recaps, capture and timeline.
    expect(maxDropped).toBeGreaterThan(0);
    expect(spans.length).toBeGreaterThan(0);
    expect(h.stored.some((e) => e.customType === 'roleplay-timeline')).toBe(true);
  },
);

// ──────────────────────────────────────────────────────────────────────
// P2: a custom-trigger coverage boundary snaps FORWARD past uncovered turns
// ──────────────────────────────────────────────────────────────────────

test('review: coverage ending on a scheduled-prompt input never drops that uncovered turn on the next pass', async () => {
  const h = await harness({ config: { keepTurns: 50, recapMaxAdvance: 24 }, windowTokens: 6000 });
  const pad = 'The lighthouse keeper narrates the storm in long careful sentences. '.repeat(45);
  const history: Message[] = [user('T0U opening', 1000), assistant('T0A ok', 1001)];
  for (let k = 1; k <= 5; k++) {
    const input = {
      role: 'custom',
      customType: 'scheduled-prompt',
      content: [{ type: 'text', text: `T${k}U ${pad}` }],
      display: true,
      timestamp: 1000 + k * 10,
    } as Message;
    history.push(input);
    await h.startCustom(input);
    const out = await h.request(history);
    expect(uncoveredDrops(history, out)).toEqual([]);
    history.push(assistant(`T${k}A ${pad}`, 1000 + k * 10 + 1));
  }
  expect(spans.length).toBeGreaterThan(0);
  // The player now types: the next pass must not jump the drop past the last custom turn.
  const typed = user('T9U the player speaks', 2000);
  history.push(typed);
  await h.start('T9U the player speaks');
  const out = await h.request(history);
  expect(h.abort).not.toHaveBeenCalled();
  expect(uncoveredDrops(history, out)).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// P2: an async recap landing after the compaction side-write clobbers it
// ──────────────────────────────────────────────────────────────────────

test('review: an async recap that lands after the compaction side-write never discards the evicted-span fold', async () => {
  // The background roll covers only turns 0-1 (recapMaxAdvance 4); compaction evicts turns 0-3.
  const h = await harness({ config: { keepTurns: 2, recapAsync: true, recapMaxAdvance: 4 } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  summary.detailed.mockImplementationOnce(async (_ctx, span, prior = '') => {
    spans.push(span);
    await gate;
    return { recap: `${prior} ASYNC_ROLL_RECAP`.trim(), raw: `${prior} ASYNC_ROLL_RECAP`.trim() };
  });
  const history = turns(6);
  await h.start('T5U');
  await h.request(history); // launches the background roll
  expect(summary.detailed).toHaveBeenCalledTimes(1);
  // Manual /compact: the side-write folds the evicted span into the recap...
  summary.compact.mockResolvedValueOnce('SIDE_WRITE_FOLD of the evicted turns 0-3');
  await h.dispatch('session_before_compact', {
    type: 'session_before_compact',
    reason: 'manual',
    preparation: { messagesToSummarize: history.slice(0, 8) },
  });
  // ...pi then runs its own summarizer; the background roll lands meanwhile.
  release();
  await flush();
  h.stored.push({ type: 'compaction', id: 'compaction-1' });
  await h.dispatch('session_compact');
  const compacted: Message[] = [
    { role: 'compactionSummary', summary: 'pi summary', tokensBefore: 1, timestamp: 5 },
    ...history.slice(8),
  ];
  await h.start('T5U');
  const out = await h.request(compacted);
  expect(out.map(text).join('\n')).toContain('SIDE_WRITE_FOLD');
});

// ──────────────────────────────────────────────────────────────────────
// P1: with no retained user message the recap lands in the system head,
// which pi's forced-prompt projection replaces (roleplay always forces it).
// ──────────────────────────────────────────────────────────────────────

test('review: scene memory always rides a transcript message, never the system head', async () => {
  const h = await harness({ config: { keepTurns: 50, recapMaxAdvance: 24 }, windowTokens: 6000 });
  const pad = 'The lighthouse keeper narrates the storm in long careful sentences. '.repeat(45);
  const history: Message[] = [user('T0U opening', 1000), assistant('T0A ok', 1001)];
  const misplaced: string[] = [];
  for (let k = 1; k <= 5; k++) {
    const input = {
      role: 'custom',
      customType: 'scheduled-prompt',
      content: [{ type: 'text', text: `T${k}U ${pad}` }],
      display: true,
      timestamp: 1000 + k * 10,
    } as Message;
    history.push(input);
    await h.startCustom(input);
    const out = await h.request(history);
    // The provider head is replaced by the forced prompt; memory in it is discarded.
    if (out.some((m) => m.role === 'system' && text(m).includes(RECAP_PREFIX))) misplaced.push(`turn ${k}`);
    history.push(assistant(`T${k}A ${pad}`, 1000 + k * 10 + 1));
  }
  expect(spans.length).toBeGreaterThan(0);
  expect(misplaced).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// P2: captured facts are session-scoped, not branch-scoped
// ──────────────────────────────────────────────────────────────────────

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (readFileSync(full, 'utf8').includes(needle)) hits.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

test('review: navigating to a branch that never captured a fact does not keep that fact in session memory', async () => {
  child.run.mockImplementation(async (agent) =>
    agent === 'roleplay-fact-extractor'
      ? JSON.stringify([{ name: 'Mira lost the FORK_ONLY_COMPASS', description: 'only on the abandoned branch' }])
      : null,
  );
  const h = await harness({ config: { keepTurns: 2, capture: true } });
  const fork = h.stored.length; // the tree point before any roll
  await h.start('T5U');
  await h.request(turns(6));
  const memoryRoot = join(h.agent, '..', 'memory');
  expect(filesContaining(memoryRoot, 'FORK_ONLY_COMPASS').length).toBeGreaterThan(0);
  // /tree back to before the roll: the active branch no longer carries the capture.
  h.offBranch.push(...h.stored.splice(fork));
  await h.dispatch('session_tree');
  // Reconciliation removes the note the abandoned branch captured. (A fork with
  // no recap on its path then seeds from the per-cast carry-over by design.)
  expect(filesContaining(join(memoryRoot), 'FORK_ONLY_COMPASS')).toEqual([]);
});

// ──────────────────────────────────────────────────────────────────────
// P2: summarizer and extractor children receive the unsanitized transcript
// ──────────────────────────────────────────────────────────────────────

const SYNTHETIC_KEY = 'sk-proj-' + 'A'.repeat(32); // Detector fixture, never a credential.

test('review: a recap roll never sends a secret the provider copy redacts to the summarizer child', async () => {
  const h = await harness({ config: { keepTurns: 2 }, redactor: true });
  const history = turns(6);
  history[0] = user(`T0U my key is ${SYNTHETIC_KEY}`, 1000);
  await h.start('T5U');
  const out = await h.request(history);
  expect(JSON.stringify(out)).not.toContain(SYNTHETIC_KEY); // the main provider copy is redacted
  expect(spans.length).toBeGreaterThan(0);
  expect(spans.join('\n')).not.toContain(SYNTHETIC_KEY);
});

// ──────────────────────────────────────────────────────────────────────
// P3: reload rebuilds a different condense boundary and re-rolls at once
// ──────────────────────────────────────────────────────────────────────

test('review: reload reproduces the live request without an extra roll', async () => {
  const config = { keepTurns: 2, recapStride: 0, recapChunk: 8, recapMaxAdvance: 4, summarizeMinMessages: 1 };
  const history = turns(10, 300);
  const live = await harness({ config });
  await live.start('T9U');
  await live.request(history);
  await live.start('T9U');
  const liveAgain = await live.request(history);
  const liveCalls = summary.detailed.mock.calls.length;
  const reloaded = await harness({ config, entries: live.stored });
  await reloaded.start('T9U');
  const out = await reloaded.request(history);
  expect(summary.detailed.mock.calls.length).toBe(liveCalls);
  expect(out.map(text)).toEqual(liveAgain.map(text));
});

test('review: returning to the branch that captured a fact restores that fact', async () => {
  child.run.mockImplementation(async (agent) =>
    agent === 'roleplay-fact-extractor'
      ? JSON.stringify([{ name: 'Mira keeps the BRANCH_A_COMPASS', description: 'captured on branch A' }])
      : null,
  );
  const h = await harness({ config: { keepTurns: 2, capture: true } });
  const fork = h.stored.length;
  await h.start('T5U');
  await h.request(turns(6));
  const memoryRoot = join(h.agent, '..', 'memory');
  const branchA = h.stored.splice(fork);
  h.offBranch.push(...branchA);
  await h.dispatch('session_tree');
  expect(filesContaining(memoryRoot, 'BRANCH_A_COMPASS')).toEqual([]);
  // Navigate back to branch A.
  h.offBranch.splice(0);
  h.stored.push(...branchA);
  await h.dispatch('session_tree');
  expect(filesContaining(memoryRoot, 'BRANCH_A_COMPASS').length).toBeGreaterThan(0);
});
