/**
 * Specs for `dangerous-file-stubs.ts` - the helper that pre-creates
 * mount-point stubs at ASRT's mandatory deny basenames + directories,
 * so concurrent bwrap setups don't race on the create.
 *
 * The interesting properties:
 *
 *   - createDangerousFileStubs touches every basename when none exist.
 *   - It walks each missing intermediate component for nested dir
 *     stubs (`.claude/commands` creates `.claude` and `.claude/commands`).
 *   - It does NOT clobber existing files / dirs (real `.bashrc`,
 *     populated `.idea/`, etc.).
 *   - File stubs use mode 0644 so a second openSync(O_CREAT|O_EXCL)
 *     does not return EACCES the way ASRT's 0444 stubs do.
 *   - cleanupDangerousFileStubs only removes unchanged process-owned
 *     files and empty dirs, deepest-first, without following symlinks.
 *   - The file basename list stays a superset of ASRT's hard-coded
 *     DANGEROUS_FILES. The directory list mirrors
 *     getDangerousDirectories() verbatim.
 */

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  cleanupDangerousFileStubs,
  createDangerousFileStubs,
  DANGEROUS_DIR_STUBS,
  DANGEROUS_FILE_STUBS,
  listDangerousStubPaths,
  sweepOrphanDangerousStubs,
} from '../../../../../lib/node/pi/sandbox/dangerous-file-stubs.ts';

