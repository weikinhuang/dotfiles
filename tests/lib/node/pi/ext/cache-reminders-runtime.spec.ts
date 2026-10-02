import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, test, vi } from 'vitest';

import cacheReminders from '../../../../../config/pi/extensions/cache-reminders.ts';
import { applyContextReminder, type ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('rollout is opt-in and full disable wins', () => {
  const on = vi.fn();
  vi.stubEnv('PI_CACHE_REMINDERS_ENABLED', '');
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '');
  cacheReminders({ on } as unknown as ExtensionAPI);
  expect(on).not.toHaveBeenCalled();
  vi.stubEnv('PI_CACHE_REMINDERS_ENABLED', '1');
  vi.stubEnv('PI_CACHE_REMINDERS_DISABLED', '1');
  cacheReminders({ on } as unknown as ExtensionAPI);
  expect(on).not.toHaveBeenCalled();
});

test('runtime captures once, persists branch data, and preserves the historical prefix after tool state changes', () => {
  vi.stubEnv('PI_CACHE_REMINDERS_ENABLED', '1');
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
    events: { emit },
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
  expect(emit).toHaveBeenCalledOnce();
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
