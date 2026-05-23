/**
 * Tests for lib/node/pi/fs-safe.ts.
 *
 * Pure module - no pi runtime needed. Uses a tmpdir under `vitest`'s
 * working tree so we can exercise real fs paths without mocks.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  boundedReadFile,
  readJsonOrUndefined,
  readJsoncOrUndefined,
  readTextOrEmpty,
  readTextOrNull,
  safeStatSync,
} from '../../../../lib/node/pi/fs-safe.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fs-safe-spec-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// readTextOrNull
// ──────────────────────────────────────────────────────────────────────

describe('readTextOrNull', () => {
  test('returns file content as a string', () => {
    const p = join(tmp, 'a.txt');
    writeFileSync(p, 'hello world');

    expect(readTextOrNull(p)).toBe('hello world');
  });

  test('returns null for a missing path', () => {
    expect(readTextOrNull(join(tmp, 'nope.txt'))).toBeNull();
  });

  test('returns null for a directory path (EISDIR)', () => {
    expect(readTextOrNull(tmp)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// readTextOrEmpty
// ──────────────────────────────────────────────────────────────────────

describe('readTextOrEmpty', () => {
  test('returns file content as a string', () => {
    const p = join(tmp, 'a.txt');
    writeFileSync(p, 'hello world');

    expect(readTextOrEmpty(p)).toBe('hello world');
  });

  test('returns empty string for a missing path', () => {
    expect(readTextOrEmpty(join(tmp, 'nope.txt'))).toBe('');
  });

  test('returns empty string for a directory path (EISDIR)', () => {
    expect(readTextOrEmpty(tmp)).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
// safeStatSync
// ──────────────────────────────────────────────────────────────────────

describe('safeStatSync', () => {
  test('returns mtimeMs + size for an existing file', () => {
    const p = join(tmp, 'a.txt');
    writeFileSync(p, 'hello');

    const s = safeStatSync(p);
    expect(s).toBeDefined();
    expect(s?.size).toBe(5);
    expect(typeof s?.mtimeMs).toBe('number');
  });

  test('returns undefined for a missing path', () => {
    expect(safeStatSync(join(tmp, 'nope.txt'))).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// readJsonOrUndefined
// ──────────────────────────────────────────────────────────────────────

describe('readJsonOrUndefined', () => {
  test('parses well-formed JSON', () => {
    const p = join(tmp, 'a.json');
    writeFileSync(p, JSON.stringify({ x: 1 }));

    expect(readJsonOrUndefined(p)).toEqual({ x: 1 });
  });

  test('returns undefined for missing files', () => {
    expect(readJsonOrUndefined(join(tmp, 'nope.json'))).toBeUndefined();
  });

  test('returns undefined for malformed JSON', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{ not: json');

    expect(readJsonOrUndefined(p)).toBeUndefined();
  });

  test('returns undefined for JSONC-style comments (strict JSON.parse)', () => {
    const p = join(tmp, 'jsonc.json');
    writeFileSync(p, '// comment\n{"x": 1}');

    expect(readJsonOrUndefined(p)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// readJsoncOrUndefined
// ──────────────────────────────────────────────────────────────────────

describe('readJsoncOrUndefined', () => {
  test('parses well-formed JSON', () => {
    const p = join(tmp, 'a.json');
    writeFileSync(p, JSON.stringify({ x: 1 }));

    expect(readJsoncOrUndefined(p)).toEqual({ x: 1 });
  });

  test('tolerates // comments', () => {
    const p = join(tmp, 'jsonc.json');
    writeFileSync(p, '// pi settings\n{"x": 1}');

    expect(readJsoncOrUndefined(p)).toEqual({ x: 1 });
  });

  test('returns undefined for missing files', () => {
    expect(readJsoncOrUndefined(join(tmp, 'nope.json'))).toBeUndefined();
  });

  test('returns undefined for malformed input', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{ not: jsonc either');

    expect(readJsoncOrUndefined(p)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// boundedReadFile
// ──────────────────────────────────────────────────────────────────────

describe('boundedReadFile', () => {
  test('reads file content when under the byte cap', () => {
    const p = join(tmp, 'small.txt');
    writeFileSync(p, 'hello');

    const out = boundedReadFile(tmp, 'small.txt', 1024);
    expect(out.content).toBe('hello');
    expect(out.reason).toBeUndefined();
  });

  test('resolves relative paths against cwd', () => {
    const p = join(tmp, 'rel.txt');
    writeFileSync(p, 'rel');

    const out = boundedReadFile(tmp, 'rel.txt', 1024);
    expect(out.content).toBe('rel');
  });

  test('accepts absolute paths verbatim', () => {
    const p = join(tmp, 'abs.txt');
    writeFileSync(p, 'abs');

    const out = boundedReadFile('/some/other/cwd', p, 1024);
    expect(out.content).toBe('abs');
  });

  test('skips with reason when file exceeds maxBytes', () => {
    const p = join(tmp, 'big.txt');
    writeFileSync(p, 'x'.repeat(200));

    const out = boundedReadFile(tmp, 'big.txt', 100);
    expect(out.content).toBeUndefined();
    expect(out.reason).toMatch(/file too large \(200 > 100\)/);
  });

  test('skips with reason when stat fails (missing file)', () => {
    const out = boundedReadFile(tmp, 'nope.txt', 1024);
    expect(out.content).toBeUndefined();
    expect(out.reason).toMatch(/stat failed/);
  });
});
