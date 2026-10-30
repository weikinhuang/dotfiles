import { describe, expect, test } from 'vitest';

import { mergeSandboxConfigs } from '../../../../../lib/node/pi/sandbox/config-schema.ts';
import {
  applyNetworkSandboxOverride,
  buildNetworkControlStatus,
} from '../../../../../lib/node/pi/sandbox/session-controls.ts';

function config(): ReturnType<typeof mergeSandboxConfigs>['config'] {
  return mergeSandboxConfigs([
    {
      source: 'user',
      partial: {
        network: { allow: ['example.com'], deny: ['blocked.example.com'], unrestricted: true },
        flags: { allowLocalBinding: true },
      },
    },
  ]).config;
}

describe('applyNetworkSandboxOverride', () => {
  test('enable overrides configured/env unrestricted mode without losing rules', () => {
    const original = config();
    const result = applyNetworkSandboxOverride(original, 'enabled');
    expect(result.network.unrestricted).toBe(false);
    expect(result.network.allow).toEqual(['example.com']);
    expect(result.network.deny).toEqual(['blocked.example.com']);
    expect(result.flags).toBe(original.flags);
    expect(original.network.unrestricted).toBe(true);
  });

  test('disable changes network isolation only', () => {
    const original = applyNetworkSandboxOverride(config(), 'enabled');
    const result = applyNetworkSandboxOverride(original, 'disabled');
    expect(result.network.unrestricted).toBe(true);
    expect(original.network.unrestricted).toBe(false);
    expect(result.flags).toBe(original.flags);
    expect(result.credentials).toBe(original.credentials);
  });

  test('clearing an override restores configured mode', () => {
    const original = config();
    expect(applyNetworkSandboxOverride(original, undefined)).toBe(original);
    expect(applyNetworkSandboxOverride(original, undefined).network.unrestricted).toBe(true);
  });
});

describe('buildNetworkControlStatus', () => {
  const base = { mode: 'wrapped' as const, initialized: true, dryRun: false, unrestricted: false, activeWraps: 0 };
  test('distinguishes filtered and unrestricted networking without losing filesystem protection', () => {
    expect(buildNetworkControlStatus(base)).toContain('Network sandbox: ENABLED');
    const report = buildNetworkControlStatus({ ...base, unrestricted: true, override: 'disabled' });
    expect(report).toContain('Network sandbox: DISABLED');
    expect(report).toContain('ALL reachable destinations');
    expect(report).toContain('Filesystem sandbox: active');
    expect(report).toContain('Existing processes keep their network namespace');
  });

  test('full bypass takes precedence over a requested network enable', () => {
    const report = buildNetworkControlStatus({ ...base, mode: 'bypassed', override: 'enabled' });
    expect(report).toContain('NOT ENFORCED (bypassed');
    expect(report).toContain('Session override: enabled');
    expect(report).toContain('Filesystem sandbox: not enforced');
  });

  test('does not claim enforcement during pending initialization, degraded mode, or dry run', () => {
    expect(buildNetworkControlStatus({ ...base, initialized: false })).toContain('PENDING');
    expect(buildNetworkControlStatus({ ...base, mode: 'identity' })).toContain('NOT ENFORCED (identity');
    expect(buildNetworkControlStatus({ ...base, dryRun: true })).toContain('NOT ENFORCED (PI_SANDBOX_DRY_RUN=1)');
  });
});
