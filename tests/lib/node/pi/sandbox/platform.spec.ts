/**
 * Tests for lib/node/pi/sandbox/platform.ts.
 *
 * Every probe seam (osPlatform, getuid, commandExists, readFile,
 * fileExists, env, osRelease) is dependency-injected so we never
 * touch the real host.
 */

import { describe, expect, test } from 'vitest';

import { detectSandboxPlatform, type PlatformProbe } from '../../../../../lib/node/pi/sandbox/platform.ts';

function makeProbe(over: Partial<PlatformProbe> = {}): PlatformProbe {
  const base: PlatformProbe = {
    osPlatform: () => 'linux',
    getuid: () => 1000,
    commandExists: () => true,
    readFile: () => null,
    fileExists: () => false,
    env: {},
    osRelease: () => '6.12.0-generic',
  };
  return { ...base, ...over };
}

describe('detectSandboxPlatform - kind detection', () => {
  test('macOS', () => {
    const info = detectSandboxPlatform(makeProbe({ osPlatform: () => 'darwin' }));
    expect(info.kind).toBe('darwin');
    expect(info.description).toMatch(/macOS/);
  });

  test('Linux', () => {
    const info = detectSandboxPlatform(makeProbe());
    expect(info.kind).toBe('linux');
  });

  test('Windows is unsupported', () => {
    const info = detectSandboxPlatform(makeProbe({ osPlatform: () => 'win32' }));
    expect(info.kind).toBe('unsupported');
  });
});

describe('detectSandboxPlatform - WSL detection', () => {
  test('WSL2 (release contains "WSL2") is supported', () => {
    const info = detectSandboxPlatform(makeProbe({ osRelease: () => '5.15.167.4-microsoft-standard-WSL2' }));
    expect(info.kind).toBe('linux');
    expect(info.wslVersion).toBe(2);
    expect(info.description).toMatch(/WSL2/);
  });

  test('WSL1 (microsoft marker without WSL2) is unsupported with hint', () => {
    const info = detectSandboxPlatform(makeProbe({ osRelease: () => '4.4.0-19041-Microsoft' }));
    expect(info.kind).toBe('unsupported');
    expect(info.wslVersion).toBe(1);
    expect(info.hints.join(' ')).toMatch(/WSL1/);
  });

  test('plain Linux release does NOT trigger WSL detection', () => {
    const info = detectSandboxPlatform(makeProbe({ osRelease: () => '6.5.0-aarch64' }));
    expect(info.wslVersion).toBe(0);
  });
});

describe('detectSandboxPlatform - missing deps + hints', () => {
  test('Linux missing all three deps produces apt + dnf install hints', () => {
    const info = detectSandboxPlatform(
      makeProbe({
        commandExists: () => false,
      }),
    );
    expect(info.missingDeps).toEqual(['bwrap', 'socat', 'rg']);
    expect(info.hints.find((h) => h.includes('apt install'))).toBeDefined();
    expect(info.hints.find((h) => h.includes('dnf install'))).toBeDefined();
    expect(info.hints.join(' ')).toMatch(/bubblewrap/);
    expect(info.hints.join(' ')).toMatch(/ripgrep/);
  });

  test('macOS missing rg only produces brew hint', () => {
    const info = detectSandboxPlatform(
      makeProbe({
        osPlatform: () => 'darwin',
        commandExists: (cmd) => cmd !== 'rg',
      }),
    );
    expect(info.missingDeps).toEqual(['rg']);
    expect(info.hints.find((h) => h.includes('brew install'))).toBeDefined();
  });

  test('all deps present produces no missingDeps and no install hints', () => {
    const info = detectSandboxPlatform(makeProbe({ commandExists: () => true }));
    expect(info.missingDeps).toEqual([]);
    expect(info.hints.find((h) => h.includes('install'))).toBeUndefined();
  });
});

describe('detectSandboxPlatform - root + container + AppArmor', () => {
  test('root user surfaces a hint', () => {
    const info = detectSandboxPlatform(makeProbe({ getuid: () => 0 }));
    expect(info.isRoot).toBe(true);
    expect(info.hints.join(' ')).toMatch(/PI_SANDBOX_ALLOW_ROOT/);
  });

  test('Docker via PI_INSIDE_DOCKER env', () => {
    const info = detectSandboxPlatform(makeProbe({ env: { PI_INSIDE_DOCKER: '1' } }));
    expect(info.isInsideDocker).toBe(true);
  });

  test('Docker via /.dockerenv presence', () => {
    const info = detectSandboxPlatform(makeProbe({ fileExists: (p) => p === '/.dockerenv' }));
    expect(info.isInsideDocker).toBe(true);
  });

  test('Docker via /proc/1/cgroup substring', () => {
    const info = detectSandboxPlatform(
      makeProbe({
        readFile: (p) => (p === '/proc/1/cgroup' ? '0::/docker/abc123\n' : null),
      }),
    );
    expect(info.isInsideDocker).toBe(true);
  });

  test('AppArmor restrict_unprivileged_userns=1 trips the flag', () => {
    const info = detectSandboxPlatform(
      makeProbe({
        readFile: (p) => (p === '/proc/sys/kernel/apparmor_restrict_unprivileged_userns' ? '1\n' : null),
      }),
    );
    expect(info.apparmorBlocksUserNs).toBe(true);
  });

  test('AppArmor file absent → flag is false', () => {
    const info = detectSandboxPlatform(makeProbe({ readFile: () => null }));
    expect(info.apparmorBlocksUserNs).toBe(false);
  });

  test('AppArmor flag is Linux-only (macOS never trips)', () => {
    const info = detectSandboxPlatform(
      makeProbe({
        osPlatform: () => 'darwin',
        readFile: () => '1\n',
      }),
    );
    expect(info.apparmorBlocksUserNs).toBe(false);
  });
});
