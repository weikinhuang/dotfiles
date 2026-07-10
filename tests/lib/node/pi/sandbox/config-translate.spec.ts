/**
 * Tests for lib/node/pi/sandbox/config-translate.ts.
 *
 * `import type { SandboxRuntimeConfig }` from ASRT keeps the
 * translator structurally pinned without pulling in any ASRT runtime
 * code, so these tests drive purely against the resulting plain
 * object shape.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { translateToASRT } from '../../../../../lib/node/pi/sandbox/config-translate.ts';
import { emptySandboxConfig, type SandboxConfig } from '../../../../../lib/node/pi/sandbox/config-schema.ts';
import {
  emptyPolicy,
  mergePolicies,
  type FilesystemPolicy,
} from '../../../../../lib/node/pi/filesystem-policy/schema.ts';
import type { CompiledPolicyReport } from '../../../../../lib/node/pi/sandbox/linux-rules-compile.ts';

let cwd: string;
const HOME = '/home/tester';

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-translate-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const baseSandbox = (): SandboxConfig => emptySandboxConfig();
const basePolicy = (): FilesystemPolicy => emptyPolicy();

describe('translateToASRT - macOS mode', () => {
  test('always auto-adds ~/.pi to allowWrite', () => {
    const { config } = translateToASRT({
      policy: basePolicy(),
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.filesystem.allowWrite).toContain(`${HOME}/.pi`);
  });

  test('write.allow.paths resolved against cwd, NOT process.cwd', () => {
    const policy = mergePolicies({
      write: { allow: { paths: ['.', '/tmp', '~/notes'] } },
    });
    const { config } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd: '/repo/foo',
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.filesystem.allowWrite).toEqual(
      [`/home/tester/.pi`, '/home/tester/notes', '/repo/foo', '/tmp'].sort(),
    );
  });

  test('basenames are lifted to **\\/<basename> globs', () => {
    const policy = mergePolicies({
      read: { deny: { basenames: ['.env'] } },
      write: { allow: { paths: ['.'] }, deny: { basenames: ['.env.local'] } },
    });
    const { config } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.filesystem.denyRead).toContain('**/.env');
    expect(config.filesystem.denyWrite).toContain('**/.env.local');
  });

  test('segments are lifted to **\\/<segment>/** globs', () => {
    const policy = mergePolicies({
      write: { allow: { paths: ['.'] }, deny: { segments: ['node_modules', '.git/hooks'] } },
    });
    const { config } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining(['**/node_modules/**', '**/.git/hooks/**']));
  });

  test('read.allow becomes filesystem.allowRead (allow-back) only when non-empty', () => {
    const empty = translateToASRT({
      policy: basePolicy(),
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(empty.config.filesystem.allowRead).toBeUndefined();

    const policy = mergePolicies({
      read: { allow: { paths: ['~/.config/gh/hosts.yml'] } },
    });
    const filled = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(filled.config.filesystem.allowRead).toEqual([`${HOME}/.config/gh/hosts.yml`]);
  });

  test('non-existent denyWrite path on macOS surfaces a lossy note', () => {
    const policy = mergePolicies({
      write: {
        allow: { paths: ['.'] },
        deny: { paths: [join(cwd, 'never-existed')] },
      },
    });
    const { lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(lossyNotes.find((n) => n.includes('silently drop'))).toBeDefined();
  });

  test('non-existent denyRead path on macOS also surfaces a lossy note', () => {
    const policy = mergePolicies({
      read: { deny: { paths: [join(cwd, 'never-existed-read')] }, allow: {} },
      write: { allow: { paths: ['.'] }, deny: {} },
    });
    const { lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(lossyNotes.find((n) => n.includes('read.deny.paths') && n.includes('silently drop'))).toBeDefined();
  });

  test('existing denyWrite path on macOS does NOT add a lossy note', () => {
    const present = join(cwd, 'present');
    mkdirSync(present, { recursive: true });
    writeFileSync(join(present, 'sentinel'), 'x');
    const policy = mergePolicies({
      write: { allow: { paths: ['.'] }, deny: { paths: [present] } },
    });
    const { lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(lossyNotes.find((n) => n.includes('silently drop'))).toBeUndefined();
  });

  test('network allow / deny / unixSockets / flags propagate', () => {
    const sandbox: SandboxConfig = {
      network: { allow: ['github.com'], deny: ['evil.example.com'] },
      unixSockets: { allow: ['/var/run/foo.sock'], allowAll: false },
      flags: {
        weakerNestedSandbox: true,
        weakerNetworkIsolation: true,
        allowLocalBinding: true,
        linuxRuleDepth: 3,
      },
      gitExcludeStubs: true,
    };
    const { config, lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.network.allowedDomains).toEqual(['github.com']);
    expect(config.network.deniedDomains).toEqual(['evil.example.com']);
    expect(config.network.allowUnixSockets).toEqual(['/var/run/foo.sock']);
    // macOS honors the path list - no inert-socket note.
    expect(lossyNotes.find((n) => n.includes('unixSockets.allow is ignored'))).toBeUndefined();
    expect(config.network.allowLocalBinding).toBe(true);
    expect(config.enableWeakerNestedSandbox).toBe(true);
    expect(config.enableWeakerNetworkIsolation).toBe(true);
  });

  test('network.unrestricted drops allowedDomains/deniedDomains and adds a lossy note', () => {
    const sandbox: SandboxConfig = {
      network: { allow: ['github.com'], deny: ['evil.example.com'], unrestricted: true },
      unixSockets: { allow: [], allowAll: true },
      flags: {
        weakerNestedSandbox: false,
        weakerNetworkIsolation: false,
        allowLocalBinding: true,
        linuxRuleDepth: 3,
      },
      gitExcludeStubs: true,
    };
    const { config, lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    // allowedDomains MUST be absent so ASRT's needsNetworkRestriction is
    // false (any value, including []  , re-enables network isolation).
    expect(config.network.allowedDomains).toBeUndefined();
    expect(config.network.deniedDomains).toBeUndefined();
    // unix-socket / local-binding sub-keys still flow through.
    expect(config.network.allowAllUnixSockets).toBe(true);
    expect(config.network.allowLocalBinding).toBe(true);
    expect(lossyNotes.find((n) => n.includes('network.unrestricted=true'))).toBeDefined();
  });

  test('network.allowLocalhost adds loopback hosts to allowedDomains and keeps filtering', () => {
    const sandbox: SandboxConfig = {
      network: { allow: ['github.com'], deny: [], allowLocalhost: true },
      unixSockets: { allow: [], allowAll: false },
      flags: { weakerNestedSandbox: false, weakerNetworkIsolation: false, allowLocalBinding: false, linuxRuleDepth: 3 },
      gitExcludeStubs: true,
    };
    const { config, lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    // Loopback hosts appended; remote allow-list (github.com) retained =>
    // filtering still on (allowedDomains is a finite list, not absent).
    expect(config.network.allowedDomains).toEqual(['github.com', 'localhost', '127.0.0.1', '::1']);
    expect(lossyNotes.find((n) => n.includes('network.allowLocalhost=true'))).toBeDefined();
  });

  test('network.allowLocalhost does not duplicate a loopback host already in allow', () => {
    const sandbox: SandboxConfig = {
      network: { allow: ['127.0.0.1'], deny: [], allowLocalhost: true },
      unixSockets: { allow: [], allowAll: false },
      flags: { weakerNestedSandbox: false, weakerNetworkIsolation: false, allowLocalBinding: false, linuxRuleDepth: 3 },
      gitExcludeStubs: true,
    };
    const { config } = translateToASRT({ policy: basePolicy(), sandbox, cwd, homeDir: HOME, mode: 'darwin' });
    expect(config.network.allowedDomains).toEqual(['127.0.0.1', 'localhost', '::1']);
  });

  test('network.allowLocalhost is a no-op under unrestricted (no allowedDomains at all)', () => {
    const sandbox: SandboxConfig = {
      network: { allow: [], deny: [], unrestricted: true, allowLocalhost: true },
      unixSockets: { allow: [], allowAll: false },
      flags: { weakerNestedSandbox: false, weakerNetworkIsolation: false, allowLocalBinding: false, linuxRuleDepth: 3 },
      gitExcludeStubs: true,
    };
    const { config, lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.network.allowedDomains).toBeUndefined();
    expect(lossyNotes.find((n) => n.includes('network.allowLocalhost=true'))).toBeUndefined();
    expect(lossyNotes.find((n) => n.includes('network.unrestricted=true'))).toBeDefined();
  });

  test('flags off → omit optional ASRT fields entirely', () => {
    const { config } = translateToASRT({
      policy: basePolicy(),
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.enableWeakerNestedSandbox).toBeUndefined();
    expect(config.enableWeakerNetworkIsolation).toBeUndefined();
    expect(config.network.allowLocalBinding).toBeUndefined();
    expect(config.network.allowUnixSockets).toBeUndefined();
    expect(config.network.allowAllUnixSockets).toBeUndefined();
  });

  // ── carve-back / kernel-deny strip ─────────────────────────

  test('write.allow.segments shadows the matching kernel write-deny segment', () => {
    const policy = mergePolicies({
      write: {
        allow: { paths: ['.'], segments: ['node_modules/.vite-temp'] },
        deny: { segments: ['node_modules', '.git/hooks'] },
      },
    });
    const { config, lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    // node_modules glob is stripped (vitest can write under .vite-temp
    // at the kernel layer); .git/hooks deny stays.
    expect(config.filesystem.denyWrite).not.toContain('**/node_modules/**');
    expect(config.filesystem.denyWrite).toContain('**/.git/hooks/**');
    expect(lossyNotes.find((n) => n.includes('kernel write-deny on segment `node_modules`'))).toBeDefined();
  });

  test('write.allow.basenames (exact match) shadows the matching kernel write-deny basename', () => {
    const policy = mergePolicies({
      write: {
        allow: { paths: ['.'], basenames: ['.env.fixture'] },
        deny: { basenames: ['.env.fixture', '.env.real'] },
      },
    });
    const { config, lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.filesystem.denyWrite).not.toContain('**/.env.fixture');
    expect(config.filesystem.denyWrite).toContain('**/.env.real');
    expect(lossyNotes.find((n) => n.includes('kernel write-deny on basename `.env.fixture`'))).toBeDefined();
  });

  test('non-matching carve-back leaves the deny in place (segment must equal-or-extend the deny)', () => {
    const policy = mergePolicies({
      write: {
        // `node_modulez` is similar but NOT segment-equal, so it does
        // not shadow `node_modules`.
        allow: { paths: ['.'], segments: ['node_modulez/foo'] },
        deny: { segments: ['node_modules'] },
      },
    });
    const { config, lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.filesystem.denyWrite).toContain('**/node_modules/**');
    expect(lossyNotes.find((n) => n.includes('kernel write-deny on segment'))).toBeUndefined();
  });
});

describe('translateToASRT - Linux mode', () => {
  const compiled = (over: Partial<CompiledPolicyReport> = {}): CompiledPolicyReport => ({
    read: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: [] },
    write: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: [] },
    ...over,
  });

  test('throws if compiled report is missing', () => {
    expect(() =>
      translateToASRT({
        policy: basePolicy(),
        sandbox: baseSandbox(),
        cwd,
        mode: 'linux',
      }),
    ).toThrow(/compileLinuxPolicy/);
  });

  test('uses the compiled paths verbatim', () => {
    const c = compiled({
      read: { paths: ['/repo/conf/secrets.yml'], inertBasenames: [], inertSegments: [], inertPaths: [] },
      write: { paths: ['/repo/.env'], inertBasenames: [], inertSegments: [], inertPaths: [] },
    });
    const { config } = translateToASRT({
      policy: basePolicy(),
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: c,
    });
    expect(config.filesystem.denyRead).toEqual(['/repo/conf/secrets.yml']);
    expect(config.filesystem.denyWrite).toEqual(['/repo/.env']);
    // No allowRead emitted - bwrap doesn't get a translation.
    expect(config.filesystem.allowRead).toBeUndefined();
  });

  test('non-empty read.allow on Linux surfaces a lossy note', () => {
    const policy = mergePolicies({
      read: { allow: { paths: ['~/.config/gh/hosts.yml'] } },
    });
    const { lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: compiled(),
    });
    expect(lossyNotes.find((n) => n.includes('read.allow'))).toBeDefined();
  });

  test('non-empty unixSockets.allow without allowAll surfaces a lossy note', () => {
    const sandbox: SandboxConfig = {
      ...baseSandbox(),
      unixSockets: { allow: ['/var/run/docker.sock'], allowAll: false },
    };
    const { config, lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: compiled(),
    });
    // Still propagated to the runtime config (macOS may honor it), but
    // flagged as inert on this platform.
    expect(config.network.allowUnixSockets).toEqual(['/var/run/docker.sock']);
    expect(lossyNotes.find((n) => /unixSockets\.allow is ignored.*docker\.sock/.test(n))).toBeDefined();
  });

  test('flags.allowLocalBinding on Linux surfaces a no-op lossy note', () => {
    const sandbox: SandboxConfig = {
      ...baseSandbox(),
      flags: { ...baseSandbox().flags, allowLocalBinding: true },
    };
    const { lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: compiled(),
    });
    expect(lossyNotes.find((n) => n.includes('allowLocalBinding has NO effect'))).toBeDefined();
    expect(lossyNotes.find((n) => n.includes('network.unrestricted'))).toBeDefined();
  });

  test('flags.allowLocalBinding on Linux is silent when network.unrestricted is set', () => {
    const sandbox: SandboxConfig = {
      ...baseSandbox(),
      network: { allow: [], deny: [], unrestricted: true },
      flags: { ...baseSandbox().flags, allowLocalBinding: true },
    };
    const { lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: compiled(),
    });
    expect(lossyNotes.find((n) => n.includes('allowLocalBinding has NO effect'))).toBeUndefined();
  });

  test('unixSockets.allow with allowAll → no lossy note', () => {
    const sandbox: SandboxConfig = {
      ...baseSandbox(),
      unixSockets: { allow: ['/var/run/docker.sock'], allowAll: true },
    };
    const { lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: compiled(),
    });
    expect(lossyNotes.find((n) => n.includes('unixSockets.allow is ignored'))).toBeUndefined();
  });

  test('inert basename / segment lists from the compile pass become lossy notes', () => {
    const c = compiled({
      read: { paths: [], inertBasenames: ['.env.absent'], inertSegments: ['.terraform'], inertPaths: [] },
      write: { paths: [], inertBasenames: ['.private'], inertSegments: [], inertPaths: [] },
    });
    const { lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: c,
    });
    expect(lossyNotes.find((n) => /read\.deny\.basenames.*\.env\.absent/.test(n))).toBeDefined();
    expect(lossyNotes.find((n) => /read\.deny\.segments.*\.terraform/.test(n))).toBeDefined();
    expect(lossyNotes.find((n) => /write\.deny\.basenames.*\.private/.test(n))).toBeDefined();
  });

  test('inertPaths from the compile pass become lossy notes', () => {
    const c = compiled({
      read: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: ['/etc/missing-read'] },
      write: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: ['/etc/missing-write'] },
    });
    const { lossyNotes } = translateToASRT({
      policy: basePolicy(),
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: c,
    });
    expect(lossyNotes.find((n) => /read\.deny\.paths.*missing-read/.test(n))).toBeDefined();
    expect(lossyNotes.find((n) => /write\.deny\.paths.*missing-write/.test(n))).toBeDefined();
  });

  test('write.allow.segments shadows the matching compiled write-deny path', () => {
    // The compile pass turned `node_modules` into the literal
    // /repo/node_modules; the carve-back tail-matches it and we
    // strip the deny from the kernel layer.
    const c = compiled({
      read: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: [] },
      write: {
        paths: ['/repo/node_modules', '/repo/.git/hooks'],
        inertBasenames: [],
        inertSegments: [],
        inertPaths: [],
      },
    });
    const policy = mergePolicies({
      write: {
        allow: { paths: ['.'], segments: ['node_modules/.vite-temp'] },
        deny: { segments: ['node_modules', '.git/hooks'] },
      },
    });
    const { config, lossyNotes } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: c,
    });
    // node_modules deny stripped, .git/hooks deny preserved.
    expect(config.filesystem.denyWrite).not.toContain('/repo/node_modules');
    expect(config.filesystem.denyWrite).toContain('/repo/.git/hooks');
    expect(lossyNotes.find((n) => n.includes('Linux: kernel write-deny on segment `node_modules`'))).toBeDefined();
  });

  test('write.allow.basenames shadow strips compiled paths whose basename matches', () => {
    const c = compiled({
      read: { paths: [], inertBasenames: [], inertSegments: [], inertPaths: [] },
      write: {
        paths: ['/repo/src/.env.fixture', '/repo/src/.env.real'],
        inertBasenames: [],
        inertSegments: [],
        inertPaths: [],
      },
    });
    const policy = mergePolicies({
      write: {
        allow: { paths: ['.'], basenames: ['.env.fixture'] },
        deny: { basenames: ['.env.fixture', '.env.real'] },
      },
    });
    const { config } = translateToASRT({
      policy,
      sandbox: baseSandbox(),
      cwd,
      homeDir: HOME,
      mode: 'linux',
      compiled: c,
    });
    expect(config.filesystem.denyWrite).not.toContain('/repo/src/.env.fixture');
    expect(config.filesystem.denyWrite).toContain('/repo/src/.env.real');
  });
});
