/**
 * Specs for `dangerous-file-stubs.ts` - the helper that pre-creates
 * mount-point files at the ASRT dangerous-file basenames so concurrent
 * bwrap setups don't race on `O_CREAT|O_WRONLY` against a 0444 stub.
 *
 * The interesting properties:
 *
 *   - createDangerousFileStubs touches every basename when none exist.
 *   - It does NOT clobber files that already exist (real .bashrc etc.).
 *   - The stubs use mode 0644 so a second openSync(O_CREAT|O_EXCL) does
 *     not return EACCES the way ASRT's 0444 stubs do.
 *   - cleanupDangerousFileStubs only unlinks zero-byte regular files.
 *   - The basename list stays a subset of ASRT's hard-coded list.
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  cleanupDangerousFileStubs,
  createDangerousFileStubs,
  DANGEROUS_FILE_STUBS,
} from '../../../../../lib/node/pi/sandbox/dangerous-file-stubs.ts';

// Pull ASRT's runtime list directly so the drift guard catches a
// dependency bump that adds new basenames.
import { DANGEROUS_FILES as ASRT_DANGEROUS_FILES } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sandbox-stubs-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('DANGEROUS_FILE_STUBS', () => {
  test('is a subset of ASRT runtime DANGEROUS_FILES', () => {
    const asrtSet: ReadonlySet<string> = new Set<string>(ASRT_DANGEROUS_FILES);
    for (const name of DANGEROUS_FILE_STUBS) {
      expect(asrtSet.has(name)).toBe(true);
    }
  });

  test('includes the basenames implicated in the reproduced race', () => {
    expect(DANGEROUS_FILE_STUBS).toContain('.bashrc');
    expect(DANGEROUS_FILE_STUBS).toContain('.gitmodules');
    expect(DANGEROUS_FILE_STUBS).toContain('.gitconfig');
  });
});

describe('createDangerousFileStubs', () => {
  test('creates every basename when none exist', () => {
    const created = createDangerousFileStubs(cwd);
    expect(new Set(created)).toEqual(new Set(DANGEROUS_FILE_STUBS.map((n) => join(cwd, n))));
    for (const name of DANGEROUS_FILE_STUBS) {
      const st = statSync(join(cwd, name));
      expect(st.isFile()).toBe(true);
      expect(st.size).toBe(0);
    }
  });

  test('uses mode 0644 so a second O_CREAT|O_EXCL would not be blocked by 0444', () => {
    createDangerousFileStubs(cwd);
    for (const name of DANGEROUS_FILE_STUBS) {
      const mode = statSync(join(cwd, name)).mode & 0o777;
      // 0644 (rw-r--r--) — owner can still re-open writable. The ASRT
      // race was rooted in 0444 (r--r--r--) where O_CREAT|O_WRONLY
      // returned EACCES even for the owner.
      expect(mode).toBe(0o644);
    }
  });

  test('does not overwrite a pre-existing file with real content', () => {
    const realBashrc = join(cwd, '.bashrc');
    writeFileSync(realBashrc, 'export FOO=bar\n', 'utf8');
    const created = createDangerousFileStubs(cwd);
    // The pre-existing path is NOT returned as "created" (we don't own it).
    expect(created).not.toContain(realBashrc);
    expect(statSync(realBashrc).size).toBeGreaterThan(0);
  });

  test('still creates the missing stubs when one of the basenames already exists', () => {
    writeFileSync(join(cwd, '.bashrc'), 'export FOO=bar\n', 'utf8');
    const created = createDangerousFileStubs(cwd);
    expect(created).not.toContain(join(cwd, '.bashrc'));
    expect(created).toContain(join(cwd, '.zshrc'));
    expect(created).toContain(join(cwd, '.gitmodules'));
  });
});

describe('cleanupDangerousFileStubs', () => {
  test('unlinks the zero-byte stubs we created', () => {
    const created = createDangerousFileStubs(cwd);
    const removed = cleanupDangerousFileStubs(created);
    expect(new Set(removed)).toEqual(new Set(created));
    for (const abs of created) expect(existsSync(abs)).toBe(false);
  });

  test('does not unlink a stub that has acquired non-empty content', () => {
    const created = createDangerousFileStubs(cwd);
    const grown = join(cwd, '.bashrc');
    writeFileSync(grown, 'modified during session\n', 'utf8');
    const removed = cleanupDangerousFileStubs(created);
    expect(removed).not.toContain(grown);
    expect(existsSync(grown)).toBe(true);
    // The other stubs still get cleaned up.
    expect(existsSync(join(cwd, '.zshrc'))).toBe(false);
  });

  test('tolerates entries that no longer exist on disk', () => {
    const created = createDangerousFileStubs(cwd);
    rmSync(join(cwd, '.bashrc'));
    expect(() => cleanupDangerousFileStubs(created)).not.toThrow();
  });
});
