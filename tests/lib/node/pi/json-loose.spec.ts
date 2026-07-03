/**
 * Tests for lib/node/pi/json-loose.ts: the tolerant JSON recovery
 * helpers shared by the comfyui enhance / refine parsers. These pin the
 * exact behaviour the two domain parsers were extracted from - fence
 * stripping, balanced-object extraction (string- and depth-aware), and
 * the parse-or-undefined contract.
 */

import { expect, test } from 'vitest';

import {
  extractBalancedArray,
  extractBalancedObject,
  parseJsonLoose,
  stripCodeFence,
} from '../../../../lib/node/pi/json-loose.ts';

// ── stripCodeFence ────────────────────────────────────────────────────

test('stripCodeFence: unfenced text is returned trimmed, untouched', () => {
  expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
  expect(stripCodeFence('plain prose')).toBe('plain prose');
});

test('stripCodeFence: drops a ```json fence', () => {
  expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
});

test('stripCodeFence: drops a bare ``` fence', () => {
  expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
});

// ── extractBalancedObject ─────────────────────────────────────────────

test('extractBalancedObject: a plain object', () => {
  expect(extractBalancedObject('{"a":1}')).toBe('{"a":1}');
});

test('extractBalancedObject: leading + trailing junk around the object', () => {
  expect(extractBalancedObject('Here you go: {"a":1} hope that helps!')).toBe('{"a":1}');
});

test('extractBalancedObject: returns the first of multiple objects', () => {
  expect(extractBalancedObject('{"a":1} and then {"b":2}')).toBe('{"a":1}');
});

test('extractBalancedObject: nested braces stay balanced', () => {
  expect(extractBalancedObject('{"a":{"b":2},"c":3}')).toBe('{"a":{"b":2},"c":3}');
});

test('extractBalancedObject: braces inside string values do not unbalance', () => {
  expect(extractBalancedObject('{"a":"x {glow} y","b":"}"}')).toBe('{"a":"x {glow} y","b":"}"}');
});

test('extractBalancedObject: escaped quote inside a string is handled', () => {
  expect(extractBalancedObject('{"a":"he said \\"hi\\" {x}"}')).toBe('{"a":"he said \\"hi\\" {x}"}');
});

test('extractBalancedObject: no object / unterminated returns null', () => {
  expect(extractBalancedObject('no braces here')).toBeNull();
  expect(extractBalancedObject('{"a":1')).toBeNull();
});

// ── extractBalancedArray ─────────────────────────────────────────

test('extractBalancedArray: a plain array', () => {
  expect(extractBalancedArray('[1, 2, 3]')).toBe('[1, 2, 3]');
});

test('extractBalancedArray: tolerates a ```json fence + surrounding prose', () => {
  expect(extractBalancedArray('Here you go:\n```json\n[{"a": 1}]\n```\ndone')).toBe('[{"a": 1}]');
});

test('extractBalancedArray: brackets inside string values do not unbalance', () => {
  expect(extractBalancedArray('[{"s": "a [nested] value"}]')).toBe('[{"s": "a [nested] value"}]');
});

test('extractBalancedArray: nested arrays stay balanced', () => {
  expect(extractBalancedArray('[[1,2],[3]]')).toBe('[[1,2],[3]]');
});

test('extractBalancedArray: escaped quote inside a string is handled', () => {
  expect(extractBalancedArray('["he said \\"hi\\" [x]"]')).toBe('["he said \\"hi\\" [x]"]');
});

test('extractBalancedArray: no array / unterminated returns null', () => {
  expect(extractBalancedArray('no array here')).toBeNull();
  expect(extractBalancedArray('[unterminated')).toBeNull();
});

// ── parseJsonLoose ────────────────────────────────────────────────────

test('parseJsonLoose: clean JSON parses directly', () => {
  expect(parseJsonLoose('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3]);
  expect(parseJsonLoose('null')).toBeNull();
});

test('parseJsonLoose: recovers an object embedded in prose', () => {
  expect(parseJsonLoose('Here: {"a":1} done')).toEqual({ a: 1 });
});

test('parseJsonLoose: first-of-multiple objects', () => {
  expect(parseJsonLoose('{"a":1} {"b":2}')).toEqual({ a: 1 });
});

test('parseJsonLoose: nested braces / braces-in-strings', () => {
  expect(parseJsonLoose('prefix {"a":{"b":2},"c":"}{"} suffix')).toEqual({ a: { b: 2 }, c: '}{' });
});

test('parseJsonLoose: unparseable input returns undefined (never throws)', () => {
  expect(parseJsonLoose('no json at all')).toBeUndefined();
  expect(parseJsonLoose('{"a":1')).toBeUndefined();
  expect(parseJsonLoose('')).toBeUndefined();
});