import {
  DANGEROUS_FILES as ASRT_DANGEROUS_FILES,
  getDangerousDirectories as asrtGetDangerousDirectories,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';

let cwd: string;

beforeEach(() => {
  // macOS /tmp and /var are symlinks. Use their canonical spelling so
  // the normal fixture has no symlink ancestors at all.
  cwd = mkdtempSync(join(realpathSync(tmpdir()), 'sandbox-stubs-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('DANGEROUS_FILE_STUBS', () => {
  test('is a superset of ASRT runtime DANGEROUS_FILES', () => {
    const stubSet: ReadonlySet<string> = new Set<string>(DANGEROUS_FILE_STUBS);
    for (const name of ASRT_DANGEROUS_FILES) {
      expect(stubSet.has(name)).toBe(true);
    }
  });

  test('includes Claude-Code workspace pre-touch additions', () => {
    // The defensive extras pi pre-touches even though they are not in
    // ASRT's mandatory deny list, so users adding them to write.deny
    // do not trip the same bwrap mount-point race.
    expect(DANGEROUS_FILE_STUBS).toContain('.npmrc');
    expect(DANGEROUS_FILE_STUBS).toContain('package.json');
    expect(DANGEROUS_FILE_STUBS).toContain('package-lock.json');
    expect(DANGEROUS_FILE_STUBS).toContain('yarn.lock');
    expect(DANGEROUS_FILE_STUBS).toContain('pnpm-lock.yaml');
  });
});

describe('DANGEROUS_DIR_STUBS', () => {
  test('matches ASRT getDangerousDirectories() verbatim', () => {
    expect([...DANGEROUS_DIR_STUBS]).toEqual([...asrtGetDangerousDirectories()]);
  });

  test('includes the directory implicated in the second reproduced race', () => {
    expect(DANGEROUS_DIR_STUBS).toContain('.claude/commands');
    expect(DANGEROUS_DIR_STUBS).toContain('.claude/agents');
    expect(DANGEROUS_DIR_STUBS).toContain('.vscode');
    expect(DANGEROUS_DIR_STUBS).toContain('.idea');
  });
});

describe('createDangerousFileStubs - files', () => {
  test('creates every basename when none exist', () => {
    const created = createDangerousFileStubs(cwd);
    for (const name of DANGEROUS_FILE_STUBS) {
      const abs = join(cwd, name);
      expect(created).toContain(abs);
      const st = statSync(abs);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBe(0);
    }
  });

  test('uses mode 0644 so concurrent open is not blocked by 0444', () => {
    createDangerousFileStubs(cwd);
    for (const name of DANGEROUS_FILE_STUBS) {
      const mode = statSync(join(cwd, name)).mode & 0o777;
      expect(mode).toBe(0o644);
    }
  });

  test('does not overwrite a pre-existing file with real content', () => {
    const realBashrc = join(cwd, '.bashrc');
    writeFileSync(realBashrc, 'export FOO=bar\n', 'utf8');
    const created = createDangerousFileStubs(cwd);
    expect(created).not.toContain(realBashrc);
    expect(statSync(realBashrc).size).toBeGreaterThan(0);
  });
});

describe('createDangerousFileStubs - directories', () => {
  test('creates each top-level dangerous-directory stub', () => {
    const created = createDangerousFileStubs(cwd);
    expect(created).toContain(join(cwd, '.vscode'));
    expect(created).toContain(join(cwd, '.idea'));
    expect(statSync(join(cwd, '.vscode')).isDirectory()).toBe(true);
  });

  test('walks every intermediate component for nested dir stubs', () => {
    const created = createDangerousFileStubs(cwd);
    // .claude/commands creates BOTH .claude and .claude/commands when
    // neither exists - the cleanup tracks both so it can rmdir the
    // parent after the leaf.
    expect(created).toContain(join(cwd, '.claude'));
    expect(created).toContain(join(cwd, '.claude/commands'));
    expect(created).toContain(join(cwd, '.claude/agents'));
  });

  test('does not record an intermediate that already exists with content', () => {
    // Simulate a project that already uses .claude/. The directory is
    // populated, so we must not adopt it for cleanup. Empty unknown
    // intermediates must also survive, as covered below.
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude/.keep'), '', 'utf8');
    const created = createDangerousFileStubs(cwd);
    expect(created).not.toContain(join(cwd, '.claude'));
    // The leaf is still created.
    expect(created).toContain(join(cwd, '.claude/commands'));
  });

  test('does not clobber a populated dangerous directory', () => {
    mkdirSync(join(cwd, '.idea'));
    writeFileSync(join(cwd, '.idea/workspace.xml'), '<x/>\n', 'utf8');
    const created = createDangerousFileStubs(cwd);
    expect(created).not.toContain(join(cwd, '.idea'));
    expect(existsSync(join(cwd, '.idea/workspace.xml'))).toBe(true);
  });
});

describe('cleanupDangerousFileStubs', () => {
  test('unlinks zero-byte files and rmdirs empty dirs we created', () => {
    const created = createDangerousFileStubs(cwd);
    const removed = cleanupDangerousFileStubs(created);
    for (const abs of created) {
      expect(removed).toContain(abs);
      expect(existsSync(abs)).toBe(false);
    }
  });

  test('walks dirs deepest-first so nested stubs clear in one pass', () => {
    const created = createDangerousFileStubs(cwd);
    cleanupDangerousFileStubs(created);
    // Both the parent and leaf we created should be gone.
    expect(existsSync(join(cwd, '.claude/commands'))).toBe(false);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  test('keeps a stub that gained non-empty content during the session', () => {
    const created = createDangerousFileStubs(cwd);
    const grown = join(cwd, '.bashrc');
    writeFileSync(grown, 'modified during session\n', 'utf8');
    const removed = cleanupDangerousFileStubs(created);
    expect(removed).not.toContain(grown);
    expect(existsSync(grown)).toBe(true);
  });

  test('keeps a dir stub that gained an entry during the session', () => {
    const created = createDangerousFileStubs(cwd);
    const filled = join(cwd, '.vscode');
    writeFileSync(join(filled, 'settings.json'), '{}\n', 'utf8');
    const removed = cleanupDangerousFileStubs(created);
    expect(removed).not.toContain(filled);
    expect(existsSync(filled)).toBe(true);
  });

  test('does not delete or re-adopt user replacements, even when empty', () => {
    const created = createDangerousFileStubs(cwd);
    const file = join(cwd, '.npmrc');
    const dir = join(cwd, '.vscode');
    // Keep originals alive elsewhere so inode reuse cannot mask the test.
    renameSync(file, join(cwd, 'original-file'));
    renameSync(dir, join(cwd, 'original-dir'));
    writeFileSync(file, '');
    mkdirSync(dir);

    const reused = createDangerousFileStubs(cwd);
    expect(reused).not.toContain(file);
    expect(reused).not.toContain(dir);
    const removed = cleanupDangerousFileStubs(created);
    expect(removed).not.toContain(file);
    expect(removed).not.toContain(dir);
    expect(sweepOrphanDangerousStubs(cwd)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  test('checks replacement identity during cleanup without a prior create', () => {
    const created = createDangerousFileStubs(cwd);
    const file = join(cwd, '.npmrc');
    const dir = join(cwd, '.vscode');
    renameSync(file, join(cwd, 'original-file'));
    renameSync(dir, join(cwd, 'original-dir'));
    writeFileSync(file, '');
    mkdirSync(dir);

    const removed = cleanupDangerousFileStubs(created);
    expect(removed).not.toContain(file);
    expect(removed).not.toContain(dir);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  test('keeps an owned file edited and truncated back to zero', () => {
    const created = createDangerousFileStubs(cwd);
    const file = join(cwd, '.npmrc');
    writeFileSync(file, 'user edit');
    writeFileSync(file, '');
    // Make the timestamp difference deterministic on coarse filesystems.
    utimesSync(file, 1, 1);
    expect(cleanupDangerousFileStubs(created)).not.toContain(file);
    expect(existsSync(file)).toBe(true);
  });

  test('tolerates entries that no longer exist on disk', () => {
    const created = createDangerousFileStubs(cwd);
    rmSync(join(cwd, '.bashrc'));
    rmSync(join(cwd, '.vscode'), { recursive: true });
    expect(() => cleanupDangerousFileStubs(created)).not.toThrow();
  });
});

describe('createDangerousFileStubs - ownership on EEXIST', () => {
  test('does not adopt an unknown zero-byte .npmrc, including crash leftovers', () => {
    const unknown = join(cwd, '.npmrc');
    writeFileSync(unknown, '');

    const created = createDangerousFileStubs(cwd);

    expect(created).not.toContain(unknown);
    cleanupDangerousFileStubs([...created, unknown]);
    expect(existsSync(unknown)).toBe(true);
  });

  test('reuses known owned EEXIST files and non-empty intermediate dirs', () => {
    const first = createDangerousFileStubs(cwd);
    const second = createDangerousFileStubs(cwd);

    // Each concurrent wrap must return all owned levels to its caller's
    // refcount ledger, including .claude while its children exist.
    expect(new Set(second)).toEqual(new Set(first));
    expect(second).toContain(join(cwd, '.claude'));
    expect(second).toContain(join(cwd, '.claude/commands'));
    expect(second).toContain(join(cwd, '.npmrc'));
    expect(new Set(cleanupDangerousFileStubs(second))).toEqual(new Set(first));
  });

  test('shares ownership across independent module copies without disk metadata', async () => {
    const first = createDangerousFileStubs(cwd);
    expect(readdirSync(cwd).sort()).toEqual([...DANGEROUS_FILE_STUBS, '.vscode', '.idea', '.claude'].sort());
    vi.resetModules();
    const otherCopy = await import('../../../../../lib/node/pi/sandbox/dangerous-file-stubs.ts');

    expect(new Set(otherCopy.createDangerousFileStubs(cwd))).toEqual(new Set(first));
    expect(new Set(otherCopy.cleanupDangerousFileStubs(first))).toEqual(new Set(first));
    expect(cleanupDangerousFileStubs(first)).toEqual([]);
  });

  test('isProtected additionally excludes known owned entries from reuse', () => {
    const first = createDangerousFileStubs(cwd);
    const protectedPaths = new Set([join(cwd, '.npmrc'), join(cwd, '.vscode')]);
    const second = createDangerousFileStubs(cwd, { isProtected: (abs) => protectedPaths.has(abs) });
    for (const abs of protectedPaths) expect(second).not.toContain(abs);
    cleanupDangerousFileStubs(first);
  });

  test('does NOT adopt a 0-byte file flagged by isProtected', () => {
    // Simulate a freshly-cloned but legitimately empty user file.
    const userEmpty = join(cwd, '.bashrc');
    closeSync(openSync(userEmpty, 'w', 0o644));

    const created = createDangerousFileStubs(cwd, {
      isProtected: (abs) => abs === userEmpty,
    });

    expect(created).not.toContain(userEmpty);
    cleanupDangerousFileStubs(created);
    expect(existsSync(userEmpty)).toBe(true);
  });

  test('does NOT adopt a non-empty pre-existing file even when not protected', () => {
    const real = join(cwd, '.bashrc');
    writeFileSync(real, 'export FOO=bar\n', 'utf8');
    const created = createDangerousFileStubs(cwd);
    expect(created).not.toContain(real);
    expect(statSync(real).size).toBeGreaterThan(0);
  });

  test('does not adopt an unknown empty .vscode or intermediate directory', () => {
    const unknown = join(cwd, '.vscode');
    const intermediate = join(cwd, '.claude');
    mkdirSync(unknown, { mode: 0o755 });
    mkdirSync(intermediate);

    const created = createDangerousFileStubs(cwd);

    expect(created).not.toContain(unknown);
    expect(created).not.toContain(intermediate);
    expect(created).toContain(join(intermediate, 'commands'));
    cleanupDangerousFileStubs([...created, unknown, intermediate]);
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(intermediate)).toBe(true);
  });

  test('does NOT adopt a populated dangerous directory', () => {
    const populated = join(cwd, '.idea');
    mkdirSync(populated);
    writeFileSync(join(populated, 'workspace.xml'), '<x/>\n', 'utf8');
    const created = createDangerousFileStubs(cwd);
    expect(created).not.toContain(populated);
    expect(existsSync(join(populated, 'workspace.xml'))).toBe(true);
  });

  test('does NOT adopt an empty dangerous directory flagged by isProtected', () => {
    const userEmptyDir = join(cwd, '.vscode');
    mkdirSync(userEmptyDir);

    const created = createDangerousFileStubs(cwd, {
      isProtected: (abs) => abs === userEmptyDir,
    });

    expect(created).not.toContain(userEmptyDir);
    cleanupDangerousFileStubs(created);
    expect(existsSync(userEmptyDir)).toBe(true);
  });
});

describe('symlink safety', () => {
  test('never creates nested stubs through a .claude symlink', () => {
    const external = join(cwd, 'external');
    const claude = join(cwd, '.claude');
    mkdirSync(external);
    symlinkSync(external, claude, 'dir');

    const created = createDangerousFileStubs(cwd);
    for (const abs of [claude, join(claude, 'commands'), join(claude, 'agents')]) {
      expect(created).not.toContain(abs);
    }
    cleanupDangerousFileStubs(created);
    sweepOrphanDangerousStubs(cwd);
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readdirSync(external)).toEqual([]);
  });

  test('cleanup and sweep reject an ancestor replaced with a symlink to the original', () => {
    const created = createDangerousFileStubs(cwd);
    const claude = join(cwd, '.claude');
    const external = join(cwd, 'external');
    renameSync(claude, external);
    symlinkSync(external, claude, 'dir');
    // Leaf identities still match. Only the ancestor check prevents
    // deleting the original leaf directories through the new symlink.
    const removed = cleanupDangerousFileStubs(created);
    expect(removed).not.toContain(join(claude, 'commands'));
    expect(removed).not.toContain(join(claude, 'agents'));
    sweepOrphanDangerousStubs(cwd);
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readdirSync(external).sort()).toEqual(['agents', 'commands']);
  });

  test('sweep independently rejects symlink ancestors of known owned leaves', () => {
    createDangerousFileStubs(cwd);
    const claude = join(cwd, '.claude');
    const external = join(cwd, 'external');
    renameSync(claude, external);
    symlinkSync(external, claude, 'dir');

    const removed = sweepOrphanDangerousStubs(cwd);
    expect(removed).not.toContain(join(claude, 'commands'));
    expect(removed).not.toContain(join(claude, 'agents'));
    expect(readdirSync(external).sort()).toEqual(['agents', 'commands']);
  });

  test('leaves pre-existing file and directory symlinks and empty targets untouched', () => {
    const external = join(cwd, 'external');
    mkdirSync(external);
    const fileTarget = join(external, 'file');
    const dirTarget = join(external, 'dir');
    writeFileSync(fileTarget, '');
    mkdirSync(dirTarget);
    const fileLink = join(cwd, '.npmrc');
    const dirLink = join(cwd, '.vscode');
    symlinkSync(fileTarget, fileLink);
    symlinkSync(dirTarget, dirLink, 'dir');

    const created = createDangerousFileStubs(cwd);
    expect(created).not.toContain(fileLink);
    expect(created).not.toContain(dirLink);
    cleanupDangerousFileStubs([...created, fileLink, dirLink]);
    sweepOrphanDangerousStubs(cwd);
    expect(lstatSync(fileLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(statSync(fileTarget).size).toBe(0);
    expect(readdirSync(dirTarget)).toEqual([]);
  });

  test('does not remove owned leaves replaced by symlinks, even to their original inodes', () => {
    const created = createDangerousFileStubs(cwd);
    const fileLink = join(cwd, '.npmrc');
    const dirLink = join(cwd, '.vscode');
    const fileTarget = join(cwd, 'original-file');
    const dirTarget = join(cwd, 'original-dir');
    renameSync(fileLink, fileTarget);
    renameSync(dirLink, dirTarget);
    symlinkSync(fileTarget, fileLink);
    symlinkSync(dirTarget, dirLink, 'dir');

    const removed = cleanupDangerousFileStubs(created);
    expect(removed).not.toContain(fileLink);
    expect(removed).not.toContain(dirLink);
    sweepOrphanDangerousStubs(cwd);
    expect(lstatSync(fileLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(existsSync(fileTarget)).toBe(true);
    expect(existsSync(dirTarget)).toBe(true);
  });

  test('refuses creation when cwd itself is a symlink', () => {
    const external = join(cwd, 'external');
    const link = join(cwd, 'linked-cwd');
    mkdirSync(external);
    symlinkSync(external, link, 'dir');

    expect(createDangerousFileStubs(link)).toEqual([]);
    expect(sweepOrphanDangerousStubs(link)).toEqual([]);
    expect(readdirSync(external)).toEqual([]);
  });
});

describe('listDangerousStubPaths', () => {
  test('includes every dangerous-file basename', () => {
    const paths = listDangerousStubPaths(cwd);
    for (const name of DANGEROUS_FILE_STUBS) {
      expect(paths).toContain(join(cwd, name));
    }
  });

  test('walks every intermediate component of a nested dir stub', () => {
    const paths = listDangerousStubPaths(cwd);
    expect(paths).toContain(join(cwd, '.claude'));
    expect(paths).toContain(join(cwd, '.claude/commands'));
    expect(paths).toContain(join(cwd, '.claude/agents'));
  });
});

describe('sweepOrphanDangerousStubs', () => {
  test('preserves unknown zero-byte .npmrc and empty .vscode', () => {
    // Neither a matching name nor emptiness proves process ownership.
    const unknownFile = join(cwd, '.npmrc');
    const unknownDir = join(cwd, '.vscode');
    writeFileSync(unknownFile, '');
    mkdirSync(unknownDir);

    expect(sweepOrphanDangerousStubs(cwd, { isProtected: () => false })).toEqual([]);
    expect(existsSync(unknownFile)).toBe(true);
    expect(existsSync(unknownDir)).toBe(true);
  });

  test('removes only known process-owned stubs', () => {
    const created = createDangerousFileStubs(cwd);
    expect(new Set(sweepOrphanDangerousStubs(cwd))).toEqual(new Set(created));
    for (const abs of created) expect(existsSync(abs)).toBe(false);
  });

  test('keeps user-authored files (non-empty) and populated directories', () => {
    const realFile = join(cwd, '.bashrc');
    const realDir = join(cwd, '.idea');
    writeFileSync(realFile, 'export FOO=bar\n', 'utf8');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'workspace.xml'), '<x/>\n', 'utf8');

    const removed = sweepOrphanDangerousStubs(cwd);

    expect(removed).not.toContain(realFile);
    expect(removed).not.toContain(realDir);
    expect(existsSync(realFile)).toBe(true);
    expect(existsSync(join(realDir, 'workspace.xml'))).toBe(true);
  });

  test('respects isProtected for both owned zero-byte files and empty dirs', () => {
    createDangerousFileStubs(cwd);
    const protectedFile = join(cwd, '.bashrc');
    const protectedDir = join(cwd, '.vscode');

    const removed = sweepOrphanDangerousStubs(cwd, {
      isProtected: (abs) => abs === protectedFile || abs === protectedDir,
    });

    expect(removed).not.toContain(protectedFile);
    expect(removed).not.toContain(protectedDir);
    expect(existsSync(protectedFile)).toBe(true);
    expect(existsSync(protectedDir)).toBe(true);
  });

  test('is a no-op on a clean cwd', () => {
    const removed = sweepOrphanDangerousStubs(cwd);
    expect(removed).toEqual([]);
  });

  test('removes nested dir stubs deepest-first', () => {
    createDangerousFileStubs(cwd);

    const removed = sweepOrphanDangerousStubs(cwd);

    // All three process-owned directories are removed in a single sweep.
    expect(removed).toContain(join(cwd, '.claude/commands'));
    expect(removed).toContain(join(cwd, '.claude/agents'));
    expect(removed).toContain(join(cwd, '.claude'));
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });
});
