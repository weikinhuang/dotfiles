/**
 * Tests for lib/node/pi/ext/pi-session.ts.
 *
 * This module is a thin type adapter around pi's `createAgentSession`; the
 * real coverage is `npm run tsc` (the generic arguments must line up with
 * `runOneShotAgent`'s `deps.createAgentSession`). This spec just guards that
 * the shared export exists and is callable so the five call sites can rely
 * on importing it.
 */

import { expect, test } from 'vitest';

import { piCreateAgentSession } from '../../../../../lib/node/pi/ext/pi-session.ts';

test('piCreateAgentSession: is a callable session factory', () => {
  expect(typeof piCreateAgentSession).toBe('function');
});
