import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, test, vi } from 'vitest';

import costGuard from '../../../../../config/pi/extensions/cost-guard.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('runtime wires only local accounting/UI hooks; responses and provider context are untouched', () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getActiveTools: () => ['todo'],
  } as unknown as ExtensionAPI;
  vi.stubEnv('PI_COST_GUARD_DISABLED', '0');
  vi.stubEnv('PI_COST_GUARD_CALL_DOLLARS', '0.25');
  vi.stubEnv('PI_COST_GUARD_MILESTONES', 'none');
  vi.stubEnv('PI_COST_GUARD_WINDOW', '4');
  costGuard(pi);
  expect(handlers.has('context')).toBe(false);
  expect(handlers.has('context_with_system')).toBe(false);
  expect(handlers.has('before_provider_request')).toBe(false);
  expect(handlers.has('before_agent_start')).toBe(false);
  const ctx = { hasUI: true, ui: { notify, setStatus }, sessionManager: { getEntries: () => [] } };
  handlers.get('session_start')!({}, ctx);
  const event = {
    message: {
      role: 'assistant',
      model: 'fixture',
      provider: 'fixture',
      content: [{ type: 'text', text: 'unchanged' }],
      usage: { cacheRead: 16816, cacheWrite: 90000, cost: { total: 0.6, cacheWrite: 0.5 } },
    },
  };
  const original = structuredClone(event);
  expect(handlers.get('message_end')!(event, ctx)).toBeUndefined();
  expect(event).toEqual(original);
  expect(notify).toHaveBeenCalledOnce();
  handlers.get('message_end')!(event, ctx);
  expect(notify).toHaveBeenCalledOnce();
  handlers.get('session_shutdown')!({}, ctx);
  expect(setStatus).toHaveBeenLastCalledWith('cost-guard', undefined);
});

test('complete disable registers nothing', () => {
  vi.stubEnv('PI_COST_GUARD_DISABLED', '1');
  const on = vi.fn();
  costGuard({ on } as unknown as ExtensionAPI);
  expect(on).not.toHaveBeenCalled();
});
