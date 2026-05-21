/**
 * Tests for `lib/node/pi/sandbox/markers.ts` - the pure marker /
 * identity-wrap helpers shared between the `sandbox.ts` extension and
 * its specs.
 */

import { describe, expect, test } from 'vitest';

import {
  alreadyWrapped,
  buildIdentityWrap,
  SANDBOX_MARKER,
  SANDBOX_ORIGINAL_SYMBOL,
  stripMarkerFromUserInput,
} from '../../../../../lib/node/pi/sandbox/markers.ts';

describe('SANDBOX_MARKER constant', () => {
  test('matches the documented re-entry-guard literal', () => {
    expect(SANDBOX_MARKER).toBe('__PI_SANDBOX_WRAPPED=1');
  });
});

describe('SANDBOX_ORIGINAL_SYMBOL', () => {
  test('is a process-wide-stable Symbol.for symbol', () => {
    expect(typeof SANDBOX_ORIGINAL_SYMBOL).toBe('symbol');
    // Two import sites of the same module must agree on the value.
    expect(SANDBOX_ORIGINAL_SYMBOL).toBe(Symbol.for('@dotfiles/pi/sandbox/originalCommand'));
  });
});

describe('alreadyWrapped', () => {
  test('detects the marker at the start of the command', () => {
    expect(alreadyWrapped('__PI_SANDBOX_WRAPPED=1 sh -c true')).toBe(true);
  });
  test('detects the marker after leading whitespace', () => {
    expect(alreadyWrapped('   __PI_SANDBOX_WRAPPED=1 sh -c true')).toBe(true);
    expect(alreadyWrapped('\t\n  __PI_SANDBOX_WRAPPED=1 sh -c true')).toBe(true);
  });
  test('does not match a marker mid-command', () => {
    expect(alreadyWrapped('echo __PI_SANDBOX_WRAPPED=1')).toBe(false);
  });
  test('does not match plain commands', () => {
    expect(alreadyWrapped('git log -1')).toBe(false);
  });
  test('does not match the empty / whitespace command', () => {
    expect(alreadyWrapped('')).toBe(false);
    expect(alreadyWrapped('   ')).toBe(false);
  });
});

describe('stripMarkerFromUserInput', () => {
  test('strips a single leading marker + space', () => {
    expect(stripMarkerFromUserInput('__PI_SANDBOX_WRAPPED=1 git log')).toBe('git log');
  });
  test('strips stacked markers (model retries with two prefixes)', () => {
    expect(stripMarkerFromUserInput('__PI_SANDBOX_WRAPPED=1 __PI_SANDBOX_WRAPPED=1 git log')).toBe('git log');
  });
  test('strips leading whitespace + marker', () => {
    expect(stripMarkerFromUserInput('  __PI_SANDBOX_WRAPPED=1 git log')).toBe('git log');
  });
  test('strips leading semicolons + whitespace + marker (defensive)', () => {
    expect(stripMarkerFromUserInput(' ; __PI_SANDBOX_WRAPPED=1 git log')).toBe('git log');
  });
  test('passes through commands with no marker', () => {
    expect(stripMarkerFromUserInput('git log')).toBe('git log');
    expect(stripMarkerFromUserInput('')).toBe('');
  });
  test('does not strip marker tokens that appear mid-command', () => {
    expect(stripMarkerFromUserInput('echo __PI_SANDBOX_WRAPPED=1')).toBe('echo __PI_SANDBOX_WRAPPED=1');
  });
  test('does not strip a marker without a trailing space (incomplete prefix)', () => {
    expect(stripMarkerFromUserInput('__PI_SANDBOX_WRAPPED=1noSpace')).toBe('__PI_SANDBOX_WRAPPED=1noSpace');
  });
});

describe('buildIdentityWrap', () => {
  test('produces a marker-prefixed sh -c invocation', () => {
    expect(buildIdentityWrap('git log')).toBe(`__PI_SANDBOX_WRAPPED=1 sh -c 'git log'`);
  });
  test('shell-quotes embedded single quotes', () => {
    expect(buildIdentityWrap(`echo 'hi'`)).toBe(`__PI_SANDBOX_WRAPPED=1 sh -c 'echo '\\''hi'\\'''`);
  });
  test('preserves embedded newlines literally inside the single-quoted block', () => {
    const cmd = `printf '%s\\n' 'a'`;
    expect(buildIdentityWrap(cmd)).toBe(`__PI_SANDBOX_WRAPPED=1 sh -c 'printf '\\''%s\\n'\\'' '\\''a'\\'''`);
  });
  test('the identity-wrap output is itself recognised by alreadyWrapped', () => {
    expect(alreadyWrapped(buildIdentityWrap('git log'))).toBe(true);
  });
});
