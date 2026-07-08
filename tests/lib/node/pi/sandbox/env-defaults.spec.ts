/**
 * Specs for the `PI_SANDBOX_DEFAULT` / `PI_SANDBOX_NETWORK_DEFAULT`
 * env parsers. Both fold missing / unknown values to their documented
 * default and are case- and whitespace-insensitive.
 */

import { describe, expect, test } from 'vitest';

import { resolveNetworkDefault, resolveSandboxFallback } from '../../../../../lib/node/pi/sandbox/env-defaults.ts';

describe('resolveSandboxFallback', () => {
  test('accepts the three known values, case/space-insensitive', () => {
    expect(resolveSandboxFallback({ PI_SANDBOX_DEFAULT: 'allow' })).toBe('allow');
    expect(resolveSandboxFallback({ PI_SANDBOX_DEFAULT: 'BLOCK' })).toBe('block');
    expect(resolveSandboxFallback({ PI_SANDBOX_DEFAULT: '  Warn  ' })).toBe('warn');
  });

  test('defaults to warn when missing or unknown', () => {
    expect(resolveSandboxFallback({})).toBe('warn');
    expect(resolveSandboxFallback({ PI_SANDBOX_DEFAULT: 'nonsense' })).toBe('warn');
    expect(resolveSandboxFallback({ PI_SANDBOX_DEFAULT: '' })).toBe('warn');
  });
});

describe('resolveNetworkDefault', () => {
  test('only an explicit allow opts in', () => {
    expect(resolveNetworkDefault({ PI_SANDBOX_NETWORK_DEFAULT: 'allow' })).toBe('allow');
    expect(resolveNetworkDefault({ PI_SANDBOX_NETWORK_DEFAULT: 'ALLOW' })).toBe('allow');
    expect(resolveNetworkDefault({ PI_SANDBOX_NETWORK_DEFAULT: ' allow ' })).toBe('allow');
  });

  test('defaults to deny when missing or anything else', () => {
    expect(resolveNetworkDefault({})).toBe('deny');
    expect(resolveNetworkDefault({ PI_SANDBOX_NETWORK_DEFAULT: 'deny' })).toBe('deny');
    expect(resolveNetworkDefault({ PI_SANDBOX_NETWORK_DEFAULT: 'yes' })).toBe('deny');
  });
});
