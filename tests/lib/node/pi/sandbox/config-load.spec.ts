/**
 * Tests for lib/node/pi/sandbox/config-load.ts.
 */

import { describe, expect, test } from 'vitest';

import { loadSandboxConfig } from '../../../../../lib/node/pi/sandbox/config-load.ts';

describe('loadSandboxConfig', () => {
  test('no layers + no env yields shipped defaults', () => {
    const { config, warnings } = loadSandboxConfig([]);
    expect(warnings).toEqual([]);
    expect(config.network.allow).toEqual([]);
    expect(config.flags.weakerNestedSandbox).toBe(false);
    expect(config.flags.linuxRuleDepth).toBe(3);
  });

  test('JSONC layer with comments parses', () => {
    const raw = `{
      // user-scope sandbox config
      "network": {
        "allow": ["github.com"], // git ops
        "deny": []
      },
      "flags": {
        "weakerNestedSandbox": true
      }
    }`;
    const { config, warnings } = loadSandboxConfig([{ source: 'user', raw }]);
    expect(warnings).toEqual([]);
    expect(config.network.allow).toEqual(['github.com']);
    expect(config.flags.weakerNestedSandbox).toBe(true);
  });

  test('layer ordering: project adds on top of user', () => {
    const { config } = loadSandboxConfig([
      { source: 'user', raw: '{"network":{"allow":["a.com"]}}' },
      { source: 'project', raw: '{"network":{"allow":["b.com"]}}' },
    ]);
    expect(config.network.allow).toEqual(['a.com', 'b.com']);
  });

  test('env overlay: PI_SANDBOX_NESTED=1 enables weakerNestedSandbox', () => {
    const { config } = loadSandboxConfig([], { PI_SANDBOX_NESTED: '1' });
    expect(config.flags.weakerNestedSandbox).toBe(true);
    expect(config.flags.weakerNetworkIsolation).toBe(false);
  });

  test('env overlay: PI_SANDBOX_WEAKER_NET=true enables weakerNetworkIsolation', () => {
    const { config } = loadSandboxConfig([], { PI_SANDBOX_WEAKER_NET: 'true' });
    expect(config.flags.weakerNetworkIsolation).toBe(true);
  });

  test('env overlay: PI_SANDBOX_EXTRA_ALLOW_DOMAIN appends comma-split entries', () => {
    const { config } = loadSandboxConfig([], {
      PI_SANDBOX_EXTRA_ALLOW_DOMAIN: 'a.com, b.com,  c.com',
    });
    expect(config.network.allow).toEqual(['a.com', 'b.com', 'c.com']);
  });

  test('env overlay layers AFTER project (so it can add to allowlist)', () => {
    const { config } = loadSandboxConfig([{ source: 'project', raw: '{"network":{"allow":["github.com"]}}' }], {
      PI_SANDBOX_EXTRA_ALLOW_DOMAIN: 'localhost',
    });
    expect(config.network.allow).toEqual(['github.com', 'localhost']);
  });

  test('env overlay: PI_SANDBOX_NETWORK_UNRESTRICTED=1 sets network.unrestricted', () => {
    const { config } = loadSandboxConfig([], { PI_SANDBOX_NETWORK_UNRESTRICTED: '1' });
    expect(config.network.unrestricted).toBe(true);
  });

  test('env overlay: PI_SANDBOX_NETWORK_UNRESTRICTED coexists with EXTRA_ALLOW_DOMAIN', () => {
    const { config } = loadSandboxConfig([], {
      PI_SANDBOX_EXTRA_ALLOW_DOMAIN: 'a.com',
      PI_SANDBOX_NETWORK_UNRESTRICTED: '1',
    });
    expect(config.network.allow).toEqual(['a.com']);
    expect(config.network.unrestricted).toBe(true);
  });

  test('env overlay: falsy PI_SANDBOX_NETWORK_UNRESTRICTED leaves it off', () => {
    expect(loadSandboxConfig([], { PI_SANDBOX_NETWORK_UNRESTRICTED: '0' }).config.network.unrestricted).toBe(false);
    expect(loadSandboxConfig([], {}).config.network.unrestricted).toBe(false);
  });

  test('env overlay: PI_SANDBOX_ALLOW_LOCALHOST=1 sets network.allowLocalhost', () => {
    expect(loadSandboxConfig([], { PI_SANDBOX_ALLOW_LOCALHOST: '1' }).config.network.allowLocalhost).toBe(true);
    expect(loadSandboxConfig([], {}).config.network.allowLocalhost).toBe(false);
  });

  test('truthiness of env vars: only specific values count', () => {
    expect(loadSandboxConfig([], { PI_SANDBOX_NESTED: '0' }).config.flags.weakerNestedSandbox).toBe(false);
    expect(loadSandboxConfig([], { PI_SANDBOX_NESTED: 'no' }).config.flags.weakerNestedSandbox).toBe(false);
    expect(loadSandboxConfig([], { PI_SANDBOX_NESTED: '' }).config.flags.weakerNestedSandbox).toBe(false);
    expect(loadSandboxConfig([], { PI_SANDBOX_NESTED: 'yes' }).config.flags.weakerNestedSandbox).toBe(true);
  });

  test('malformed JSONC produces a warning, layer skipped', () => {
    const { config, warnings } = loadSandboxConfig([
      { source: 'user', raw: '{ not json' },
      { source: 'project', raw: '{"network":{"allow":["good.com"]}}' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].source).toBe('user');
    expect(config.network.allow).toEqual(['good.com']);
  });

  test('non-object top-level produces a warning', () => {
    const { warnings } = loadSandboxConfig([{ source: 'user', raw: '"oops"' }]);
    expect(warnings.find((w) => w.reason.includes('object at top level'))).toBeDefined();
  });

  test('non-object `network` value is dropped with a warning', () => {
    const { warnings } = loadSandboxConfig([{ source: 'user', raw: '{"network": "oops"}' }]);
    expect(warnings.find((w) => w.reason.includes('`network` must be an object'))).toBeDefined();
  });

  test('blank layer is skipped silently', () => {
    const { warnings } = loadSandboxConfig([{ source: 'user', raw: '\n   \n' }]);
    expect(warnings).toEqual([]);
  });

  test('gitExcludeStubs defaults to true and honors a false override', () => {
    const def = loadSandboxConfig([]);
    expect(def.config.gitExcludeStubs).toBe(true);

    const off = loadSandboxConfig([{ source: 'user', raw: '{"gitExcludeStubs": false}' }]);
    expect(off.config.gitExcludeStubs).toBe(false);
    expect(off.warnings).toEqual([]);
  });

  test('non-boolean gitExcludeStubs is warned and keeps the default', () => {
    const { config, warnings } = loadSandboxConfig([{ source: 'user', raw: '{"gitExcludeStubs": "yes"}' }]);
    expect(config.gitExcludeStubs).toBe(true);
    expect(warnings.find((w) => w.reason.includes('gitExcludeStubs'))).toBeDefined();
  });
});
