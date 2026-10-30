import { describe, expect, test } from 'vitest';

import { loadFilesystemPolicy } from '../../../../../lib/node/pi/filesystem-policy/load.ts';
import { emptyPolicy } from '../../../../../lib/node/pi/filesystem-policy/schema.ts';
import { loadSandboxConfig } from '../../../../../lib/node/pi/sandbox/config-load.ts';
import { emptySandboxConfig } from '../../../../../lib/node/pi/sandbox/config-schema.ts';
import { buildSandboxExplanation, type SandboxExplanationInput } from '../../../../../lib/node/pi/sandbox/explain.ts';

function input(kind: 'path' | 'host', value: string): SandboxExplanationInput {
  return {
    target: { kind, value },
    cwd: '/explain-workspace',
    filesystem: loadFilesystemPolicy([]).policy,
    sandbox: emptySandboxConfig(),
    mode: 'wrapped',
    platform: 'linux',
  };
}

function host(value: string, allow: string[] = [], deny: string[] = []): string {
  const args = input('host', value);
  args.sandbox.network.allow = allow;
  args.sandbox.network.deny = deny;
  return buildSandboxExplanation(args);
}

describe('sandbox host explanations', () => {
  test('wildcards match strict subdomains only, case insensitively', () => {
    expect(host('API.Example.COM', ['*.example.com'])).toContain('allowed by "*.example.com"');
    expect(host('a.b.example.com', ['*.EXAMPLE.com'])).toContain('allowed by "*.EXAMPLE.com"');
    expect(host('example.com', ['*.example.com'])).toContain('unmatched: interactive approval');
    expect(host('notexample.com', ['*.example.com'])).toContain('unmatched: interactive approval');
  });

  test('explicit deny wins over wildcard allow and session grants', () => {
    const args = input('host', 'https://api.example.com');
    args.sandbox.network.allow = ['*.example.com'];
    args.sandbox.network.deny = ['api.example.com:443'];
    args.sessionAllowedDomains = ['api.example.com'];
    const report = buildSandboxExplanation(args);
    expect(report).toContain('Host: api.example.com:443');
    expect(report).toContain('DENIED by explicit network.deny "api.example.com:443"');
    expect(report).toContain('deny wins over allows/session grants');
  });

  test('port-scoped patterns and omitted ports do not invent a default', () => {
    expect(host('api.example.com:8443', ['*.example.com:8443'])).toContain('allowed by "*.example.com:8443"');
    expect(host('api.example.com:443', ['*.example.com:8443'])).toContain('unmatched: interactive approval');
    const report = host('api.example.com', ['*.example.com:8443'], ['*:22']);
    expect(report).toContain('Host: api.example.com (port unspecified)');
    expect(report).toContain('Policy, port 22: DENIED');
    expect(report).toContain('Policy, port 8443: allowed');
    expect(report).toContain('Policy, other ports: unmatched');
  });

  test('scheme defaults and trailing dots are normalized', () => {
    expect(host('https://API.EXAMPLE.COM./path?q=secret', ['api.example.com:443'])).toContain(
      'Host: api.example.com:443',
    );
    expect(host('http://example.com', ['example.com:80'])).toContain('allowed by "example.com:80"');
    expect(host('wss://example.com/socket', ['example.com:443'])).toContain('allowed by "example.com:443"');
    expect(host('ws://example.com/socket', ['example.com:80'])).toContain('allowed by "example.com:80"');
  });

  test('IPv4 shorthand, compressed IPv6, bracketed ports and mapped addresses', () => {
    expect(host('127.1:8188', ['127.0.0.1:8188'])).toContain('allowed by "127.0.0.1:8188"');
    expect(host('[0:0:0:0:0:0:0:1]:8188', ['[::1]:8188'])).toContain('Host: [::1]:8188');
    expect(host('[::1]:8188', ['[0:0:0:0:0:0:0:1]:8188'])).toContain('allowed by');
    expect(host('[::1]:8189', ['[::1]:8188'])).toContain('unmatched: interactive approval');
    expect(host('[::1]', ['[::1]'])).toContain('Policy, all ports: allowed');
    expect(host('http://[::ffff:127.0.0.1]:8188', ['127.0.0.1:8188'])).toContain('Host: 127.0.0.1:8188');
    expect(host('[::1]:443', ['*.example.com'])).toContain('unmatched');
  });

  test('malformed pattern ports are not treated as unscoped host allows', () => {
    for (const pattern of ['example.com:0', 'example.com:0443', 'example.com:65536', 'example.com:443.attacker.com']) {
      expect(host('example.com:443', [pattern])).toContain('unmatched: interactive approval');
    }
  });

  test('localhost port scopes and deny precedence reuse loopback entries', () => {
    for (const value of ['localhost:8188', '127.0.0.1:8188', '[::1]:8188']) {
      const args = input('host', value);
      args.sandbox.network.allowLocalhost = true;
      args.sandbox.network.localhostPorts = [8188];
      expect(buildSandboxExplanation(args)).toContain('network.allowLocalhost');
      args.target.value = value.replace('8188', '8189');
      expect(buildSandboxExplanation(args)).toContain('unmatched: interactive approval');
      args.target.value = value;
      args.sandbox.network.deny = ['*:8188'];
      expect(buildSandboxExplanation(args)).toContain('DENIED by explicit');
    }
  });

  test('session grants are exact host grants, not wildcard config rules', () => {
    const args = input('host', 'api.example.com:8443');
    args.sessionAllowedDomains = ['api.example.com'];
    expect(buildSandboxExplanation(args)).toContain('allowed by session host grant');
    args.sessionAllowedDomains = ['*.example.com', 'api.example.com:8443'];
    expect(buildSandboxExplanation(args)).toContain('unmatched: interactive approval');
  });

  test('unmatched hosts mention configurable ask/default rather than permanent deny', () => {
    const report = host('example.com');
    expect(report).toContain('PI_SANDBOX_NETWORK_DEFAULT (allow/deny)');
    expect(report).not.toContain('DENIED by explicit');
    expect(report).toContain('DNS resolution, resolved-IP/SSRF guards');
    expect(report).toContain('WSL2 raw WebSocket loopback is not fixed by a hostname allow alone');
  });

  test('unrestricted, session overrides and full wrapper bypass are distinguished', () => {
    const args = input('host', 'example.com:443');
    args.sandbox.network.unrestricted = true;
    args.sandbox.network.deny = ['*'];
    expect(buildSandboxExplanation(args)).toContain('Network: unrestricted');
    expect(buildSandboxExplanation(args)).toContain('Configured policy only (inactive): DENIED');
    args.networkOverride = 'enabled';
    expect(buildSandboxExplanation(args)).toContain('Network: filtered (source: session network override');
    expect(buildSandboxExplanation(args)).toContain('Policy: DENIED');
    args.networkOverride = 'disabled';
    expect(buildSandboxExplanation(args)).toContain('source: session network override');
    for (const mode of ['bypassed', 'off', 'identity', 'env-disabled']) {
      args.mode = mode;
      args.networkOverride = 'enabled';
      expect(buildSandboxExplanation(args)).toContain('NOT ENFORCED by full sandbox wrapper');
    }
    args.mode = 'wrapped';
    args.platform = 'unsupported';
    expect(buildSandboxExplanation(args)).toContain('NOT ENFORCED by full sandbox wrapper');
  });

  test('network provenance names exact layers or admits incomplete evidence', () => {
    const args = input('host', 'example.com:443');
    args.sandboxLayers = [
      { source: 'user sandbox.json', raw: '{"network":{"allow":["example.com"]}}' },
      { source: 'project sandbox.json', raw: '{"network":{"deny":["example.com:443"]}}' },
    ];
    args.sandbox = loadSandboxConfig(args.sandboxLayers).config;
    expect(buildSandboxExplanation(args)).toContain('source: project sandbox.json');
    args.target.value = 'example.com:80';
    expect(buildSandboxExplanation(args)).toContain('source: user sandbox.json');
    args.sandbox.network.allow.push('env.example.com');
    expect(buildSandboxExplanation(args)).toContain('source not exact; contributing config sources: user sandbox.json');
    args.target.value = 'env.example.com:80';
    expect(buildSandboxExplanation(args)).toContain('source unavailable in supplied layers');
  });

  test('scalar network provenance follows last-wins validated layers', () => {
    const args = input('host', 'localhost:8188');
    args.sandboxLayers = [
      { source: 'user', raw: '{"network":{"unrestricted":true,"allowLocalhost":[3000]}}' },
      { source: 'project', raw: '{"network":{"unrestricted":false,"allowLocalhost":[8188]}}' },
    ];
    args.sandbox = loadSandboxConfig(args.sandboxLayers).config;
    expect(buildSandboxExplanation(args)).toContain('network.allowLocalhost (source: project)');
    args.sandboxLayers.push({ source: 'env overlay', raw: '{"network":{"unrestricted":true}}' });
    args.sandbox = loadSandboxConfig(args.sandboxLayers).config;
    expect(buildSandboxExplanation(args)).toContain('network.unrestricted; source: env overlay');
  });

  test('host reports are deterministic and do not mutate inputs', () => {
    const args = input('host', 'example.com');
    args.sandboxLayers = [{ source: 'bad config', raw: 'not JSON' }];
    const before = JSON.stringify(args);
    expect(buildSandboxExplanation(args)).toBe(buildSandboxExplanation(args));
    expect(JSON.stringify(args)).toBe(before);
  });

  test('URLs never echo userinfo, path, query, or invalid credential-bearing input', () => {
    const report = host('https://user:topsecret@example.com/private?token=hidden', ['example.com']);
    expect(report).toContain('Host: example.com:443');
    for (const secret of ['user', 'topsecret', '/private', 'hidden']) expect(report).not.toContain(secret);
    const invalid = host('https://user:topsecret@');
    expect(invalid).toContain('Invalid host target');
    expect(invalid).not.toContain('topsecret');
  });

  test.each([
    '',
    ' ',
    'bad host',
    'example.com:0',
    'example.com:65536',
    'example.com:0443',
    '::1',
    '[::1]:0',
    '[::1]:65536',
    '[::1]junk',
    '[example.com]',
    '[fe80::1%eth0]',
    'example.com/path',
    'evil.com\n.example.com',
    'user:secret@example.com',
    '*.example.com',
    'https://',
    'https://a.com:99999',
  ])('rejects invalid input %j', (value) => {
    expect(host(value)).toContain('Invalid host target');
  });
});

