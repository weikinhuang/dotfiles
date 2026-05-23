/**
 * Tests for lib/node/pi/sandbox/plan.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type SandboxPlatformInfo } from '../../../../../lib/node/pi/sandbox/platform.ts';
import { type PlanInputs, resolveSandboxMode, resolveWrapPlan } from '../../../../../lib/node/pi/sandbox/plan.ts';

const baseLinux: SandboxPlatformInfo = {
  kind: 'linux',
  description: 'linux x64',
  isInsideDocker: false,
  isRoot: false,
  apparmorBlocksUserNs: false,
  missingDeps: [],
  hints: [],
  wslVersion: 0,
};

function inputs(over: Partial<PlanInputs> = {}): PlanInputs {
  return {
    platform: baseLinux,
    bypassed: false,
    initialized: true,
    ...over,
  };
}

const ENV_KEYS = ['PI_SANDBOX_DISABLED', 'PI_SANDBOX_ALLOW_ROOT'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveWrapPlan', () => {
  test('returns wrapped on a healthy linux platform', () => {
    expect(resolveWrapPlan(inputs())).toEqual({ kind: 'wrapped' });
  });

  test('PI_SANDBOX_DISABLED truthy short-circuits to identity', () => {
    process.env.PI_SANDBOX_DISABLED = '1';

    expect(resolveWrapPlan(inputs())).toEqual({ kind: 'identity', reason: 'PI_SANDBOX_DISABLED=1' });
  });

  test('session bypass returns identity with /sandbox-disable reason', () => {
    expect(resolveWrapPlan(inputs({ bypassed: true }))).toEqual({ kind: 'identity', reason: '/sandbox-disable' });
  });

  test('unsupported platform falls through to identity with description', () => {
    const platform: SandboxPlatformInfo = {
      kind: 'unsupported',
      description: 'win32',
      isInsideDocker: false,
      isRoot: false,
      apparmorBlocksUserNs: false,
      missingDeps: [],
      hints: [],
      wslVersion: 0,
    };

    expect(resolveWrapPlan(inputs({ platform }))).toEqual({ kind: 'identity', reason: 'win32' });
  });

  test('missing deps falls through with the dep list joined', () => {
    const platform: SandboxPlatformInfo = { ...baseLinux, missingDeps: ['bwrap', 'rg'] };

    expect(resolveWrapPlan(inputs({ platform }))).toEqual({
      kind: 'identity',
      reason: 'missing deps: bwrap, rg',
    });
  });

  test('root without override returns identity', () => {
    const platform: SandboxPlatformInfo = { ...baseLinux, isRoot: true };

    expect(resolveWrapPlan(inputs({ platform }))).toEqual({ kind: 'identity', reason: 'running as root' });
  });

  test('root WITH PI_SANDBOX_ALLOW_ROOT=1 returns wrapped', () => {
    process.env.PI_SANDBOX_ALLOW_ROOT = '1';
    const platform: SandboxPlatformInfo = { ...baseLinux, isRoot: true };

    expect(resolveWrapPlan(inputs({ platform }))).toEqual({ kind: 'wrapped' });
  });
});

describe('resolveSandboxMode', () => {
  test('healthy + initialized = wrapped without reason', () => {
    expect(resolveSandboxMode(inputs())).toEqual({ mode: 'wrapped' });
  });

  test('healthy + uninitialized = wrapped with pending reason', () => {
    expect(resolveSandboxMode(inputs({ initialized: false }))).toEqual({
      mode: 'wrapped',
      reason: 'pending first bash',
    });
  });

  test('PI_SANDBOX_DISABLED -> env-disabled mode', () => {
    process.env.PI_SANDBOX_DISABLED = '1';

    expect(resolveSandboxMode(inputs())).toEqual({ mode: 'env-disabled', reason: 'PI_SANDBOX_DISABLED=1' });
  });

  test('session bypass -> bypassed with custom reason', () => {
    expect(resolveSandboxMode(inputs({ bypassed: true, reason: 'user clicked X' }))).toEqual({
      mode: 'bypassed',
      reason: 'user clicked X',
    });
  });

  test('session bypass without reason -> bypassed with /sandbox-disable default', () => {
    expect(resolveSandboxMode(inputs({ bypassed: true }))).toEqual({
      mode: 'bypassed',
      reason: '/sandbox-disable',
    });
  });

  test('unsupported -> identity with description', () => {
    const platform: SandboxPlatformInfo = {
      kind: 'unsupported',
      description: 'aix',
      isInsideDocker: false,
      isRoot: false,
      apparmorBlocksUserNs: false,
      missingDeps: [],
      hints: [],
      wslVersion: 0,
    };

    expect(resolveSandboxMode(inputs({ platform }))).toEqual({ mode: 'identity', reason: 'aix' });
  });

  test('root without override -> identity with the override hint', () => {
    const platform: SandboxPlatformInfo = { ...baseLinux, isRoot: true };

    expect(resolveSandboxMode(inputs({ platform }))).toEqual({
      mode: 'identity',
      reason: 'running as root (set PI_SANDBOX_ALLOW_ROOT=1 to override)',
    });
  });
});
