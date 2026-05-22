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
 *   - cleanupDangerousFileStubs only unlinks zero-byte files and
 *     rmdirs empty dirs, deepest-first.
 *   - The file basename list stays a superset of ASRT's hard-coded
 *     DANGEROUS_FILES. The directory list mirrors
 *     getDangerousDirectories() verbatim.
 */

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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
  cwd = mkdtempSync(join(tmpdir(), 'sandbox-stubs-'));
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
    // populated, so we must not adopt it for cleanup. (An EMPTY
    // pre-existing .claude/ is treated as an orphan stub - covered by
    // the adopt-on-EEXIST suite below.)
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

  test('tolerates entries that no longer exist on disk', () => {
    const created = createDangerousFileStubs(cwd);
    rmSync(join(cwd, '.bashrc'));
    rmSync(join(cwd, '.vscode'), { recursive: true });
    expect(() => cleanupDangerousFileStubs(created)).not.toThrow();
  });
});

describe('createDangerousFileStubs - adopt-on-EEXIST', () => {
  test('adopts a leaked 0-byte stub file from a prior session for cleanup', () => {
    // Simulate a SIGKILL-leaked stub: 0-byte file the previous pi
    // process never got to clean up.
    const leaked = join(cwd, '.bashrc');
    closeSync(openSync(leaked, 'w', 0o644));
    expect(statSync(leaked).size).toBe(0);

    const created = createDangerousFileStubs(cwd);

    // Now in this session's tracked set, so cleanup will GC it.
    expect(created).toContain(leaked);
    cleanupDangerousFileStubs(created);
    expect(existsSync(leaked)).toBe(false);
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

  test('adopts a leaked empty stub directory for rmdir', () => {
    // Pre-create the dangerous-dir stub like a prior session would
    // have. createDangerousFileStubs gets EEXIST and should adopt.
    const leakedDir = join(cwd, '.vscode');
    mkdirSync(leakedDir, { mode: 0o755 });

    const created = createDangerousFileStubs(cwd);

    expect(created).toContain(leakedDir);
    cleanupDangerousFileStubs(created);
    expect(existsSync(leakedDir)).toBe(false);
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
  test('removes leaked 0-byte stubs and empty stub dirs', () => {
    // Hand-craft the leaked state: stubs that were created by a prior
    // session whose shutdown handler never fired.
    const leakedFile = join(cwd, '.bashrc');
    const leakedDir = join(cwd, '.vscode');
    closeSync(openSync(leakedFile, 'w', 0o644));
    mkdirSync(leakedDir);

    const removed = sweepOrphanDangerousStubs(cwd);

    expect(removed).toContain(leakedFile);
    expect(removed).toContain(leakedDir);
    expect(existsSync(leakedFile)).toBe(false);
    expect(existsSync(leakedDir)).toBe(false);
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

  test('respects isProtected for both 0-byte files and empty dirs', () => {
    const protectedFile = join(cwd, '.bashrc');
    const protectedDir = join(cwd, '.vscode');
    closeSync(openSync(protectedFile, 'w', 0o644));
    mkdirSync(protectedDir);

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
    // Both .claude and .claude/commands leaked from the prior session.
    mkdirSync(join(cwd, '.claude'));
    mkdirSync(join(cwd, '.claude/commands'));
    mkdirSync(join(cwd, '.claude/agents'));

    const removed = sweepOrphanDangerousStubs(cwd);

    // All three rmdir'd in a single sweep.
    expect(removed).toContain(join(cwd, '.claude/commands'));
    expect(removed).toContain(join(cwd, '.claude/agents'));
    expect(removed).toContain(join(cwd, '.claude'));
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });
});