describe('sandbox filesystem explanations', () => {
  test('resolves paths and shows default deny provenance', () => {
    const args = input('path', 'dir/../.env');
    args.fsLayers = [];
    const report = buildSandboxExplanation(args);
    expect(report).toContain('Path: /explain-workspace/.env');
    expect(report).toContain('Read: approval required - Basename (.env)');
    expect(report).toContain('Write: approval required - Basename (.env)');
    expect(report).toContain('read.deny.basenames: Basename (.env) (source: defaults)');
    expect(report).toContain('Write outer root: write.allow.paths: Path prefix (.) (source: defaults)');
  });

  test('read allow-back and write carve-back retain exact user/project sources', () => {
    const args = input('path', 'private/public.txt');
    args.fsLayers = [
      { source: 'user filesystem.json', raw: '{"read":{"deny":{"segments":["private"]}}}' },
      {
        source: 'project filesystem.json',
        raw: '{"read":{"allow":{"basenames":["public.txt"]}},"write":{"allow":{"basenames":["public.txt"]}}}',
      },
    ];
    args.filesystem = loadFilesystemPolicy(args.fsLayers).policy;
    const report = buildSandboxExplanation(args);
    expect(report).toContain('Read: allowed by policy');
    expect(report).toContain('(overrides read deny)');
    expect(report).toContain('source: user filesystem.json');
    expect(report).toContain('source: project filesystem.json');
    expect(report).toContain('Write: allowed by policy/session/persona');
    expect(report).toContain('Write allow-back (basenames/segments only): write.allow.basenames');
  });

  test('outer roots do not carve back sensitive denies; basenames cannot widen roots', () => {
    const args = input('path', '/elsewhere/safe.txt');
    args.filesystem = emptyPolicy();
    args.filesystem.write.allow.basenames = ['safe.txt'];
    const report = buildSandboxExplanation(args);
    expect(report).toContain('Write: approval required - Outside allowed write roots');
    expect(report).toContain('outside configured write roots');
    args.target.value = '.env';
    args.filesystem = loadFilesystemPolicy([]).policy;
    expect(buildSandboxExplanation(args)).toContain('Write: approval required - Basename (.env)');
  });

  test('persona and session positive vouches bypass ordinary restrictions only for writes', () => {
    const args = input('path', '/elsewhere/.env');
    args.persona = { name: 'editor', resolvedWriteRoots: ['/elsewhere'] };
    let report = buildSandboxExplanation(args);
    expect(report).toContain('Read: approval required');
    expect(report).toContain('Write: allowed');
    expect(report).toContain('Persona editor write root: /elsewhere (positive vouch)');
    expect(report).toContain('Base write policy before positive vouch: Outside allowed write roots');
    args.persona = undefined;
    args.sessionWriteAllowPaths = ['/elsewhere'];
    report = buildSandboxExplanation(args);
    expect(report).toContain('Session write grant: /elsewhere (positive vouch)');
    args.target.value = '/elsewhere-sibling/.env';
    expect(buildSandboxExplanation(args)).toContain('Write: approval required');
  });

  test.each(['.pi/filesystem.json', '.pi/sandbox.json', '.pi/bash-permissions.json', '.pi'])(
    'mandatory security protection survives all grants for %s',
    (value) => {
      const args = input('path', value);
      args.sessionWriteAllowPaths = [args.cwd];
      args.persona = { name: 'trusted', resolvedWriteRoots: [args.cwd] };
      args.filesystem.write.allow.basenames = ['*'];
      args.filesystem.write.allow.segments = ['.pi'];
      const report = buildSandboxExplanation(args);
      expect(report).toContain('Write: BLOCKED - mandatory Security policy');
      expect(report).toContain('cannot override mandatory protection');
    },
  );

  test('incomplete filesystem replay does not invent an exact source', () => {
    const args = input('path', '.env');
    args.fsLayers = [{ source: 'broken user file', raw: '{invalid' }];
    args.filesystem.read.deny.paths.push('/not-in-layers');
    expect(buildSandboxExplanation(args)).toContain('source not exact; matching supplied contributions: defaults');
    args.target.value = '/not-in-layers/file';
    expect(buildSandboxExplanation(args)).toContain('source unavailable in supplied layers');
  });

  test('bypassing the kernel does not claim that filesystem tool gates disappeared', () => {
    const args = input('path', '.env');
    args.mode = 'bypassed';
    const report = buildSandboxExplanation(args);
    expect(report).toContain('Read: approval required');
    expect(report).toContain('filesystem tool gates are separate from kernel enforcement');
  });

  test('rejects empty or NUL paths and leaves caller-owned inputs untouched', () => {
    for (const value of ['', ' ', 'bad\0path'])
      expect(buildSandboxExplanation(input('path', value))).toContain('Invalid path target');
    const args = input('path', 'file.txt');
    args.fsLayers = [];
    const before = JSON.stringify(args);
    expect(buildSandboxExplanation(args)).toBe(buildSandboxExplanation(args));
    expect(JSON.stringify(args)).toBe(before);
  });
});
