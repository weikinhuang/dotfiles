/**
 * Tests for lib/node/pi/ext/show-modal.ts.
 */

import { afterEach, expect, test } from 'vitest';

import { isModalUiActive, resetModalUi } from '../../../../../lib/node/pi/ui-activity.ts';
import { type ModalFactory, showModal } from '../../../../../lib/node/pi/ext/show-modal.ts';

afterEach(() => {
  resetModalUi();
});

// A stand-in factory; showModal never renders it in these tests (the fake ui
// below ignores it), so its body is irrelevant.
const noopFactory: ModalFactory<unknown> = () => ({
  render: () => [],
  invalidate: () => {
    /* no-op */
  },
});

test('showModal: flag is active while ui.custom is pending, cleared after', async () => {
  let activeDuring: boolean | undefined;
  const ui = {
    custom: async <T>(_factory: ModalFactory<T>, _options?: unknown): Promise<T> => {
      activeDuring = isModalUiActive();
      return 'result' as T;
    },
  };
  const result = await showModal<string>(ui, noopFactory as ModalFactory<string>);
  expect(activeDuring).toBe(true);
  expect(result).toBe('result');
  expect(isModalUiActive()).toBe(false);
});

test('showModal: clears the flag even when ui.custom rejects', async () => {
  const ui = {
    custom: async <T>(_factory: ModalFactory<T>): Promise<T> => {
      throw new Error('boom');
    },
  };
  await expect(showModal(ui, noopFactory)).rejects.toThrow('boom');
  expect(isModalUiActive()).toBe(false);
});

test('showModal: forwards factory and options through to ui.custom', async () => {
  let received: { factory: unknown; options: unknown } | undefined;
  const ui = {
    custom: async <T>(factory: ModalFactory<T>, options?: unknown): Promise<T> => {
      received = { factory, options };
      return undefined as T;
    },
  };
  const opts = { overlay: true };
  await showModal(ui, noopFactory, opts);
  expect(received?.factory).toBe(noopFactory);
  expect(received?.options).toBe(opts);
});
