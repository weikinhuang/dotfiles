/**
 * Tests for lib/node/pi/persona/model-spec.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { parseModelSpec } from '../../../../../lib/node/pi/persona/model-spec.ts';

test('splits provider/id on the first slash', () => {
  expect(parseModelSpec('anthropic/claude-opus')).toEqual({ provider: 'anthropic', modelId: 'claude-opus' });
  // Only the first slash splits; the rest stays in modelId.
  expect(parseModelSpec('openrouter/vendor/model')).toEqual({ provider: 'openrouter', modelId: 'vendor/model' });
});

test('returns null when there is no provider before the slash', () => {
  expect(parseModelSpec('claude-opus')).toBeNull();
  expect(parseModelSpec('/leading-slash')).toBeNull();
  expect(parseModelSpec('')).toBeNull();
});
