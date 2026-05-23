/**
 * Specs for `stub-refcount.ts` - the helper that lets the sandbox
 * extension track concurrent in-flight wraps that all touched the
 * same dangerous-file stubs, so per-command cleanup only unlinks
 * paths whose count has dropped to zero.
 */

import { describe, expect, test } from 'vitest';

import { decStubRefs, incStubRefs } from '../../../../../lib/node/pi/sandbox/stub-refcount.ts';

describe('incStubRefs', () => {
  test('initializes missing keys to 1', () => {
    const map = new Map<string, number>();
    incStubRefs(map, ['/a', '/b']);
    expect(map.get('/a')).toBe(1);
    expect(map.get('/b')).toBe(1);
  });

  test('accumulates for repeated paths across concurrent wraps', () => {
    const map = new Map<string, number>();
    incStubRefs(map, ['/a', '/b']);
    incStubRefs(map, ['/a']);
    incStubRefs(map, ['/a', '/c']);
    expect(map.get('/a')).toBe(3);
    expect(map.get('/b')).toBe(1);
    expect(map.get('/c')).toBe(1);
  });

  test('is a no-op for an empty path list', () => {
    const map = new Map<string, number>([['/a', 2]]);
    incStubRefs(map, []);
    expect(map.get('/a')).toBe(2);
    expect(map.size).toBe(1);
  });
});

describe('decStubRefs', () => {
  test('returns paths whose count drops to zero and deletes them from the map', () => {
    const map = new Map<string, number>([
      ['/a', 1],
      ['/b', 2],
    ]);
    const removed = decStubRefs(map, ['/a', '/b']);
    expect(removed).toEqual(['/a']);
    expect(map.has('/a')).toBe(false);
    expect(map.get('/b')).toBe(1);
  });

  test('keeps paths still referenced by another in-flight wrap', () => {
    // Two concurrent wraps both touched /a and /b. First completes:
    // refcount drops by one but stays > 0, so nothing is removed.
    const map = new Map<string, number>();
    incStubRefs(map, ['/a', '/b']);
    incStubRefs(map, ['/a', '/b']);
    expect(map.get('/a')).toBe(2);

    const removed = decStubRefs(map, ['/a', '/b']);
    expect(removed).toEqual([]);
    expect(map.get('/a')).toBe(1);
    expect(map.get('/b')).toBe(1);
  });

  test('treats missing keys as count=1 so a single decrement removes them', () => {
    // Defensive: if for some reason an inc was lost (process restart,
    // bug), a paired dec must not leave a -1 sitting in the map.
    const map = new Map<string, number>();
    const removed = decStubRefs(map, ['/orphan']);
    expect(removed).toEqual(['/orphan']);
    expect(map.has('/orphan')).toBe(false);
  });

  test('is a no-op for an empty path list', () => {
    const map = new Map<string, number>([['/a', 1]]);
    const removed = decStubRefs(map, []);
    expect(removed).toEqual([]);
    expect(map.get('/a')).toBe(1);
  });

  test('handles a mixed batch where only some entries hit zero', () => {
    const map = new Map<string, number>([
      ['/keep', 3],
      ['/drop', 1],
      ['/also-drop', 1],
    ]);
    const removed = decStubRefs(map, ['/keep', '/drop', '/also-drop']);
    expect(removed.sort()).toEqual(['/also-drop', '/drop']);
    expect(map.get('/keep')).toBe(2);
    expect(map.has('/drop')).toBe(false);
    expect(map.has('/also-drop')).toBe(false);
  });
});

describe('inc + dec roundtrip', () => {
  test('two concurrent wraps each clean up only the stubs unique to themselves', () => {
    const map = new Map<string, number>();
    // Wrap A touches /shared and /a-only.
    const aTouched = ['/shared', '/a-only'];
    incStubRefs(map, aTouched);
    // Wrap B starts before A finishes; touches /shared and /b-only.
    const bTouched = ['/shared', '/b-only'];
    incStubRefs(map, bTouched);

    // A finishes first: only /a-only is safe to remove (B still uses /shared).
    const aRemoved = decStubRefs(map, aTouched);
    expect(aRemoved).toEqual(['/a-only']);
    expect(map.get('/shared')).toBe(1);

    // B finishes: /shared and /b-only both drop to 0.
    const bRemoved = decStubRefs(map, bTouched);
    expect(bRemoved.sort()).toEqual(['/b-only', '/shared']);
    expect(map.size).toBe(0);
  });
});
