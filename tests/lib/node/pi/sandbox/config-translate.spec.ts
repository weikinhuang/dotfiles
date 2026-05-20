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
    };
    const { config } = translateToASRT({
      policy: basePolicy(),
      sandbox,
      cwd,
      homeDir: HOME,
      mode: 'darwin',
    });
    expect(config.network.allowedDomains).toEqual(['github.com']);
    expect(config.network.deniedDomains).toEqual(['evil.example.com']);
    expect(config.network.allowUnixSockets).toEqual(['/var/run/foo.sock']);
    expect(config.network.allowLocalBinding).toBe(true);
    expect(config.enableWeakerNestedSandbox).toBe(true);
    expect(config.enableWeakerNetworkIsolation).toBe(true);
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
});
