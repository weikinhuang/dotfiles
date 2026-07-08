/**
 * Golden-output specs for `buildSandboxStatusReport` - the pure
 * builder behind the `/sandbox` status command. Each expected body is
 * spelled out line-by-line (joined with `\n`) so any drift in the
 * layout, spacing, or conditional sections is caught exactly.
 */

import { describe, expect, test } from 'vitest';

import {
  buildSandboxStatusReport,
  type SandboxStatusReportInput,
} from '../../../../../lib/node/pi/sandbox/status-report.ts';

const BASE_SOURCES = {
  userFs: '/u/fs',
  userSandbox: '/u/sb',
  projectFs: '/p/fs',
  projectSandbox: '/p/sb',
} as const;

describe('buildSandboxStatusReport', () => {
  test('minimal darwin snapshot (no deps, no compiled, empty network)', () => {
    const input: SandboxStatusReportInput = {
      mode: 'active',
      platform: {
        description: 'macOS (sandbox-exec)',
        kind: 'darwin',
        missingDeps: [],
        hints: [],
        apparmorBlocksUserNs: false,
        isInsideDocker: false,
      },
      wrapsAttempted: 0,
      wrapsErrored: 0,
      sources: BASE_SOURCES,
      network: { allow: [], deny: [] },
      networkDefault: 'deny',
      filesystem: { writeAllowPaths: ['/repo'], readDenyPaths: ['~/.ssh'] },
      lossyNotes: [],
      recentViolations: [],
    };

    const expected = [
      'Mode: active',
      'Platform: macOS (sandbox-exec) (darwin)',
      '',
      'Wraps attempted: 0',
      'Wraps errored:   0',
      '',
      'Configuration sources:',
      '  user fs:      /u/fs',
      '  user sandbox: /u/sb',
      '  project fs:   /p/fs',
      '  project sandbox: /p/sb',
      '',
      'Network:',
      '  allow: (empty - deny all)',
      '  deny:  (empty)',
      '  default-on-no-UI: deny',
      '',
      'Filesystem (write.allow.paths):',
      '  /repo',
      'Filesystem (read.deny.paths):',
      '  ~/.ssh',
    ].join('\n');

    expect(buildSandboxStatusReport(input)).toBe(expected);
  });

  test('full linux snapshot (deps, persona, proxy, compiled+inert, lossy, violations)', () => {
    const input: SandboxStatusReportInput = {
      mode: 'degraded',
      reason: 'init failed: boom',
      platform: {
        description: 'Linux (bubblewrap)',
        kind: 'linux',
        missingDeps: ['bubblewrap'],
        hints: ['apt install bubblewrap'],
        apparmorBlocksUserNs: true,
        isInsideDocker: true,
      },
      wrapsAttempted: 5,
      wrapsErrored: 2,
      lastWrapError: 'E2BIG',
      proxyPorts: { http: 8080, socks: 1080 },
      sources: BASE_SOURCES,
      persona: { name: 'writer', resolvedWriteRoots: ['/a', '/b'] },
      network: { allow: ['github.com', 'npmjs.org'], deny: ['evil.com'], allowLocalhost: true },
      networkDefault: 'allow',
      filesystem: { writeAllowPaths: ['/repo'], readDenyPaths: ['~/.ssh', '~/.aws'] },
      compiled: {
        read: { paths: ['/x', '/y'], inertBasenames: ['id_rsa'], inertSegments: [], inertPaths: [] },
        write: { paths: [], inertBasenames: [], inertSegments: ['node_modules'], inertPaths: [] },
      },
      lossyNotes: ['dropped foo'],
      recentViolations: [
        { ts: '2026-01-01T00:00:00.000Z', kind: 'fs', action: 'deny', command: 'cat', cwd: '/repo', path: '/x' },
        {
          ts: '2026-01-02T00:00:00.000Z',
          kind: 'net',
          action: 'deny',
          command: 'curl',
          cwd: '/repo',
          host: 'evil.com:443',
        },
      ],
    };

    const expected = [
      'Mode: degraded (init failed: boom)',
      'Platform: Linux (bubblewrap) (linux)',
      'Missing deps: bubblewrap',
      '  apt install bubblewrap',
      'AppArmor restricts unprivileged user namespaces (Ubuntu 24.04+).',
      'Running inside a container; consider PI_SANDBOX_NESTED=1.',
      '',
      'Wraps attempted: 5',
      'Wraps errored:   2 (last: E2BIG)',
      'Proxy ports: http=8080 socks=1080',
      '',
      'Configuration sources:',
      '  user fs:      /u/fs',
      '  user sandbox: /u/sb',
      '  project fs:   /p/fs',
      '  project sandbox: /p/sb',
      '  persona overlay: writer (writeRoots: /a, /b)',
      '',
      'Network:',
      '  allowLocalhost: true (loopback routed through the proxy; HTTP/SOCKS only, filtering stays on)',
      '  allow: github.com, npmjs.org',
      '  deny:  evil.com',
      '  default-on-no-UI: allow',
      '',
      'Filesystem (write.allow.paths):',
      '  /repo',
      'Filesystem (read.deny.paths):',
      '  ~/.ssh',
      '  ~/.aws',
      '',
      'Compiled Linux deny paths:',
      '  read:  2 paths',
      '  write: 0 paths',
      '  inert (no on-disk match):',
      '    read.deny.basenames id_rsa',
      '    write.deny.segments  node_modules',
      '',
      'Lossy translation notes:',
      '  dropped foo',
      '',
      'Recent violations (10 most recent; /sandbox-violations for full):',
      '  2026-01-01T00:00:00.000Z fs deny /x',
      '  2026-01-02T00:00:00.000Z net deny evil.com:443',
    ].join('\n');

    expect(buildSandboxStatusReport(input)).toBe(expected);
  });

  test('unrestricted network wins over allowLocalhost line', () => {
    const input: SandboxStatusReportInput = {
      mode: 'active',
      platform: {
        description: 'Linux (bubblewrap)',
        kind: 'linux',
        missingDeps: [],
        hints: [],
        apparmorBlocksUserNs: false,
        isInsideDocker: false,
      },
      wrapsAttempted: 1,
      wrapsErrored: 0,
      sources: BASE_SOURCES,
      network: { allow: ['x.com'], deny: [], unrestricted: true, allowLocalhost: true },
      networkDefault: 'deny',
      filesystem: { writeAllowPaths: [], readDenyPaths: [] },
      lossyNotes: [],
      recentViolations: [],
    };

    const report = buildSandboxStatusReport(input);
    expect(report).toContain(
      '  unrestricted: true (network isolation OFF - host network shared, allow/deny NOT enforced)',
    );
    expect(report).not.toContain('allowLocalhost: true');
  });

  test('proxyPorts present with falsy http emits no proxy line; socks omitted when absent', () => {
    const base: SandboxStatusReportInput = {
      mode: 'active',
      platform: {
        description: 'macOS (sandbox-exec)',
        kind: 'darwin',
        missingDeps: [],
        hints: [],
        apparmorBlocksUserNs: false,
        isInsideDocker: false,
      },
      wrapsAttempted: 0,
      wrapsErrored: 0,
      sources: BASE_SOURCES,
      network: { allow: [], deny: [] },
      networkDefault: 'deny',
      filesystem: { writeAllowPaths: [], readDenyPaths: [] },
      lossyNotes: [],
      recentViolations: [],
    };

    expect(buildSandboxStatusReport({ ...base, proxyPorts: { http: undefined, socks: 1080 } })).not.toContain(
      'Proxy ports:',
    );
    expect(buildSandboxStatusReport({ ...base, proxyPorts: { http: 8080 } })).toContain('Proxy ports: http=8080');
    expect(buildSandboxStatusReport({ ...base, proxyPorts: { http: 8080 } })).not.toContain('socks=');
  });
});
