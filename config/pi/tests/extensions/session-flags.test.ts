import assert from 'node:assert/strict';
import { test } from 'node:test';
// The two imports below intentionally hit the same module via distinct
// specifiers so Node's ESM loader hands us two module records. See the
// block comment before the second import for the full rationale. The
// `import/no-duplicates` rule can't express "distinct records", so disable
// it just for this pair.
/* eslint-disable import/no-duplicates */
import {
  isBashAutoEnabled as isBashAutoEnabledA,
  setBashAutoEnabled as setBashAutoEnabledA,
} from '../../../../lib/node/pi/session-flags.ts';
// Import a second copy via a different specifier (query string defeats
// Node's ESM module cache and simulates pi's extension loader, which
// creates a fresh jiti instance per extension with `moduleCache: false`
// and therefore gives each extension its own module copy).
import {
  isBashAutoEnabled as isBashAutoEnabledB,
  setBashAutoEnabled as setBashAutoEnabledB,
} from '../../../../lib/node/pi/session-flags.ts?copy=b';
/* eslint-enable import/no-duplicates */

test('session-flags: default state is OFF', () => {
  setBashAutoEnabledA(false);
  assert.equal(isBashAutoEnabledA(), false);
  assert.equal(isBashAutoEnabledB(), false);
});

test('session-flags: write in copy A is visible in copy B (globalThis singleton)', () => {
  // Precondition: two distinct module records. If this assertion ever
  // starts failing it means we've gone back to a shared Node ESM module
  // and the regression guard no longer exercises the pi-loader scenario
  // — update the test setup (e.g. bump the query string).
  assert.notEqual(setBashAutoEnabledA, setBashAutoEnabledB);

  setBashAutoEnabledA(true);
  assert.equal(isBashAutoEnabledA(), true);
  assert.equal(isBashAutoEnabledB(), true, 'flag must cross module-instance boundary');

  setBashAutoEnabledB(false);
  assert.equal(isBashAutoEnabledA(), false, 'write from copy B must reach copy A');
  assert.equal(isBashAutoEnabledB(), false);
});

test('session-flags: toggling is idempotent and boolean-coerced', () => {
  setBashAutoEnabledA(true);
  setBashAutoEnabledA(true);
  assert.equal(isBashAutoEnabledB(), true);
  setBashAutoEnabledA(false);
  assert.equal(isBashAutoEnabledB(), false);
});
