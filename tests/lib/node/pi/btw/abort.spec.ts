/**
 * Tests for lib/node/pi/btw/abort.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test, vi } from 'vitest';

import { NO_UNSUBSCRIBE, onAbort } from '../../../../../lib/node/pi/btw/abort.ts';

test('onAbort: runs handler synchronously when already aborted, returns no-op unsubscribe', () => {
  const controller = new AbortController();
  controller.abort();
  const handler = vi.fn();

  const unsubscribe = onAbort(controller.signal, handler);

  expect(handler).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toBe(NO_UNSUBSCRIBE);
  // Calling the no-op unsubscribe is safe.
  expect(() => unsubscribe()).not.toThrow();
});

test('onAbort: fires handler when the signal later aborts', () => {
  const controller = new AbortController();
  const handler = vi.fn();

  onAbort(controller.signal, handler);
  expect(handler).not.toHaveBeenCalled();

  controller.abort();
  expect(handler).toHaveBeenCalledTimes(1);
});

test('onAbort: unsubscribe removes the listener so a later abort does not fire', () => {
  const controller = new AbortController();
  const handler = vi.fn();

  const unsubscribe = onAbort(controller.signal, handler);
  unsubscribe();

  controller.abort();
  expect(handler).not.toHaveBeenCalled();
});

test('onAbort: only fires once (listener registered with { once: true })', () => {
  const controller = new AbortController();
  const handler = vi.fn();

  onAbort(controller.signal, handler);
  controller.abort();
  // A second abort is a no-op on an already-aborted controller, but assert
  // the handler count stays at one regardless.
  controller.signal.dispatchEvent(new Event('abort'));

  expect(handler).toHaveBeenCalledTimes(1);
});
