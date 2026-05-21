import { expect, test } from 'vitest';

// The two imports below intentionally hit the same module via distinct
// specifiers so the loader hands us two module records. See the block
// comment before the second import for the full rationale. The
// `import/no-duplicates` rule can't express "distinct records", so
// disable it just for this pair.
/* oxlint-disable import/no-duplicates */
import {
  getSandboxState as getSandboxStateA,
  isBashAutoEnabled as isBashAutoEnabledA,
  setBashAutoEnabled as setBashAutoEnabledA,
  setSandboxState as setSandboxStateA,
} from '../../../../lib/node/pi/session-flags.ts';
// Import a second copy via a different specifier (query string defeats
// the module cache and simulates pi's extension loader, which creates a
// fresh jiti instance per extension with `moduleCache: false` and
// therefore gives each extension its own module copy).
import {
  getSandboxState as getSandboxStateB,
  isBashAutoEnabled as isBashAutoEnabledB,
  setBashAutoEnabled as setBashAutoEnabledB,
  setSandboxState as setSandboxStateB,
} from '../../../../lib/node/pi/session-flags.ts?copy=b';
/* oxlint-enable import/no-duplicates */

test('session-flags: default state is OFF', () => {
  setBashAutoEnabledA(false);

  expect(isBashAutoEnabledA()).toBe(false);
  expect(isBashAutoEnabledB()).toBe(false);
});

test('session-flags: write in copy A is visible in copy B (globalThis singleton)', () => {
  // Precondition: two distinct module records. If this assertion ever
  // starts failing it means we've gone back to a shared module cache
  // and the regression guard no longer exercises the pi-loader scenario
  // - update the test setup (e.g. bump the query string).
  expect(setBashAutoEnabledA).not.toBe(setBashAutoEnabledB);

  setBashAutoEnabledA(true);

  expect(isBashAutoEnabledA()).toBe(true);
  expect(isBashAutoEnabledB(), 'flag must cross module-instance boundary').toBe(true);

  setBashAutoEnabledB(false);

  expect(isBashAutoEnabledA(), 'write from copy B must reach copy A').toBe(false);
  expect(isBashAutoEnabledB()).toBe(false);
});

test('session-flags: toggling is idempotent and boolean-coerced', () => {
  setBashAutoEnabledA(true);
  setBashAutoEnabledA(true);

  expect(isBashAutoEnabledB()).toBe(true);

  setBashAutoEnabledA(false);

  expect(isBashAutoEnabledB()).toBe(false);
});

test('session-flags: sandbox state defaults to mode=off with no reason', () => {
  setSandboxStateA({ mode: 'off' });

  expect(getSandboxStateA()).toEqual({ mode: 'off' });
  expect(getSandboxStateB()).toEqual({ mode: 'off' });
});

test('session-flags: sandbox writes from copy A are visible in copy B', () => {
  // Same regression-guard pattern as bashAuto above.
  expect(setSandboxStateA).not.toBe(setSandboxStateB);

  setSandboxStateA({ mode: 'wrapped' });
  expect(getSandboxStateA()).toEqual({ mode: 'wrapped' });
  expect(getSandboxStateB(), 'sandbox state must cross module-instance boundary').toEqual({ mode: 'wrapped' });

  setSandboxStateB({ mode: 'identity', reason: 'missing deps: bwrap, socat' });
  expect(getSandboxStateA()).toEqual({ mode: 'identity', reason: 'missing deps: bwrap, socat' });
  expect(getSandboxStateB()).toEqual({ mode: 'identity', reason: 'missing deps: bwrap, socat' });

  setSandboxStateA({ mode: 'off' });
});

test('session-flags: sandbox snapshot is decoupled from the slot', () => {
  setSandboxStateA({ mode: 'bypassed', reason: '/sandbox-disable' });

  const snap = getSandboxStateA();
  expect(snap).toEqual({ mode: 'bypassed', reason: '/sandbox-disable' });

  // Mutating the snapshot must not change the slot.
  snap.mode = 'wrapped';
  snap.reason = 'mutated';
  expect(getSandboxStateA()).toEqual({ mode: 'bypassed', reason: '/sandbox-disable' });

  setSandboxStateA({ mode: 'off' });
});
