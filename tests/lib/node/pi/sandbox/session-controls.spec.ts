import { describe, expect, test } from 'vitest';

import { mergeSandboxConfigs } from '../../../../../lib/node/pi/sandbox/config-schema.ts';
import {
  applyNetworkSandboxOverride,
  applySocketSandboxOverride,
  buildNetworkControlStatus,
  buildSocketControlStatus,
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

describe('applySocketSandboxOverride', () => {
  test('disable changes only Unix-socket restrictions without mutating config', () => {
    const original = config();
    const result = applySocketSandboxOverride(original, 'disabled');
    expect(result.unixSockets.allowAll).toBe(true);
    expect(original.unixSockets.allowAll).toBe(false);
    expect(result.unixSockets.allow).toBe(original.unixSockets.allow);
    expect(result.network).toBe(original.network);
    expect(result.flags).toBe(original.flags);
    expect(result.credentials).toBe(original.credentials);
  });

  test('enable overrides configured allowAll while retaining path allowances', () => {
    const original = config();
    original.unixSockets = { allowAll: true, allow: ['/var/run/docker.sock'] };
    const result = applySocketSandboxOverride(original, 'enabled');
    expect(result.unixSockets).toEqual({ allowAll: false, allow: ['/var/run/docker.sock'] });
    expect(original.unixSockets.allowAll).toBe(true);
    expect(result.network).toBe(original.network);
  });

  test('clearing an override restores configured socket policy', () => {
    const original = config();
    original.unixSockets.allowAll = true;
    expect(applySocketSandboxOverride(original, undefined)).toBe(original);
  });
});

describe('buildSocketControlStatus', () => {
  const base = {
    mode: 'wrapped' as const,
    initialized: true,
    dryRun: false,
    platform: 'darwin' as const,
    allowAll: false,
    allow: ['/tmp/tmux.sock'],
    networkUnrestricted: false,
    activeWraps: 0,
  };

  test('shows restrictions and configured macOS allowances', () => {
    const report = buildSocketControlStatus(base);
    expect(report).toContain('Unix-socket sandbox: ENABLED');
    expect(report).toContain('Configured socket paths: /tmp/tmux.sock');
    expect(report).toContain('Socket session override: (none; configured policy)');
    expect(report).not.toContain('Linux:');
  });

  test('socket bypass reports privileged IPC and existing-process risks', () => {
    const report = buildSocketControlStatus({ ...base, allowAll: true, override: 'disabled', activeWraps: 2 });
    expect(report).toContain('Unix-socket sandbox: DISABLED');
    expect(report).toContain('ALL Unix sockets permitted');
    expect(report).toContain('Socket session override: disabled');
    expect(report).toContain('policies: unchanged (network filtered)');
    expect(report).toContain('Active wrapped commands: 2');
    expect(report).toContain('Docker can indirectly bypass');
    expect(report).toContain('Existing processes and open sockets keep their original access');
  });

  test('Linux describes ignored paths and helper-backed hardening tradeoffs', () => {
    const report = buildSocketControlStatus({ ...base, platform: 'linux', allowAll: true });
    expect(report).toContain('/tmp/tmux.sock (ignored on Linux)');
    expect(report).toContain('all-or-nothing');
    expect(report).toContain('filesystem violation monitoring');
    expect(report).toContain('write denies may be bypassable');
    const restricted = buildSocketControlStatus({ ...base, platform: 'linux', networkUnrestricted: true });
    expect(restricted).toContain('Unix-socket sandbox: ENABLED');
    expect(restricted).toContain('restriction requires the runtime seccomp helper');
    expect(restricted).not.toContain('Allowing sockets skips');
  });

  test('macOS unrestricted networking takes precedence over socket enable', () => {
    const report = buildSocketControlStatus({ ...base, networkUnrestricted: true, override: 'enabled' });
    expect(report).toContain('NOT ENFORCED (macOS unrestricted networking');
    expect(report).toContain('/sandbox-network enable');
    expect(report).toContain('Socket session override: enabled');
  });

  test('does not claim enforcement during bypass, initialization, degraded mode, or dry run', () => {
    expect(buildSocketControlStatus({ ...base, mode: 'bypassed' })).toContain('NOT ENFORCED (bypassed');
    expect(buildSocketControlStatus({ ...base, initialized: false })).toContain('PENDING');
    expect(buildSocketControlStatus({ ...base, mode: 'identity' })).toContain('NOT ENFORCED (identity');
    expect(buildSocketControlStatus({ ...base, dryRun: true })).toContain('NOT ENFORCED (PI_SANDBOX_DRY_RUN=1)');
  });
});
