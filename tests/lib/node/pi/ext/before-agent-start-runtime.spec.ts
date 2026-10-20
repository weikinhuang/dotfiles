import { convertToLlm, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import cacheReminders from '../../../../../config/pi/extensions/cache-reminders.ts';
import hooks from '../../../../../config/pi/extensions/hooks.ts';
import memory from '../../../../../config/pi/extensions/memory.ts';
import roleplay from '../../../../../config/pi/extensions/roleplay.ts';
import * as hookRunner from '../../../../../lib/node/pi/hooks/runner.ts';
import { clearActivePersona, setActivePersona } from '../../../../../lib/node/pi/persona/active.ts';
import { atomicWriteFile, fileFor } from '../../../../../lib/node/pi/roleplay/paths.ts';
import { emptyLoreMeta, serializeEntry } from '../../../../../lib/node/pi/roleplay/store.ts';
import { applyContextReminder, type ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { createReminderLifecycle } from '../../../../../lib/node/pi/reminder-lifecycle.ts';

interface RuntimeHarness {
  pi: ExtensionAPI;
  emit: (name: string, event: unknown, ctx: ExtensionContext) => Promise<unknown[]>;
  project: (messages: ReminderMessage[], ctx: ExtensionContext) => Promise<ReminderMessage[]>;
}

function createHarness(): RuntimeHarness {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const bus = new EventEmitter();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: () => ['roleplay'],
    getAllTools: () => [{ name: 'roleplay' }],
    setActiveTools: vi.fn(),
    events: {
      on: (name: string, listener: (value: unknown) => void) => {
        bus.on(name, listener);
        return () => {
          bus.off(name, listener);
        };
      },
      emit: (name: string, value: unknown) => {
        bus.emit(name, value);
      },
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    emit: (name, event, ctx) => Promise.all((handlers.get(name) ?? []).map((handler) => handler(event, ctx))),
    project: (messages, ctx) =>
      [...(handlers.get('context') ?? []), ...(handlers.get('context_with_system') ?? [])].reduce<
        Promise<ReminderMessage[]>
      >(
        (chain, handler) =>
          chain.then(async (current) => {
            const result = (await handler({ messages: current }, ctx)) as { messages?: ReminderMessage[] } | undefined;
            return result?.messages ?? current;
          }),
        Promise.resolve(structuredClone(messages)),
      ),
  };
}

function createContext(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => 'fixture', getBranch: () => [] },
  } as unknown as ExtensionContext;
}

interface CustomStart {
  type: 'before_agent_start';
  messageType: 'custom';
  systemPrompt: string;
  message: { role: 'custom'; customType: string; content: unknown; display: boolean; timestamp: number };
}

function customStart(customType: string, content: unknown = 'automated prompt'): CustomStart {
  return {
    type: 'before_agent_start',
    messageType: 'custom',
    systemPrompt: 'STATIC',
    message: { role: 'custom', customType, content, display: true, timestamp: 1 },
  };
}

const USER_START = {
  type: 'before_agent_start',
  messageType: 'user',
  prompt: 'user prompt',
  systemPrompt: 'STATIC',
};
const CUSTOM_TYPES = ['scheduled-prompt', 'bg-bash-nudge', 'stall-recovery-nudge'];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-run-start-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'));
  vi.stubEnv('PI_HOOKS_DISABLED', '');
  vi.stubEnv('PI_HOOKS_DEBUG', '');
  vi.stubEnv('PI_HOOKS_TRACE', '');
  vi.stubEnv('PI_MEMORY_ROOT', join(dir, 'memory'));
  vi.stubEnv('PI_MEMORY_DISABLED', '');
  vi.stubEnv('PI_MEMORY_READONLY', '');
  vi.stubEnv('PI_MEMORY_DISABLE_AUTOINJECT', '');
  vi.stubEnv('PI_MEMORY_DISABLE_CAPTURE', '');
  vi.stubEnv('PI_MEMORY_CAPTURE_TURN', '');
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '');
});

