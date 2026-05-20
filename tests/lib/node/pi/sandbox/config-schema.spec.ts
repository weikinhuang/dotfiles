/**
 * Tests for lib/node/pi/sandbox/config-schema.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_SANDBOX_CONFIG,
  LINUX_RULE_DEPTH_DEFAULT,
  LINUX_RULE_DEPTH_MAX,
  LINUX_RULE_DEPTH_MIN,
  clampLinuxRuleDepth,
  emptySandboxConfig,
  mergeSandboxConfigs,
} from '../../../../../lib/node/pi/sandbox/config-schema.ts';

describe('clampLinuxRuleDepth', () => {
  test('within bounds passes through', () => {
    expect(clampLinuxRuleDepth(3)).toBe(3);
    expect(clampLinuxRuleDepth(LINUX_RULE_DEPTH_MIN)).toBe(LINUX_RULE_DEPTH_MIN);
    expect(clampLinuxRuleDepth(LINUX_RULE_DEPTH_MAX)).toBe(LINUX_RULE_DEPTH_MAX);
  });

  test('out-of-range values clamp', () => {
    expect(clampLinuxRuleDepth(0)).toBe(LINUX_RULE_DEPTH_MIN);
    expect(clampLinuxRuleDepth(-5)).toBe(LINUX_RULE_DEPTH_MIN);
    expect(clampLinuxRuleDepth(99)).toBe(LINUX_RULE_DEPTH_MAX);
  });

  test('non-finite or fractional values are normalized', () => {
    expect(clampLinuxRuleDepth(Number.NaN)).toBe(LINUX_RULE_DEPTH_DEFAULT);
    expect(clampLinuxRuleDepth(Number.POSITIVE_INFINITY)).toBe(LINUX_RULE_DEPTH_DEFAULT);
    expect(clampLinuxRuleDepth(2.7)).toBe(2);
  });
});

describe('emptySandboxConfig', () => {
  test('every field is the right empty shape', () => {
    const c = emptySandboxConfig();
    expect(c.network.allow).toEqual([]);
    expect(c.network.deny).toEqual([]);
    expect(c.unixSockets.allow).toEqual([]);
    expect(c.unixSockets.allowAll).toBe(false);
    expect(c.flags.weakerNestedSandbox).toBe(false);
    expect(c.flags.weakerNetworkIsolation).toBe(false);
    expect(c.flags.allowLocalBinding).toBe(false);
    expect(c.flags.linuxRuleDepth).toBe(LINUX_RULE_DEPTH_DEFAULT);
  });

  test('returned objects are mutable copies', () => {
    const a = emptySandboxConfig();
    const b = emptySandboxConfig();
    a.network.allow.push('github.com');
    expect(b.network.allow).toEqual([]);
  });
});

describe('DEFAULT_SANDBOX_CONFIG', () => {
  test('matches plan section 6 baseline', () => {
    expect(DEFAULT_SANDBOX_CONFIG.network.allow).toEqual([]);
    expect(DEFAULT_SANDBOX_CONFIG.unixSockets.allowAll).toBe(false);
    expect(DEFAULT_SANDBOX_CONFIG.flags.linuxRuleDepth).toBe(LINUX_RULE_DEPTH_DEFAULT);
  });

  test('top-level shape is frozen', () => {
    expect(Object.isFrozen(DEFAULT_SANDBOX_CONFIG)).toBe(true);
  });
});

describe('mergeSandboxConfigs', () => {
  test('starts from defaults when given no layers', () => {
    const { config, warnings } = mergeSandboxConfigs([]);
    expect(warnings).toEqual([]);
    expect(config.network.allow).toEqual([]);
    expect(config.flags.linuxRuleDepth).toBe(LINUX_RULE_DEPTH_DEFAULT);
  });

  test('layers accumulate per-array fields', () => {
    const { config } = mergeSandboxConfigs([
      { source: 'user', partial: { network: { allow: ['github.com'] } } },
      { source: 'project', partial: { network: { allow: ['api.github.com'] } } },
    ]);
    expect(config.network.allow).toEqual(['github.com', 'api.github.com']);
  });

  test('booleans are last-wins', () => {
    const { config } = mergeSandboxConfigs([
      { source: 'user', partial: { flags: { weakerNestedSandbox: false } } },
      { source: 'project', partial: { flags: { weakerNestedSandbox: true } } },
    ]);
    expect(config.flags.weakerNestedSandbox).toBe(true);
  });

  test('linuxRuleDepth is clamped after merge', () => {
    const { config } = mergeSandboxConfigs([{ source: 'user', partial: { flags: { linuxRuleDepth: 99 } } }]);
    expect(config.flags.linuxRuleDepth).toBe(LINUX_RULE_DEPTH_MAX);
  });

  test('non-array `network.allow` produces a warning and is dropped', () => {
    const { config, warnings } = mergeSandboxConfigs([{ source: 'user', partial: { network: { allow: 'oops' } } }]);
    expect(warnings.find((w) => w.reason.includes('network.allow'))).toBeDefined();
    expect(config.network.allow).toEqual([]);
  });

  test('non-string array items produce per-index warnings', () => {
    const { config, warnings } = mergeSandboxConfigs([
      { source: 'user', partial: { network: { allow: ['ok.com', 42, 'also.com'] } } },
    ]);
    expect(warnings.find((w) => w.reason.includes('network.allow[1]'))).toBeDefined();
    expect(config.network.allow).toEqual(['ok.com', 'also.com']);
  });

  test('non-boolean flags warning keeps previous value', () => {
    const { config, warnings } = mergeSandboxConfigs([
      { source: 'user', partial: { flags: { weakerNestedSandbox: 'yes' } } },
    ]);
    expect(warnings.find((w) => w.reason.includes('weakerNestedSandbox'))).toBeDefined();
    expect(config.flags.weakerNestedSandbox).toBe(false);
  });

  test('non-numeric linuxRuleDepth warning keeps default', () => {
    const { config, warnings } = mergeSandboxConfigs([
      { source: 'user', partial: { flags: { linuxRuleDepth: 'three' } } },
    ]);
    expect(warnings.find((w) => w.reason.includes('linuxRuleDepth'))).toBeDefined();
    expect(config.flags.linuxRuleDepth).toBe(LINUX_RULE_DEPTH_DEFAULT);
  });
});
