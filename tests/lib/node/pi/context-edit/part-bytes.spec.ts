/**
 * Tests for lib/node/pi/context-edit/part-bytes.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { approxImageBytes, partText } from '../../../../../lib/node/pi/context-edit/part-bytes.ts';
import type { LoosePart } from '../../../../../lib/node/pi/context-edit/target.ts';

describe('partText', () => {
  test('returns the text of a text part', () => {
    expect(partText({ type: 'text', text: 'hello' })).toBe('hello');
  });

  test('returns empty string for non-text parts', () => {
    expect(partText({ type: 'image', data: 'AAAA', mimeType: 'image/png' })).toBe('');
    expect(partText({ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} } as LoosePart)).toBe('');
    expect(partText({ type: 'text' } as LoosePart)).toBe(''); // missing text field
  });
});

describe('approxImageBytes', () => {
  test('estimates decoded size as ~3/4 of the base64 length', () => {
    expect(approxImageBytes({ type: 'image', data: 'A'.repeat(4000), mimeType: 'image/png' })).toBe(3000);
  });

  test('returns 0 when there is no string data', () => {
    expect(approxImageBytes({ type: 'text', text: 'x' })).toBe(0);
    expect(approxImageBytes({ type: 'image', mimeType: 'image/png' } as LoosePart)).toBe(0);
  });
});
