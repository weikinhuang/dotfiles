/**
 * Tests for lib/node/pi/comfyui/images.ts.
 */

import { describe, expect, test } from 'vitest';

import { mimeFromName } from '../../../../../lib/node/pi/comfyui/images.ts';

describe('mimeFromName', () => {
  test('maps known image extensions case-insensitively', () => {
    expect(mimeFromName('a.png')).toBe('image/png');
    expect(mimeFromName('a.jpg')).toBe('image/jpeg');
    expect(mimeFromName('a.JPEG')).toBe('image/jpeg');
    expect(mimeFromName('a.webp')).toBe('image/webp');
    expect(mimeFromName('a.GIF')).toBe('image/gif');
  });

  test('falls back to png for unknown or extensionless names', () => {
    expect(mimeFromName('output')).toBe('image/png');
    expect(mimeFromName('a.bmp')).toBe('image/png');
    expect(mimeFromName('')).toBe('image/png');
  });
});
