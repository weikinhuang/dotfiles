/**
 * Regression: a restored `/roleplay cast` override is re-slugged, since it
 * becomes a path segment under `casts/` (lib/node/pi/roleplay/scene-state.ts).
 */
import { expect, test } from 'vitest';

import { CAST_OVERRIDE_TYPE, restoreCastOverride } from '../../../../../../lib/node/pi/roleplay/scene-state.ts';

const override = (value: unknown): Record<string, unknown> => ({
  type: 'custom',
  customType: CAST_OVERRIDE_TYPE,
  data: { override: value },
});

test('scene-state-review: a traversing override from session data cannot escape casts/', () => {
  const restored = restoreCastOverride([override('../../etc')]);
  expect(restored).not.toBeNull();
  expect(restored).not.toContain('/');
  expect(restored).not.toContain('..');
});

test('scene-state-review: legitimate slugs are unchanged and a blank override reads as none', () => {
  expect(restoreCastOverride([override('exusiai-texas')])).toBe('exusiai-texas');
  expect(restoreCastOverride([override('Exusiai & Texas')])).toBe('exusiai-texas');
  expect(restoreCastOverride([override('   ')])).toBeNull();
});
