/**
 * Tests for lib/node/opencode/plugin-options.ts.
 */

import { expect, test } from 'vitest';

import {
  createOptionReader,
  parseBoolish,
  parseNonEmptyString,
  parseNonNegativeNumber,
  toEnvKey,
} from '../../../../lib/node/opencode/plugin-options.ts';

test('parseBoolish: booleans, dotenv words, and unset', () => {
  expect(parseBoolish(true)).toBe(true);
  expect(parseBoolish(false)).toBe(false);
  expect(parseBoolish(' YES ')).toBe(true);
  expect(parseBoolish('on')).toBe(true);
  expect(parseBoolish('0')).toBe(false);
  expect(parseBoolish('Off')).toBe(false);
  expect(parseBoolish('maybe')).toBeUndefined();
  expect(parseBoolish('')).toBeUndefined();
  expect(parseBoolish(1)).toBeUndefined();
  expect(parseBoolish(undefined)).toBeUndefined();
});

test('parseNonNegativeNumber: numbers and numeric strings, zero and fractions allowed', () => {
  expect(parseNonNegativeNumber(30)).toBe(30);
  expect(parseNonNegativeNumber(0)).toBe(0);
  expect(parseNonNegativeNumber(' 2.5 ')).toBe(2.5);
  expect(parseNonNegativeNumber(-1)).toBeUndefined();
  expect(parseNonNegativeNumber('abc')).toBeUndefined();
  expect(parseNonNegativeNumber('')).toBeUndefined();
  expect(parseNonNegativeNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  expect(parseNonNegativeNumber(null)).toBeUndefined();
});

test('parseNonEmptyString: trims and drops blanks', () => {
  expect(parseNonEmptyString('  x ')).toBe('x');
  expect(parseNonEmptyString('   ')).toBeUndefined();
  expect(parseNonEmptyString(5)).toBeUndefined();
});

test('toEnvKey: camelCase to SCREAMING_SNAKE', () => {
  expect(toEnvKey('minSeconds')).toBe('MIN_SECONDS');
  expect(toEnvKey('titlePrefix')).toBe('TITLE_PREFIX');
  expect(toEnvKey('tool')).toBe('TOOL');
  expect(toEnvKey('max-items')).toBe('MAX_ITEMS');
});

test('createOptionReader: env beats option beats default', () => {
  const read = createOptionReader({ minSeconds: 10, tool: false }, { X_MIN_SECONDS: '5' }, 'X_');
  expect(read.number('minSeconds', 30)).toBe(5);
  expect(read.bool('tool', true)).toBe(false);
  expect(read.string('command', 'quick-toast')).toBe('quick-toast');
  expect(read.optionalString('trace')).toBeUndefined();
  expect(read.envName('minSeconds')).toBe('X_MIN_SECONDS');
});

test('createOptionReader: unparseable layers fall through', () => {
  const read = createOptionReader({ minSeconds: 'soon', tool: 'yes' }, { X_TOOL: 'bogus', X_MIN_SECONDS: '' }, 'X_');
  expect(read.number('minSeconds', 30)).toBe(30);
  expect(read.bool('tool', false)).toBe(true);
});

test('createOptionReader: undefined options and inherited keys are ignored', () => {
  expect(createOptionReader(undefined, {}, 'X_').bool('enabled', true)).toBe(true);
  const inherited = Object.create({ tool: false }) as Record<string, unknown>;
  expect(createOptionReader(inherited, {}, 'X_').bool('tool', true)).toBe(true);
});
