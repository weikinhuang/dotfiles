/**
 * Tests for lib/node/pi/subagent/sweep-fs.ts - the Node `fs` adapter that
 * backs the {@link SweepFs} shape. Exercises the real filesystem against a
 * temp dir and asserts the best-effort error swallowing (missing paths yield
 * `null` / `false` rather than throwing).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { makeSweepFs } from '../../../../../lib/node/pi/subagent/sweep-fs.ts';

describe('makeSweepFs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-fs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('readdir lists directory entries and returns null for a missing path', () => {
    const fs = makeSweepFs();
    writeFileSync(join(dir, 'a.jsonl'), 'x');
    mkdirSync(join(dir, 'sub'));

    expect(fs.readdir(dir)?.sort()).toEqual(['a.jsonl', 'sub']);
    expect(fs.readdir(join(dir, 'does-not-exist'))).toBeNull();
  });

  test('stat reports file vs directory and returns null for a missing path', () => {
    const fs = makeSweepFs();
    const file = join(dir, 'f.jsonl');
    writeFileSync(file, 'x');
    mkdirSync(join(dir, 'd'));

    const fst = fs.stat(file);
    expect(fst?.isFile).toBe(true);
    expect(fst?.isDirectory).toBe(false);
    expect(typeof fst?.mtimeMs).toBe('number');

    const dst = fs.stat(join(dir, 'd'));
    expect(dst?.isDirectory).toBe(true);
    expect(dst?.isFile).toBe(false);

    expect(fs.stat(join(dir, 'missing'))).toBeNull();
  });

  test('remove deletes a file and returns false when the target is absent', () => {
    const fs = makeSweepFs();
    const file = join(dir, 'gone.jsonl');
    writeFileSync(file, 'x');

    expect(fs.remove(file)).toBe(true);
    expect(fs.stat(file)).toBeNull();
    // Second remove of the now-missing file is a best-effort false.
    expect(fs.remove(file)).toBe(false);
  });
});
