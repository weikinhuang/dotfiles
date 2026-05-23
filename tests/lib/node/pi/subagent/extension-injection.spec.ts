/**
 * Tests for lib/node/pi/subagent/extension-injection.ts.
 */

import { afterEach, describe, expect, test } from 'vitest';

import {
  clearSubagentInjections,
  collectSubagentInjections,
  listSubagentInjections,
  registerSubagentInjection,
  unregisterSubagentInjection,
} from '../../../../../lib/node/pi/subagent/extension-injection.ts';

afterEach(() => {
  clearSubagentInjections();
});

const noop = (): undefined => undefined;

describe('registerSubagentInjection', () => {
  test('rejects empty id and non-function factory', () => {
    expect(() => registerSubagentInjection('', noop)).toThrow(/`id` is required/);
    expect(() => registerSubagentInjection('x', undefined as unknown as () => void)).toThrow(/must be a function/);
  });

  test('appends new factories in registration order', () => {
    const a = (): void => undefined;
    const b = (): void => undefined;
    registerSubagentInjection('a', a);
    registerSubagentInjection('b', b);
    expect(collectSubagentInjections()).toEqual([a, b]);
  });

  test('re-registering the same id REPLACES the existing factory in place', () => {
    const a1 = (): void => undefined;
    const a2 = (): void => undefined;
    const b = (): void => undefined;
    registerSubagentInjection('a', a1);
    registerSubagentInjection('b', b);
    registerSubagentInjection('a', a2);
    // Order is preserved even though 'a' was replaced.
    expect(collectSubagentInjections()).toEqual([a2, b]);
  });
});

describe('unregisterSubagentInjection', () => {
  test('returns true when something was removed', () => {
    registerSubagentInjection('a', noop);
    expect(unregisterSubagentInjection('a')).toBe(true);
    expect(collectSubagentInjections()).toEqual([]);
  });

  test('returns false when no such id was registered', () => {
    expect(unregisterSubagentInjection('missing')).toBe(false);
  });
});

describe('collectSubagentInjections / listSubagentInjections', () => {
  test('collect returns a fresh array - mutating it does not affect the registry', () => {
    registerSubagentInjection('a', noop);
    const arr = collectSubagentInjections();
    arr.push(noop);
    expect(collectSubagentInjections().length).toBe(1);
  });

  test('list returns id+factory pairs', () => {
    registerSubagentInjection('a', noop);
    expect(listSubagentInjections()).toEqual([{ id: 'a', factory: noop }]);
  });

  test('empty registry yields empty arrays', () => {
    expect(collectSubagentInjections()).toEqual([]);
    expect(listSubagentInjections()).toEqual([]);
  });
});
