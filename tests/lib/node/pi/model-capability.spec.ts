/**
 * Tests for lib/node/pi/model-capability.ts.
 */

import { describe, expect, test } from 'vitest';

import { isVisionCapable } from '../../../../lib/node/pi/model-capability.ts';

describe('isVisionCapable', () => {
  test('true when input includes "image"', () => {
    expect(isVisionCapable({ input: ['text', 'image'] })).toBe(true);
  });

  test('true for an image-only model', () => {
    expect(isVisionCapable({ input: ['image'] })).toBe(true);
  });

  test('false when input is text-only', () => {
    expect(isVisionCapable({ input: ['text'] })).toBe(false);
  });

  test('false when input is an empty array', () => {
    expect(isVisionCapable({ input: [] })).toBe(false);
  });

  test('defaults to ["text"] (text-only) when input is undefined', () => {
    expect(isVisionCapable({})).toBe(false);
  });

  test('order does not matter', () => {
    expect(isVisionCapable({ input: ['image', 'text'] })).toBe(true);
  });
});
