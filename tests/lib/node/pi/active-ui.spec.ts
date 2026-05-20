/**
 * Tests for lib/node/pi/active-ui.ts.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  clearActiveUI,
  getActiveUI,
  getInteractiveActiveUI,
  publishActiveUI,
  type UIBridge,
} from '../../../../lib/node/pi/active-ui.ts';

afterEach(() => {
  clearActiveUI();
});

function makeUI(over: Partial<UIBridge> = {}): UIBridge {
  return {
    hasUI: true,
    select: vi.fn(() => Promise.resolve('a' as string | undefined)),
    input: vi.fn(() => Promise.resolve(undefined as string | undefined)),
    notify: vi.fn(),
    ...over,
  };
}

describe('publishActiveUI / getActiveUI', () => {
  test('returns undefined before any publish', () => {
    expect(getActiveUI()).toBeUndefined();
  });

  test('publish sets the slot, getActiveUI returns it', () => {
    const ui = makeUI();
    publishActiveUI(ui);
    expect(getActiveUI()).toBe(ui);
  });

  test('publish replaces the previous bridge (last writer wins)', () => {
    const a = makeUI();
    const b = makeUI();
    publishActiveUI(a);
    publishActiveUI(b);
    expect(getActiveUI()).toBe(b);
  });

  test('clearActiveUI drops the slot', () => {
    publishActiveUI(makeUI());
    clearActiveUI();
    expect(getActiveUI()).toBeUndefined();
  });
});

describe('getInteractiveActiveUI', () => {
  test('returns the bridge when hasUI: true', () => {
    const ui = makeUI({ hasUI: true });
    publishActiveUI(ui);
    expect(getInteractiveActiveUI()).toBe(ui);
  });

  test('returns undefined when hasUI: false (parent is -p mode)', () => {
    const ui = makeUI({ hasUI: false });
    publishActiveUI(ui);
    expect(getInteractiveActiveUI()).toBeUndefined();
    // The non-interactive bridge is still readable through the
    // generic accessor for callers that want to see "anyone's
    // around".
    expect(getActiveUI()).toBe(ui);
  });

  test('returns undefined when nothing has published', () => {
    expect(getInteractiveActiveUI()).toBeUndefined();
  });
});
