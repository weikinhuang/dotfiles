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

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  cleanupDangerousFileStubs,
  createDangerousFileStubs,
  DANGEROUS_DIR_STUBS,
  DANGEROUS_FILE_STUBS,
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

  test('does not record an intermediate that already exists', () => {
    // Pre-populate .claude/ to simulate a project that already uses it.
    mkdirSync(join(cwd, '.claude'));
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