afterEach(() => {
  clearActivePersona();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('UserPromptSubmit runtime', () => {
  function installHooks(): {
    harness: RuntimeHarness;
    ctx: ExtensionContext;
    runHook: MockInstance<typeof hookRunner.runHook>;
  } {
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(
      join(dir, '.pi', 'hooks.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ command: '/fixture/prompt-hook' }] } }),
    );
    const runHook = vi.spyOn(hookRunner, 'runHook').mockResolvedValue({
      decision: 'continue',
      additionalContext: 'HOOK_CONTEXT',
    });
    const harness = createHarness();
    hooks(harness.pi);
    return { harness, ctx: createContext(dir), runHook };
  }

  test('user starts pass the actual prompt and retain system addenda', async () => {
    const { harness, ctx, runHook } = installHooks();
    const results = await harness.emit('before_agent_start', USER_START, ctx);
    expect(runHook).toHaveBeenCalledOnce();
    expect(runHook.mock.calls[0][0].payload).toEqual({
      event: 'UserPromptSubmit',
      prompt: 'user prompt',
      cwd: dir,
      session_id: '',
    });
    expect(JSON.stringify(results)).toContain('STATIC');
    expect(JSON.stringify(results)).toContain('HOOK_CONTEXT');
  });

  test.each(CUSTOM_TYPES)('custom %s starts do not run user hooks', async (customType) => {
    const { harness, ctx, runHook } = installHooks();
    expect(await harness.emit('before_agent_start', customStart(customType), ctx)).toEqual([undefined]);
    expect(runHook).not.toHaveBeenCalled();
  });
});

describe('memory capture activity runtime', () => {
  async function captureReminder(event: unknown): Promise<string> {
    const harness = createHarness();
    const ctx = createContext(dir);
    memory(harness.pi);
    await harness.emit('session_start', {}, ctx);
    await harness.emit('before_agent_start', event, ctx);
    await harness.emit('session_before_compact', {}, ctx);
    const results = await harness.emit('context', { messages: [{ role: 'user', content: 'prompt' }] }, ctx);
    return JSON.stringify(results);
  }

  test('a user start arms the capture reminder after compaction', async () => {
    expect(await captureReminder(USER_START)).toContain('memory-capture');
  });

  test.each(CUSTOM_TYPES)('custom %s starts do not count as unsaved user activity', async (customType) => {
    expect(await captureReminder(customStart(customType))).not.toContain('memory-capture');
  });
});

test.each(['string', 'multipart'])(
  'custom %s reminder snapshots retain the provider prefix across tool calls',
  (kind) => {
    const content = kind === 'string' ? 'scheduled prompt' : [{ type: 'text', text: 'scheduled prompt' }];
    const message = customStart('scheduled-prompt', content).message as ReminderMessage;
    const lifecycle = createReminderLifecycle();
    const first = lifecycle.project(applyContextReminder([message], { id: 'roleplay-lore', body: 'LORE' }));
    const toLlm = (messages: ReminderMessage[]): ReturnType<typeof convertToLlm> =>
      convertToLlm(messages as unknown as Parameters<typeof convertToLlm>[0]);
    const originalRequest = toLlm(first.messages);
    const next = lifecycle.project(
      applyContextReminder(
        [message, { role: 'toolResult', toolCallId: 'fixture', toolName: 'read', content: 'output', timestamp: 3 }],
        { id: 'roleplay-lore', body: 'CHANGED' },
      ),
    );
    expect(first.captured?.specs).toEqual([{ id: 'roleplay-lore', body: 'LORE' }]);
    expect(toLlm(next.messages).slice(0, originalRequest.length)).toEqual(originalRequest);
    lifecycle.restore([first.captured!]);
    expect(
      toLlm(lifecycle.project(applyContextReminder([message], { id: 'roleplay-lore', body: 'RESUMED' })).messages),
    ).toEqual(originalRequest);
    expect(message.content).toEqual(content);
  },
);

describe('roleplay run-start runtime', () => {
  let harness: RuntimeHarness;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    const root = join(dir, 'roleplay');
    vi.stubEnv('PI_ROLEPLAY_ROOT', root);
    vi.stubEnv('PI_ROLEPLAY_DISABLED', '');
    vi.stubEnv('PI_ROLEPLAY_DISABLE_AUTOINJECT', '');
    vi.stubEnv('PI_ROLEPLAY_DISABLE_LOREBOOK', '');
    vi.stubEnv('PI_ROLEPLAY_DISABLE_DEPTH_INJECT', '');
    vi.stubEnv('PI_ROLEPLAY_LORE_BUNDLES', '');
    vi.stubEnv('PI_ROLEPLAY_MAX_INJECTED_CHARS', '10000');
    for (const aspect of ['AVATAR', 'SUMMARIZE', 'CONTEXT_WINDOW', 'EVENTS', 'SCENEGEN', 'REPETITION']) {
      vi.stubEnv(`PI_ROLEPLAY_DISABLE_${aspect}`, '1');
    }
    setActivePersona({ name: 'fixture', resolvedWriteRoots: [], roleplay: true, cast: 'fixture', tools: ['roleplay'] });
    atomicWriteFile(
      fileFor('fixture', 'character', 'alice', root),
      serializeEntry({
        name: 'Alice',
        description: 'character index',
        kind: 'character',
        body: 'CHARACTER_BODY_MARKER',
      }),
    );
    for (const [id, delay] of [
      ['harbor', 0],
      ['tide', 2],
    ] as const) {
      atomicWriteFile(
        fileFor('fixture', 'lore', id, root),
        serializeEntry({
          name: id,
          description: 'lore index',
          kind: 'lore',
          body: `${id.toUpperCase()}_BODY_MARKER`,
          lore: { ...emptyLoreMeta(), triggers: [id], delay },
        }),
      );
    }
    harness = createHarness();
    ctx = createContext(dir);
    roleplay(harness.pi);
    cacheReminders(harness.pi);
    await harness.emit('session_start', {}, ctx);
  });

  afterEach(async () => {
    await harness.emit('session_shutdown', {}, ctx);
  });

  test.each([
    { name: 'string', content: 'Alice visits harbor' },
    {
      name: 'multipart',
      content: [
        { type: 'text', text: 'Alice visits' },
        { type: 'image', data: 'fixture', mimeType: 'image/png' },
        { type: 'text', text: 'harbor' },
      ],
    },
  ])('scheduled %s messages trigger scene folds and lore without modifying history', async ({ content }) => {
    const event = customStart('scheduled-prompt', content);
    const original = structuredClone(event.message);
    const started = await harness.emit('before_agent_start', event, ctx);
    expect(JSON.stringify(started)).toContain('STATIC');
    // Name-triggered sheets ride a reminder, never the cached system prompt.
    expect(JSON.stringify(started)).not.toContain('CHARACTER_BODY_MARKER');
    expect(JSON.stringify(started)).not.toContain('HARBOR_BODY_MARKER');
    const projected = await harness.project([event.message as ReminderMessage], ctx);
    expect(JSON.stringify(projected)).toContain('roleplay-scene-fold');
    expect(JSON.stringify(projected)).toContain('CHARACTER_BODY_MARKER');
    expect(JSON.stringify(projected)).toContain('roleplay-lore');
    expect(JSON.stringify(projected)).toContain('HARBOR_BODY_MARKER');
    expect(event.message).toEqual(original);
  });

  test('user prompts still trigger scene folds and lore', async () => {
    const event = { ...USER_START, prompt: 'Alice visits harbor' };
    const started = await harness.emit('before_agent_start', event, ctx);
    expect(JSON.stringify(started)).not.toContain('CHARACTER_BODY_MARKER');
    const projected = await harness.project([{ role: 'user', content: event.prompt }], ctx);
    expect(JSON.stringify(projected)).toContain('CHARACTER_BODY_MARKER');
    expect(JSON.stringify(projected)).toContain('HARBOR_BODY_MARKER');
  });

  test('non-text custom blocks do not fire character or lore keywords', async () => {
    const event = customStart('scheduled-prompt', [
      { type: 'image', data: 'Alice visits harbor', mimeType: 'image/png' },
    ]);
    const started = await harness.emit('before_agent_start', event, ctx);
    expect(JSON.stringify(started)).not.toContain('CHARACTER_BODY_MARKER');
    const projected = await harness.project([event.message as ReminderMessage], ctx);
    expect(JSON.stringify(projected)).not.toContain('CHARACTER_BODY_MARKER');
    expect(JSON.stringify(projected)).not.toContain('HARBOR_BODY_MARKER');
  });

  test('custom runs advance lore timing once, not on repeated context requests', async () => {
    const event = customStart('scheduled-prompt', 'tide');
    await harness.emit('before_agent_start', event, ctx);
    const repeated = await Promise.all(
      Array.from({ length: 3 }, () => harness.project([event.message as ReminderMessage], ctx)),
    );
    expect(JSON.stringify(repeated)).not.toContain('TIDE_BODY_MARKER');
    await harness.emit('before_agent_start', event, ctx);
    const projected = await harness.project([event.message as ReminderMessage], ctx);
    expect(JSON.stringify(projected)).toContain('TIDE_BODY_MARKER');
  });

  test('custom starts remain dormant without a roleplay persona', async () => {
    clearActivePersona();
    const event = customStart('scheduled-prompt', 'Alice visits harbor');
    expect((await harness.emit('before_agent_start', event, ctx)).every((result) => result === undefined)).toBe(true);
    expect(await harness.project([event.message as ReminderMessage], ctx)).toMatchObject([event.message]);
  });
});
