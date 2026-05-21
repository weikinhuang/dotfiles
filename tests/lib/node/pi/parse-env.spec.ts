/**
 * Tests for lib/node/pi/parse-env.ts.
 */

import { expect, test } from 'vitest';

import {
  envTruthy,
  parseNonNegativeInt,
  parseOptionalPositiveInt,
  parsePositiveInt,
} from '../../../../lib/node/pi/parse-env.ts';

// ──────────────────────────────────────────────────────────────────────
// parsePositiveInt
// ──────────────────────────────────────────────────────────────────────

test('parsePositiveInt: returns parsed value for positive integers', () => {
  expect(parsePositiveInt('42', 10)).toBe(42);
  expect(parsePositiveInt('1', 99)).toBe(1);
});

test('parsePositiveInt: falls back when value is undefined or empty', () => {
  expect(parsePositiveInt(undefined, 5)).toBe(5);
  expect(parsePositiveInt('', 5)).toBe(5);
});

test('parsePositiveInt: falls back on zero, negative, or NaN', () => {
  expect(parsePositiveInt('0', 5)).toBe(5);
  expect(parsePositiveInt('-3', 5)).toBe(5);
  expect(parsePositiveInt('abc', 5)).toBe(5);
});

test('parsePositiveInt: parseInt-style: stops at first non-digit', () => {
  // "1.5" parses to 1 via parseInt(.., 10)
  expect(parsePositiveInt('1.5', 99)).toBe(1);
  // "10extra" parses to 10
  expect(parsePositiveInt('10extra', 99)).toBe(10);
});

// ──────────────────────────────────────────────────────────────────────
// parseNonNegativeInt
// ──────────────────────────────────────────────────────────────────────

test('parseNonNegativeInt: accepts zero', () => {
  expect(parseNonNegativeInt('0', 5)).toBe(0);
});

test('parseNonNegativeInt: falls back on negative or invalid', () => {
  expect(parseNonNegativeInt('-1', 5)).toBe(5);
  expect(parseNonNegativeInt(undefined, 5)).toBe(5);
  expect(parseNonNegativeInt('abc', 5)).toBe(5);
});

test('parseNonNegativeInt: accepts positive integers', () => {
  expect(parseNonNegativeInt('7', 0)).toBe(7);
});

// ──────────────────────────────────────────────────────────────────────
// parseOptionalPositiveInt
// ──────────────────────────────────────────────────────────────────────

test('parseOptionalPositiveInt: accepts number inputs and floors them', () => {
  expect(parseOptionalPositiveInt(5)).toBe(5);
  expect(parseOptionalPositiveInt(3.9)).toBe(3);
});

test('parseOptionalPositiveInt: rejects non-positive numbers', () => {
  expect(parseOptionalPositiveInt(0)).toBeUndefined();
  expect(parseOptionalPositiveInt(-1)).toBeUndefined();
  expect(parseOptionalPositiveInt(Number.NaN)).toBeUndefined();
});

test('parseOptionalPositiveInt: parses positive string inputs', () => {
  expect(parseOptionalPositiveInt('42')).toBe(42);
});

test('parseOptionalPositiveInt: returns undefined for non-numeric / missing input', () => {
  expect(parseOptionalPositiveInt(undefined)).toBeUndefined();
  expect(parseOptionalPositiveInt(null)).toBeUndefined();
  expect(parseOptionalPositiveInt('abc')).toBeUndefined();
  expect(parseOptionalPositiveInt({})).toBeUndefined();
});

// ──────────────────────────────────────────────────────────────────────
// envTruthy
// ──────────────────────────────────────────────────────────────────────

test('envTruthy: true for canonical truthy strings (case-insensitive)', () => {
  expect(envTruthy('1')).toBe(true);
  expect(envTruthy('true')).toBe(true);
  expect(envTruthy('TRUE')).toBe(true);
  expect(envTruthy('yes')).toBe(true);
  expect(envTruthy('on')).toBe(true);
  expect(envTruthy('  on  ')).toBe(true);
});

test('envTruthy: false for empty / undefined / other values', () => {
  expect(envTruthy(undefined)).toBe(false);
  expect(envTruthy('')).toBe(false);
  expect(envTruthy('0')).toBe(false);
  expect(envTruthy('false')).toBe(false);
  expect(envTruthy('no')).toBe(false);
  expect(envTruthy('off')).toBe(false);
  expect(envTruthy('arbitrary')).toBe(false);
});
