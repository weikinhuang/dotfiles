/**
 * Tests for lib/node/pi/subdir-agents.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  candidateContextPaths,
  capContent,
  DEFAULT_CONTEXT_FILE_BYTE_CAP,
  DEFAULT_CONTEXT_FILE_NAMES,
  displayPath,
  formatBytes,
  formatContextInjection,
  isInsideCwd,
  normalizeAbs,
} from '../../../../lib/node/pi/subdir-agents.ts';

// ──────────────────────────────────────────────────────────────────────
// normalizeAbs / isInsideCwd
// ──────────────────────────────────────────────────────────────────────

test('normalizeAbs: strips trailing separator', () => {
  const a = normalizeAbs('/foo/bar/');

  expect(a).toBe(resolve('/foo/bar'));
});

test('normalizeAbs: leaves root path alone', () => {
  // On POSIX the root is `/` - stripping it would leave '' which is wrong.
  const a = normalizeAbs('/');

  expect(a.length).toBeGreaterThanOrEqual(1);
});

test('isInsideCwd: true for descendant', () => {
  expect(isInsideCwd(resolve('/a/b/c/d.txt'), resolve('/a/b'))).toBe(true);
});

test('isInsideCwd: true for cwd itself', () => {
  expect(isInsideCwd(resolve('/a/b'), resolve('/a/b'))).toBe(true);
});

test('isInsideCwd: false for sibling', () => {
  expect(isInsideCwd(resolve('/a/x'), resolve('/a/b'))).toBe(false);
});

test('isInsideCwd: false for ancestor', () => {
  expect(isInsideCwd(resolve('/a'), resolve('/a/b'))).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// candidateContextPaths
// ──────────────────────────────────────────────────────────────────────

describe('candidateContextPaths', () => {
  test('returns deepest-first list for a nested file', () => {
    const cwd = resolve('/proj');
    const file = resolve('/proj/tests/unit/foo.spec.ts');

    const paths = candidateContextPaths(file, cwd);

    expect(paths).toEqual([
      resolve('/proj/tests/unit/AGENTS.md'),
      resolve('/proj/tests/unit/CLAUDE.md'),
      resolve('/proj/tests/AGENTS.md'),
      resolve('/proj/tests/CLAUDE.md'),
      resolve('/proj/AGENTS.md'),
      resolve('/proj/CLAUDE.md'),
    ]);
  });

  test('file directly in cwd returns only cwd-level candidates', () => {
    const cwd = resolve('/proj');
    const file = resolve('/proj/foo.ts');

    expect(candidateContextPaths(file, cwd)).toEqual([resolve('/proj/AGENTS.md'), resolve('/proj/CLAUDE.md')]);
  });

  test('file outside cwd returns empty list', () => {
    expect(candidateContextPaths(resolve('/other/foo.ts'), resolve('/proj'))).toEqual([]);
  });

  test('custom filename list is respected', () => {
    const paths = candidateContextPaths(resolve('/proj/tests/foo.ts'), resolve('/proj'), ['RULES.md']);

    expect(paths).toEqual([resolve('/proj/tests/RULES.md'), resolve('/proj/RULES.md')]);
  });

  test('empty filename list returns empty', () => {
    expect(candidateContextPaths(resolve('/proj/tests/foo.ts'), resolve('/proj'), [])).toEqual([]);
  });

  test('cwd itself as filePath returns cwd-level candidates', () => {
    expect(candidateContextPaths(resolve('/proj'), resolve('/proj'))).toEqual([
      resolve('/proj/AGENTS.md'),
      resolve('/proj/CLAUDE.md'),
    ]);
  });

  test('trailing separators on cwd are tolerated', () => {
    const paths = candidateContextPaths(resolve('/proj/tests/foo.ts'), resolve('/proj') + '/');

    expect(paths).toContain(resolve('/proj/AGENTS.md'));
    expect(paths).toContain(resolve('/proj/tests/AGENTS.md'));
  });

  test('default filename list is AGENTS.md, CLAUDE.md', () => {
    expect(DEFAULT_CONTEXT_FILE_NAMES).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// capContent
// ──────────────────────────────────────────────────────────────────────

describe('capContent', () => {
  test('short content returns untruncated', () => {
    const out = capContent('hello', 100);

    expect(out).toEqual({ content: 'hello', truncated: false });
  });

  test('content exactly at cap returns untruncated', () => {
    const out = capContent('abc', 3);

    expect(out).toEqual({ content: 'abc', truncated: false });
  });

  test('content over cap is truncated', () => {
    const out = capContent('abcdefgh', 3);

    expect(out.truncated).toBe(true);
    expect(out.content).toBe('abc');
  });

  test('truncation cuts at UTF-8 code-point boundary', () => {
    // '€' = 3 bytes in UTF-8 (0xE2 0x82 0xAC). Cap at 2 bytes should return '',
    // not a half-encoded character.
    const out = capContent('€x', 2);

    expect(out.truncated).toBe(true);
    expect(out.content).toBe('');
    // Output must be valid UTF-8.
    expect(Buffer.from(out.content, 'utf8').toString('utf8')).toBe(out.content);
  });

  test('truncation preserves whole multi-byte characters before cap', () => {
    // 'a€b' = 1 + 3 + 1 = 5 bytes. Cap at 4 bytes should return 'a€'.
    const out = capContent('a€b', 4);

    expect(out.truncated).toBe(true);
    expect(out.content).toBe('a€');
  });

  test('cap <= 0 truncates everything', () => {
    expect(capContent('abc', 0)).toEqual({ content: '', truncated: true });
    expect(capContent('', 0)).toEqual({ content: '', truncated: false });
  });

  test('DEFAULT_CONTEXT_FILE_BYTE_CAP is sane', () => {
    expect(DEFAULT_CONTEXT_FILE_BYTE_CAP).toBeGreaterThan(1024);
    expect(DEFAULT_CONTEXT_FILE_BYTE_CAP).toBeLessThanOrEqual(128 * 1024);
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatBytes
// ──────────────────────────────────────────────────────────────────────

describe('formatBytes', () => {
  test('sub-kilobyte uses bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('kilobytes use one decimal below 10 KB, none above', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(3967)).toBe('3.9 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(500 * 1024)).toBe('500 KB');
  });

  test('megabytes / gigabytes use one decimal below 10, none above', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  test('non-finite or negative inputs clamp to 0 B', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

// ──────────────────────────────────────────────────────────────────────
// displayPath
// ──────────────────────────────────────────────────────────────────────

describe('displayPath', () => {
  test('returns relative path for file inside cwd', () => {
    expect(displayPath(resolve('/proj/tests/AGENTS.md'), resolve('/proj'))).toBe('tests/AGENTS.md');
  });

  test('returns absolute path for file outside cwd', () => {
    const out = displayPath(resolve('/other/foo'), resolve('/proj'));

    // On POSIX this is '/other/foo'; on Windows it'd be a drive-absolute
    // path. Either way it should not start with '..'.
    expect(out.startsWith('..')).toBe(false);
    expect(out).not.toBe('foo');
  });

  test('returns "." for cwd itself', () => {
    expect(displayPath(resolve('/proj'), resolve('/proj'))).toBe('.');
  });

  test('normalizes separators to forward slash', () => {
    expect(displayPath(resolve('/proj/a/b/c'), resolve('/proj'))).toBe('a/b/c');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatContextInjection
// ──────────────────────────────────────────────────────────────────────

describe('formatContextInjection', () => {
  const cwd = resolve('/proj');

  test('empty input yields empty string', () => {
    expect(formatContextInjection([], cwd)).toBe('');
  });

  test('single file: includes header, preamble, tagged content', () => {
    const msg = formatContextInjection(
      [{ path: resolve('/proj/tests/AGENTS.md'), content: 'Follow X.\nFollow Y.' }],
      cwd,
    );

    expect(msg).toContain('Subdirectory context file discovered');
    expect(msg).toContain('`tests/AGENTS.md`');
    expect(msg).toContain('<context file="tests/AGENTS.md">');
    expect(msg).toContain('Follow X.');
    expect(msg).toContain('Follow Y.');
    expect(msg).toContain('</context>');
    expect(msg.trim().endsWith('</context>')).toBe(true);
  });

  test('multiple files: pluralizes header and lists all names', () => {
    const msg = formatContextInjection(
      [
        { path: resolve('/proj/AGENTS.md'), content: 'root' },
        { path: resolve('/proj/tests/AGENTS.md'), content: 'tests' },
      ],
      cwd,
    );

    expect(msg).toContain('Subdirectory context files discovered');
    expect(msg).toContain('`AGENTS.md`');
    expect(msg).toContain('`tests/AGENTS.md`');
    // Order of tags matches caller-provided order.
    expect(msg.indexOf('<context file="AGENTS.md">')).toBeLessThan(msg.indexOf('<context file="tests/AGENTS.md">'));
  });

  test('truncated flag emits hint', () => {
    const msg = formatContextInjection(
      [{ path: resolve('/proj/tests/AGENTS.md'), content: 'partial', truncated: true }],
      cwd,
    );

    expect(msg).toContain('[truncated');
    expect(msg).toContain('`tests/AGENTS.md`');
  });

  test('CRLF line endings are normalized to LF', () => {
    const msg = formatContextInjection([{ path: resolve('/proj/AGENTS.md'), content: 'a\r\nb\r\nc' }], cwd);

    expect(msg).not.toContain('\r');
    expect(msg).toContain('a\nb\nc');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Filesystem integration smoke test
// ──────────────────────────────────────────────────────────────────────

describe('candidateContextPaths integration (tmpdir)', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'subdir-agents-spec-'));
    mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'root');
    writeFileSync(join(root, 'tests', 'AGENTS.md'), 'tests');
    // CLAUDE.md symlinked to AGENTS.md at root - verifies callers can
    // dedupe via realpath (we don't test dedup here, just that the
    // candidate list still includes the symlinked name).
    symlinkSync(join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('lists all candidate paths for a deeply nested file', () => {
    const paths = candidateContextPaths(join(root, 'tests', 'unit', 'foo.spec.ts'), root);

    expect(paths).toContain(join(root, 'tests', 'unit', 'AGENTS.md'));
    expect(paths).toContain(join(root, 'tests', 'AGENTS.md'));
    expect(paths).toContain(join(root, 'AGENTS.md'));
    expect(paths).toContain(join(root, 'CLAUDE.md'));
  });
});
