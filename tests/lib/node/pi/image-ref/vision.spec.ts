/**
 * Tests for lib/node/pi/image-ref/vision.ts.
 */

import { describe, expect, test } from 'vitest';

import { modelAcceptsImages } from '../../../../../lib/node/pi/image-ref/vision.ts';

describe('modelAcceptsImages', () => {
  test('true when the input array includes image', () => {
    expect(modelAcceptsImages(['text', 'image'])).toBe(true);
  });

  test('false when the input array lacks image', () => {
    expect(modelAcceptsImages(['text'])).toBe(false);
  });

  test('true (optimistic) when capability is unknown', () => {
    expect(modelAcceptsImages(undefined)).toBe(true);
    expect(modelAcceptsImages(null)).toBe(true);
    expect(modelAcceptsImages('text')).toBe(true);
  });
});
