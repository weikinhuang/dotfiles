import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, test, vi } from 'vitest';

import cacheReminders from '../../../../../config/pi/extensions/cache-reminders.ts';
import { applyContextReminder, type ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { reminderMessageAnchor, REMINDER_SNAPSHOT_TYPE } from '../../../../../lib/node/pi/reminder-lifecycle.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('default delivery registers without an opt-in flag, and complete disable registers nothing', () => {
  const on = vi.fn();
  const subscribe = vi.fn(() => vi.fn());
  vi.stubEnv('PI_CACHE_REMINDERS_ENABLED', '0'); // Obsolete flags cannot restore legacy behavior.
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '');
  cacheReminders({ on, events: { on: subscribe } } as unknown as ExtensionAPI);
  expect(on).toHaveBeenCalledWith('context_with_system', expect.any(Function));
  expect(subscribe).toHaveBeenCalledWith('cache-reminders:placements', expect.any(Function));
  on.mockClear();
  subscribe.mockClear();
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '1');
  cacheReminders({ on, events: { on: subscribe } } as unknown as ExtensionAPI);
  expect(on).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
});

test('runtime captures once, persists branch data, and preserves the historical prefix after tool state changes', () => {
  vi.stubEnv('PI_CACHE_REMINDERS_ENABLED', '');
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '');
  const handlers = new Map<string, (event: unknown, ctx: unknown) => { messages: ReminderMessage[] } | undefined>();
  const stored: unknown[] = [];
  const emit = vi.fn();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => { messages: ReminderMessage[] } | undefined) => {
      handlers.set(name, handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      stored.push({ type: 'custom', customType, data });
    },
    events: { emit, on: vi.fn(() => vi.fn()) },
  } as unknown as ExtensionAPI;
  cacheReminders(pi);
  const ctx = { sessionManager: { getBranch: () => stored } };
  handlers.get('session_start')!({}, ctx);
  handlers.get('before_agent_start')!({}, ctx);
  const history: ReminderMessage[] = [
    { role: 'system', content: 'static', timestamp: 0 },
    { role: 'user', content: [{ type: 'text', text: 'prompt' }], timestamp: 1 },
  ];
  const first = handlers.get('context_with_system')!(
    { messages: applyContextReminder(history, { id: 'todo-plan', body: 'pending' }) },
    ctx,
  )!;
  expect(stored).toHaveLength(1);
  expect(emit).toHaveBeenCalledWith('cache-reminders:captured', expect.any(Object));
  const grown = [
    ...history,
    { role: 'assistant', content: [], timestamp: 2 },
    { role: 'toolResult', content: [{ type: 'text', text: 'complete' }], timestamp: 3 },
  ];
  const next = handlers.get('context_with_system')!(
    { messages: applyContextReminder(grown, { id: 'todo-plan', body: 'complete' }) },
    ctx,
  )!;
  expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(stored).toHaveLength(1);
  handlers.get('session_tree')!({}, ctx);
  expect(handlers.get('context_with_system')!({ messages: history }, ctx)?.messages).toEqual(first.messages);
});

test('actual coordinator captures placement bus data, restores stable roots and unsubscribes at shutdown', () => {
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '');
  const handlers = new Map<string, (event: unknown, ctx: unknown) => { messages: ReminderMessage[] } | undefined>();
  const listeners = new Map<string, (data: unknown) => void>();
  const stored: unknown[] = [];
  const unsubscribe = vi.fn(() => {
    listeners.delete('cache-reminders:placements');
  });
  const emit = vi.fn((channel: string, data: unknown) => {
    listeners.get(channel)?.(data);
  });
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => { messages: ReminderMessage[] } | undefined) => {
      handlers.set(name, handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      stored.push({ type: 'custom', customType, data });
    },
    events: {
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, listener);
        return unsubscribe;
      },
      emit,
    },
  } as unknown as ExtensionAPI;
  cacheReminders(pi);
  const ctx = { sessionManager: { getBranch: () => stored } };
  const old: ReminderMessage = { role: 'assistant', content: 'older scene', timestamp: 0 };
  const user: ReminderMessage = { role: 'user', content: 'continue', timestamp: 1 };
  const history = [old, user];
  const placements = [
    { anchor: reminderMessageAnchor(old), before: true, text: 'before scene' },
    { anchor: reminderMessageAnchor(old), before: false, text: 'after scene' },
  ];
  handlers.get('session_start')!({}, ctx);
  handlers.get('before_agent_start')!({}, ctx);
  emit('cache-reminders:placements', placements);
  const first = handlers.get('context_with_system')!({ messages: history }, ctx)!;
  const root = {
    anchor: reminderMessageAnchor(
      first.messages.find((message) => message.role === 'user' && message.cacheReminderSnapshot !== true)!,
    ),
    timestamp: 1,
    specs: [],
    placements,
  };
  expect(stored).toEqual([{ type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data: root }]);
  expect(emit).toHaveBeenCalledWith('cache-reminders:captured', root);
  expect(first.messages.map((message) => message.content)).toEqual([
    'before scene',
    old.content,
    'after scene',
    user.content,
  ]);
  expect(handlers.get('context_with_system')!({ messages: first.messages }, ctx)?.messages).toEqual(first.messages);
  const tool: ReminderMessage = { role: 'toolResult', content: 'output', timestamp: 2 };
  emit('cache-reminders:placements', [{ anchor: reminderMessageAnchor(tool), before: false, text: 'changed' }]);
  expect(handlers.get('context_with_system')!({ messages: [...history, tool] }, ctx)?.messages).toEqual([
    ...first.messages,
    tool,
  ]);
  for (const event of ['session_start', 'session_tree']) {
    handlers.get(event)!({}, ctx);
    emit('cache-reminders:placements', [{ anchor: reminderMessageAnchor(user), before: true, text: 'replacement' }]);
    expect(JSON.stringify(handlers.get('context_with_system')!({ messages: history }, ctx)?.messages)).toBe(
      JSON.stringify(first.messages),
    );
  }
  handlers.get('session_tree')!({}, ctx);
  emit('cache-reminders:placements', placements);
  expect(handlers.get('context_with_system')!({ messages: [...history, tool] }, ctx)?.messages).toEqual([
    ...first.messages,
    tool,
  ]);
  expect(stored).toHaveLength(1);
  stored.push({ type: 'compaction' });
  handlers.get('before_agent_start')!({}, ctx);
  emit('cache-reminders:placements', placements);
  handlers.get('session_compact')!({}, ctx);
  expect(handlers.get('context_with_system')!({ messages: history }, ctx)?.messages).toEqual(first.messages);
  handlers.get('session_shutdown')!({}, ctx);
  handlers.get('session_shutdown')!({}, ctx);
  expect(unsubscribe).toHaveBeenCalledTimes(6);
  expect(listeners.has('cache-reminders:placements')).toBe(false);
});
