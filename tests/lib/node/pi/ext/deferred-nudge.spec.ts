/**
 * Tests for lib/node/pi/ext/deferred-nudge.ts.
 *
 * The module imports `@earendil-works/pi-coding-agent` (type-only,
 * `ExtensionAPI` / `ExtensionContext`) and defers delivery one
 * event-loop tick via `setImmediate`. We fake `pi.sendMessage` and a
 * `ctx.isIdle()` stub, then await a `setImmediate` tick so the deferred
 * call has run before asserting.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';

import { deliverDeferredNudge } from '../../../../../lib/node/pi/ext/deferred-nudge.ts';

interface SendCall {
  message: unknown;
  delivery: unknown;
}

function fakePi(calls: SendCall[], throwOnSend = false): ExtensionAPI {
  return {
    sendMessage: (message: unknown, delivery: unknown) => {
      calls.push({ message, delivery });
      if (throwOnSend) throw new Error('boom');
    },
  } as unknown as ExtensionAPI;
}

function fakeCtx(idle: boolean): ExtensionContext {
  return { isIdle: () => idle } as unknown as ExtensionContext;
}

/** Resolve after the current `setImmediate` queue drains. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('idle -> triggerTurn branch, onDelivered fires', async () => {
  const calls: SendCall[] = [];
  let delivered = false;
  deliverDeferredNudge({
    pi: fakePi(calls),
    ctx: fakeCtx(true),
    customType: 'my-nudge',
    content: 'hello',
    onDelivered: () => {
      delivered = true;
    },
  });
  // Deferred: nothing has run synchronously yet.
  expect(calls).toHaveLength(0);
  await tick();
  expect(calls).toHaveLength(1);
  expect(calls[0].message).toEqual({ customType: 'my-nudge', content: 'hello', display: true });
  expect(calls[0].delivery).toEqual({ triggerTurn: true });
  expect(delivered).toBe(true);
});

test('non-idle -> followUp branch', async () => {
  const calls: SendCall[] = [];
  deliverDeferredNudge({
    pi: fakePi(calls),
    ctx: fakeCtx(false),
    customType: 'my-nudge',
    content: 'hey',
  });
  await tick();
  expect(calls).toHaveLength(1);
  expect(calls[0].delivery).toEqual({ deliverAs: 'followUp' });
});

test('deliver error invokes onDeliverError, not onScheduleError', async () => {
  const calls: SendCall[] = [];
  let deliverErr: unknown;
  let scheduleErr: unknown;
  deliverDeferredNudge({
    pi: fakePi(calls, true),
    ctx: fakeCtx(true),
    customType: 'my-nudge',
    content: 'hello',
    onDeliverError: (e) => {
      deliverErr = e;
    },
    onScheduleError: (e) => {
      scheduleErr = e;
    },
  });
  await tick();
  expect(calls).toHaveLength(1);
  expect(deliverErr).toBeInstanceOf(Error);
  expect((deliverErr as Error).message).toBe('boom');
  expect(scheduleErr).toBeUndefined();
});

test('deliver error with no onDeliverError does not throw', async () => {
  const calls: SendCall[] = [];
  deliverDeferredNudge({
    pi: fakePi(calls, true),
    ctx: fakeCtx(false),
    customType: 'my-nudge',
    content: 'hello',
  });
  // Awaiting the tick would surface an unhandled throw from the
  // deferred callback if the helper failed to guard it.
  await expect(tick()).resolves.toBeUndefined();
  expect(calls).toHaveLength(1);
});

test('schedule error invokes onScheduleError', () => {
  const calls: SendCall[] = [];
  const original = globalThis.setImmediate;
  let scheduleErr: unknown;
  // Force the outer scheduling guard to fire.
  (globalThis as { setImmediate: unknown }).setImmediate = () => {
    throw new Error('cannot schedule');
  };
  try {
    deliverDeferredNudge({
      pi: fakePi(calls),
      ctx: fakeCtx(true),
      customType: 'my-nudge',
      content: 'hello',
      onScheduleError: (e) => {
        scheduleErr = e;
      },
    });
  } finally {
    (globalThis as { setImmediate: typeof original }).setImmediate = original;
  }
  expect(calls).toHaveLength(0);
  expect(scheduleErr).toBeInstanceOf(Error);
  expect((scheduleErr as Error).message).toBe('cannot schedule');
});
