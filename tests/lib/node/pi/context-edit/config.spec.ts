/**
 * Tests for lib/node/pi/context-edit/config.ts coercion.
 *
 * Pure module - no pi runtime needed. `loadTrimConfig` /
 * `loadToolCollapseConfig` touch disk, so we only unit-test the pure
 * `coerce*Layer` validators here.
 */

import { describe, expect, test } from 'vitest';

import { coerceToolCollapseLayer, coerceTrimLayer } from '../../../../../lib/node/pi/context-edit/config.ts';

describe('coerceTrimLayer', () => {
  test('keeps valid numeric thresholds', () => {
    expect(coerceTrimLayer({ minTextBytes: 4096, snippetChars: 120 })).toEqual({
      minTextBytes: 4096,
      snippetChars: 120,
    });
  });

  test('accepts a non-empty captionModel string (trimmed)', () => {
    expect(coerceTrimLayer({ captionModel: '  anthropic/claude-haiku  ' })).toEqual({
      captionModel: 'anthropic/claude-haiku',
    });
  });

  test('drops an empty / non-string captionModel', () => {
    expect(coerceTrimLayer({ captionModel: '   ' })).toEqual({});
    expect(coerceTrimLayer({ captionModel: 42 })).toEqual({});
  });

  test('ignores junk and non-objects', () => {
    expect(coerceTrimLayer(null)).toEqual({});
    expect(coerceTrimLayer({ minTextBytes: -1, snippetChars: 0 })).toEqual({});
  });
});

describe('coerceToolCollapseLayer (unaffected by captionModel)', () => {
  test('carries no captionModel key', () => {
    expect(coerceToolCollapseLayer({ captionModel: 'x', autoAfterTurns: 3 })).toEqual({ autoAfterTurns: 3 });
  });
});
