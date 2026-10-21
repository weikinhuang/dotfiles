import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, test, vi } from 'vitest';

import loopBreaker from '../../../../config/pi/extensions/loop-breaker.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Setup {
  handlers: Map<string, Handler>;
  sendMessage: ReturnType<typeof vi.fn>;
  ctx: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } };
}

function setup(): Setup {
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    sendMessage,
  } as unknown as ExtensionAPI;
  vi.stubEnv('PI_LOOP_BREAKER_DISABLED', '0');
  vi.stubEnv('PI_LOOP_BREAKER_THRESHOLD', '3');
  vi.stubEnv('PI_LOOP_BREAKER_WINDOW', '6');
  loopBreaker(pi);
  const ctx = { hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn() } };
  return { handlers, sendMessage, ctx };
}

const blockedSearch = {
  type: 'tool_execution_start',
  toolCallId: 'c1',
  toolName: 'bash',
  args: { command: 'ai-fetch-web search lighthouse on the point demolished' },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

test('observes tool_execution_start, not tool_call, so gate-blocked calls still count', () => {
  const { handlers } = setup();
  expect(handlers.has('tool_execution_start')).toBe(true);
  expect(handlers.has('tool_call')).toBe(false);
});

test('steers once the same call repeats threshold times, then resets the window', () => {
  const { handlers, sendMessage, ctx } = setup();
  const start = handlers.get('tool_execution_start')!;
  start(blockedSearch, ctx);
  start(blockedSearch, ctx);
  expect(sendMessage).not.toHaveBeenCalled();
  start(blockedSearch, ctx);
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ customType: 'loop-breaker-nudge' });
  expect(sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: 'steer' });
  start(blockedSearch, ctx);
  expect(sendMessage).toHaveBeenCalledOnce();
});

test('ignores nested calls made through ctx.executeTool()', () => {
  const { handlers, sendMessage, ctx } = setup();
  const start = handlers.get('tool_execution_start')!;
  for (let i = 0; i < 5; i++) start({ ...blockedSearch, parentToolCallId: 'parent' }, ctx);
  expect(sendMessage).not.toHaveBeenCalled();
});

test('complete disable registers nothing', () => {
  vi.stubEnv('PI_LOOP_BREAKER_DISABLED', '1');
  const on = vi.fn();
  loopBreaker({ on } as unknown as ExtensionAPI);
  expect(on).not.toHaveBeenCalled();
});
