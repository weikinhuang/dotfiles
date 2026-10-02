import { describe, expect, test } from 'vitest';

import { isNestedToolEvent, preserveStructuredContent } from '../../../../lib/node/pi/tool-events.ts';

describe('isNestedToolEvent', () => {
  test('returns false for a direct model tool call', () => {
    expect(isNestedToolEvent({})).toBe(false);
  });

  test('returns true for a call made through another tool', () => {
    expect(isNestedToolEvent({ parentToolCallId: 'parent/1' })).toBe(true);
  });
});

describe('preserveStructuredContent', () => {
  test('omits the patch field when no structured content exists', () => {
    expect(preserveStructuredContent({})).toEqual({});
  });

  test('preserves objects and explicit null values', () => {
    const structured = { output: 'full output', truncated: false };
    expect(preserveStructuredContent({ structuredContent: structured })).toEqual({ structuredContent: structured });
    expect(preserveStructuredContent({ structuredContent: null })).toEqual({ structuredContent: null });
  });
});
