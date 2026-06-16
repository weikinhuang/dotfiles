/**
 * Tests for lib/node/pi/checkpoint/conflict.ts.
 *
 * Pure module - classifies a resolved target against the file's disk hash.
 * Pins the three-way rule, the no-op-wins-over-clean precedence, and the
 * null (absent) handling on both disk and target sides.
 */

import { describe, expect, test } from 'vitest';

import { classifyFile, classifyTargets } from '../../../../../lib/node/pi/checkpoint/conflict.ts';
import type { FileTarget } from '../../../../../lib/node/pi/checkpoint/types.ts';

const t = (target: string | null, expectedCurrent: string | null): FileTarget => ({
  path: 'f.ts',
  target,
  expectedCurrent,
});

describe('classifyFile', () => {
  test('disk == target → no-op', () => {
    expect(classifyFile(t('h0', 'h2'), 'h0')).toBe('no-op');
  });

  test('disk == expectedCurrent → clean-restore', () => {
    expect(classifyFile(t('h0', 'h2'), 'h2')).toBe('clean-restore');
  });

  test('disk matches neither → conflict', () => {
    expect(classifyFile(t('h0', 'h2'), 'h5')).toBe('conflict');
  });

  test('no-op wins when target == expectedCurrent and disk matches', () => {
    expect(classifyFile(t('h0', 'h0'), 'h0')).toBe('no-op');
  });

  test('absent target: disk absent → no-op, disk present matching old → clean-restore', () => {
    expect(classifyFile(t(null, 'h2'), null)).toBe('no-op');
    expect(classifyFile(t(null, 'h2'), 'h2')).toBe('clean-restore');
    expect(classifyFile(t(null, 'h2'), 'h9')).toBe('conflict');
  });

  test('absent expectedCurrent (file was created): disk absent → clean-restore-to-delete path', () => {
    // target h1, expectedCurrent null (file didn't exist at old leaf): disk
    // absent matches expectedCurrent → clean-restore (we'll create it).
    expect(classifyFile(t('h1', null), null)).toBe('clean-restore');
    expect(classifyFile(t('h1', null), 'h1')).toBe('no-op');
  });
});

describe('classifyTargets', () => {
  test('uses the disk hash map and treats a missing key as absent', () => {
    const targets: FileTarget[] = [
      { path: 'a.ts', target: 'h0', expectedCurrent: 'h1' },
      { path: 'b.ts', target: 'h0', expectedCurrent: 'h1' },
    ];
    const disk = new Map<string, string | null>([['a.ts', 'h1']]); // b.ts missing → absent
    const out = classifyTargets(targets, disk);
    expect(out.map((c) => [c.target.path, c.status, c.diskHash])).toEqual([
      ['a.ts', 'clean-restore', 'h1'],
      ['b.ts', 'conflict', null],
    ]);
  });
});
