/**
 * Tests for lib/node/pi/ui-activity.ts.
 */

import { afterEach, expect, test } from 'vitest';

import { enterModalUi, exitModalUi, isModalUiActive, resetModalUi } from '../../../../lib/node/pi/ui-activity.ts';

afterEach(() => {
  resetModalUi();
});

test('isModalUiActive: false by default', () => {
  expect(isModalUiActive()).toBe(false);
});

test('enterModalUi / exitModalUi: toggles active state', () => {
  enterModalUi();
  expect(isModalUiActive()).toBe(true);
  exitModalUi();
  expect(isModalUiActive()).toBe(false);
});

test('nested enters require matching exits (counter, not boolean)', () => {
  enterModalUi();
  enterModalUi();
  expect(isModalUiActive()).toBe(true);
  exitModalUi();
  expect(isModalUiActive()).toBe(true);
  exitModalUi();
  expect(isModalUiActive()).toBe(false);
});

test('exitModalUi: clamps at zero (extra exits are harmless)', () => {
  exitModalUi();
  exitModalUi();
  expect(isModalUiActive()).toBe(false);
  enterModalUi();
  expect(isModalUiActive()).toBe(true);
});

test('resetModalUi: forces back to zero regardless of depth', () => {
  enterModalUi();
  enterModalUi();
  enterModalUi();
  resetModalUi();
  expect(isModalUiActive()).toBe(false);
});
