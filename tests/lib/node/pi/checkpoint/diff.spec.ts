/**
 * Tests for lib/node/pi/checkpoint/diff.ts.
 *
 * Pure module - line add/del counts going current → target. Pins whole-file
 * add/delete, the LCS-based middle count, empty-file handling, and the
 * multiset fallback path for very large middles.
 */

import { describe, expect, test } from 'vitest';

import { countDiff, formatDiffForRender, unifiedDiffLines } from '../../../../../lib/node/pi/checkpoint/diff.ts';

describe('countDiff', () => {
  test('both absent → zero', () => {
    expect(countDiff(null, null)).toEqual({ adds: 0, dels: 0 });
  });

  test('whole-file add (current absent)', () => {
    expect(countDiff(null, 'a\nb\nc')).toEqual({ adds: 3, dels: 0 });
  });

  test('whole-file delete (target absent)', () => {
    expect(countDiff('a\nb', null)).toEqual({ adds: 0, dels: 2 });
  });

  test('identical content → zero', () => {
    expect(countDiff('a\nb\nc', 'a\nb\nc')).toEqual({ adds: 0, dels: 0 });
  });

  test('empty string is zero lines, not one', () => {
    expect(countDiff('', '')).toEqual({ adds: 0, dels: 0 });
    expect(countDiff('', 'x')).toEqual({ adds: 1, dels: 0 });
  });

  test('a trailing newline does not count as an extra line', () => {
    // "a\nb\n" is two lines, not three - the terminating newline closes the
    // last line rather than starting a new empty one.
    expect(countDiff(null, 'a\nb\n')).toEqual({ adds: 2, dels: 0 });
    expect(countDiff('a\nb\n', null)).toEqual({ adds: 0, dels: 2 });
    // Adding a final newline to an otherwise-identical file is a no-op count.
    expect(countDiff('a\nb', 'a\nb\n')).toEqual({ adds: 0, dels: 0 });
  });

  test('single line change counts one add + one del', () => {
    expect(countDiff('a\nb\nc', 'a\nB\nc')).toEqual({ adds: 1, dels: 1 });
  });

  test('insertion in the middle is adds only', () => {
    expect(countDiff('a\nc', 'a\nb\nc')).toEqual({ adds: 1, dels: 0 });
  });

  test('removal in the middle is dels only', () => {
    expect(countDiff('a\nb\nc', 'a\nc')).toEqual({ adds: 0, dels: 1 });
  });

  test('large middle falls back to multiset count without throwing', () => {
    const current = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const target = Array.from({ length: 4000 }, (_, i) => (i % 2 === 0 ? `line ${i}` : `LINE ${i}`)).join('\n');
    const counts = countDiff(current, target);
    // 2000 lines changed → 2000 adds + 2000 dels under the multiset count.
    expect(counts.adds).toBeGreaterThan(0);
    expect(counts.dels).toBeGreaterThan(0);
  });
});

describe('unifiedDiffLines + formatDiffForRender', () => {
  test('identical content → no lines', () => {
    expect(unifiedDiffLines('a\nb', 'a\nb')).toEqual([]);
  });

  test('single line change emits a removed + added pair with context', () => {
    const lines = unifiedDiffLines('a\nb\nc', 'a\nB\nc');
    const removed = lines.find((l) => l.prefix === '-');
    const added = lines.find((l) => l.prefix === '+');
    expect(removed?.text).toBe('b');
    expect(added?.text).toBe('B');
    // surrounding context preserved
    expect(lines.filter((l) => l.prefix === ' ').map((l) => l.text)).toEqual(['a', 'c']);
  });

  test('whole-file add emits only added lines', () => {
    const lines = unifiedDiffLines(null, 'x\ny');
    expect(lines.every((l) => l.prefix === '+')).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(['x', 'y']);
  });

  test('formatDiffForRender produces renderDiff-parseable lines', () => {
    const text = formatDiffForRender(unifiedDiffLines('a\nb\nc', 'a\nB\nc'));
    // 1-based numbering, prefix + number + space + content; matches the
    // regex pi's renderDiff uses: /^([+-\s])(\s*\d*)\s(.*)$/
    for (const line of text.split('\n')) {
      expect(line).toMatch(/^([+\-\s])(\s*\d*)\s(.*)$/);
    }
    expect(text).toContain('-2 b');
    expect(text).toContain('+2 B');
  });

  test('large changed middle degrades to a block diff without throwing', () => {
    const current = Array.from({ length: 5000 }, (_, i) => `x${i}`).join('\n');
    const target = Array.from({ length: 5000 }, (_, i) => `y${i}`).join('\n');
    const lines = unifiedDiffLines(current, target);
    expect(lines.some((l) => l.prefix === '-')).toBe(true);
    expect(lines.some((l) => l.prefix === '+')).toBe(true);
  });
});
