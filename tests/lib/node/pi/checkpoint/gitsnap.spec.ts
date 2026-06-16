/**
 * Tests for lib/node/pi/checkpoint/gitsnap.ts.
 *
 * Pure module - git argv builders + output parsers for full mode. The
 * security-critical assertion is that the clean builders pass `-fd` and
 * NEVER `-x`, always scoped with `-- <paths>`.
 */

import { describe, expect, test } from 'vitest';

import {
  addAllArgs,
  checkoutArgs,
  cleanArgs,
  cleanDryRunArgs,
  parseCleanDryRun,
  parseNameOnly,
  sideGitDir,
  withinCaps,
} from '../../../../../lib/node/pi/checkpoint/gitsnap.ts';

const GD = '/store/git';
const WT = '/proj';

describe('argv builders', () => {
  test('sideGitDir nests under the store dir', () => {
    expect(sideGitDir('/store')).toBe('/store/git');
  });

  test('addAll carries git-dir + work-tree', () => {
    expect(addAllArgs(GD, WT)).toEqual(['--git-dir', GD, '--work-tree', WT, 'add', '-A']);
  });

  test('checkout is force + scoped to paths', () => {
    expect(checkoutArgs(GD, WT, 'abc123', ['a.ts', 'b.ts'])).toEqual([
      '--git-dir',
      GD,
      '--work-tree',
      WT,
      'checkout',
      '-f',
      'abc123',
      '--',
      'a.ts',
      'b.ts',
    ]);
  });

  test('clean uses -fd, never -x, and is scoped', () => {
    const args = cleanArgs(GD, WT, ['sub/']);
    expect(args).toContain('-fd');
    expect(args).not.toContain('-x');
    expect(args).not.toContain('-fdx');
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'sub/']);
  });

  test('clean dry-run uses -fdn, never -x', () => {
    const args = cleanDryRunArgs(GD, WT, ['sub/']);
    expect(args).toContain('-fdn');
    expect(args).not.toContain('-x');
  });
});

describe('parsers', () => {
  test('parseNameOnly splits NUL-delimited output', () => {
    expect(parseNameOnly('a.ts\0b/c.ts\0')).toEqual(['a.ts', 'b/c.ts']);
    expect(parseNameOnly('')).toEqual([]);
  });

  test('parseCleanDryRun extracts the would-remove paths', () => {
    const out = 'Would remove tmp/x.log\nWould remove build/\n';
    expect(parseCleanDryRun(out)).toEqual(['tmp/x.log', 'build/']);
  });
});

describe('withinCaps', () => {
  test('ok within both caps', () => {
    expect(withinCaps(['a', 'b'], 100, 10, 1000)).toEqual({ ok: true });
  });

  test('rejects over the file cap', () => {
    const d = withinCaps(['a', 'b', 'c'], 1, 2, 1000);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/staged files/);
  });

  test('rejects over the byte cap', () => {
    const d = withinCaps(['a'], 5000, 10, 1000);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/staged bytes/);
  });
});
