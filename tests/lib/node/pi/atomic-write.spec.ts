/**
 * Tests for lib/node/pi/atomic-write.ts.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { atomicWriteFile, ensureDirSync } from '../../../../lib/node/pi/atomic-write.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-atomic-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('ensureDirSync', () => {
  test('creates nested directories and is idempotent', () => {
    const nested = join(cwd, 'a', 'b', 'c');

    ensureDirSync(nested);

    expect(existsSync(nested)).toBe(true);

    // Calling twice is a no-op.
    expect(() => ensureDirSync(nested)).not.toThrow();
  });
});

describe('atomicWriteFile', () => {
  test('writes contents', () => {
    const p = join(cwd, 'file.txt');
    atomicWriteFile(p, 'hello');

    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  test('accepts Buffer bodies', () => {
    const p = join(cwd, 'bin');
    atomicWriteFile(p, Buffer.from([0x00, 0x01, 0x02]));

    expect(readFileSync(p)).toEqual(Buffer.from([0x00, 0x01, 0x02]));
  });

  test('creates missing parent directories', () => {
    const p = join(cwd, 'nested', 'dir', 'out.txt');
    atomicWriteFile(p, 'x');

    expect(readFileSync(p, 'utf8')).toBe('x');
  });

  test('overwrites existing files', () => {
    const p = join(cwd, 'file.txt');
    writeFileSync(p, 'first');
    atomicWriteFile(p, 'second');

    expect(readFileSync(p, 'utf8')).toBe('second');
  });

  test('no tempfile is left behind after a successful write', () => {
    const p = join(cwd, 'file.txt');

    atomicWriteFile(p, 'clean');

    const remaining = readdirSync(cwd).filter((n) => n.includes('.tmp-'));

    expect(remaining).toEqual([]);
  });

  test('back-to-back writes in the same ms get distinct tempfiles', () => {
    // Regression: a static ".tmp" suffix (or a ms-granularity timestamp
    // without a counter) would let two writers race on the same tempfile.
    // The shared helper adds a monotonic counter per process.
    const p = join(cwd, 'race.txt');

    atomicWriteFile(p, 'a');
    atomicWriteFile(p, 'b');
    atomicWriteFile(p, 'c');

    expect(readFileSync(p, 'utf8')).toBe('c');

    const remaining = readdirSync(cwd).filter((n) => n.includes('.tmp-'));

    expect(remaining).toEqual([]);
  });
});
