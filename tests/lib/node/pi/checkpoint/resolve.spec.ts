/**
 * Tests for lib/node/pi/checkpoint/resolve.ts - the undo + redo via
 * common-ancestor core. Pins the leg split for backward / forward /
 * cross-branch / disjoint moves, the per-file target + expectedCurrent
 * computation through multi-step legs, and the tree-mutation edge
 * (navigate to a user message, then roll forward) by re-resolving purely
 * from the paths each move hands in.
 */

import { describe, expect, test } from 'vitest';

import { computeFileTargets, resolveFileTargets, resolveLegs } from '../../../../../lib/node/pi/checkpoint/resolve.ts';
import type { CheckpointEntry, CheckpointManifest } from '../../../../../lib/node/pi/checkpoint/types.ts';

function entry(path: string, before: string | null, after: string | null): CheckpointEntry {
  return { path, before, after, tool: 'write', toolCallId: `tc-${path}-${before}-${after}` };
}

function manifest(leafEntryId: string, entries: CheckpointEntry[]): CheckpointManifest {
  return { leafEntryId, timestamp: 0, entries };
}

describe('resolveLegs', () => {
  test('cross-branch jump splits at the common ancestor', () => {
    expect(resolveLegs(['r', 'a', 'b', 'c'], ['r', 'a', 'd'])).toEqual({
      commonAncestorId: 'a',
      undo: ['c', 'b'],
      redo: ['d'],
    });
  });

  test('backward nav has an empty redo leg', () => {
    expect(resolveLegs(['r', 'a', 'b', 'c'], ['r', 'a'])).toEqual({
      commonAncestorId: 'a',
      undo: ['c', 'b'],
      redo: [],
    });
  });

  test('forward nav has an empty undo leg', () => {
    expect(resolveLegs(['r', 'a'], ['r', 'a', 'b', 'c'])).toEqual({
      commonAncestorId: 'a',
      undo: [],
      redo: ['b', 'c'],
    });
  });

  test('disjoint paths have no common ancestor', () => {
    expect(resolveLegs(['x'], ['y'])).toEqual({ commonAncestorId: undefined, undo: ['x'], redo: ['y'] });
  });

  test('identical leaf is a no-op (both legs empty)', () => {
    expect(resolveLegs(['r', 'a'], ['r', 'a'])).toEqual({ commonAncestorId: 'a', undo: [], redo: [] });
  });
});

describe('computeFileTargets', () => {
  test('backward nav: target = ancestor before, expectedCurrent = old after', () => {
    const undo = [manifest('b', [entry('f.ts', 'h0', 'h1')])];
    const [t] = computeFileTargets(undo, []);
    expect(t).toEqual({ path: 'f.ts', target: 'h0', expectedCurrent: 'h1' });
  });

  test('forward nav: target = new after, expectedCurrent = ancestor before', () => {
    const redo = [manifest('b', [entry('f.ts', 'h0', 'h1')])];
    const [t] = computeFileTargets([], redo);
    expect(t).toEqual({ path: 'f.ts', target: 'h1', expectedCurrent: 'h0' });
  });

  test('multi-step undo collapses to newest-after / oldest-before', () => {
    // f edited h0→h1 (b1) then h1→h2 (b2); undo is newest-first.
    const undo = [manifest('b2', [entry('f.ts', 'h1', 'h2')]), manifest('b1', [entry('f.ts', 'h0', 'h1')])];
    const [t] = computeFileTargets(undo, []);
    expect(t).toEqual({ path: 'f.ts', target: 'h0', expectedCurrent: 'h2' });
  });

  test('cross-branch: file on both legs uses ancestor before from redo, new after from redo', () => {
    const undo = [manifest('b2', [entry('f.ts', 'h1', 'h2')]), manifest('b1', [entry('f.ts', 'h0', 'h1')])];
    const redo = [manifest('d1', [entry('f.ts', 'h0', 'h9')])];
    const [t] = computeFileTargets(undo, redo);
    expect(t).toEqual({ path: 'f.ts', target: 'h9', expectedCurrent: 'h2' });
  });

  test('cross-branch: file only on undo leg restores to ancestor', () => {
    const undo = [manifest('b2', [entry('f2.ts', 'h1', 'h2')]), manifest('b1', [entry('f2.ts', 'h0', 'h1')])];
    const redo = [manifest('d1', [entry('other.ts', null, 'z1')])];
    const targets = computeFileTargets(undo, redo);
    expect(targets.find((t) => t.path === 'f2.ts')).toEqual({ path: 'f2.ts', target: 'h0', expectedCurrent: 'h2' });
  });

  test('absent-file markers survive (before/after null)', () => {
    // file created on redo leg: ancestor absent → target = created content.
    const redo = [manifest('d1', [entry('new.ts', null, 'n1')])];
    const [t] = computeFileTargets([], redo);
    expect(t).toEqual({ path: 'new.ts', target: 'n1', expectedCurrent: null });
  });

  test('rows are sorted by path', () => {
    const redo = [manifest('d', [entry('z.ts', null, '1'), entry('a.ts', null, '2')])];
    expect(computeFileTargets([], redo).map((t) => t.path)).toEqual(['a.ts', 'z.ts']);
  });
});

describe('resolveFileTargets (end-to-end) + tree-mutation edge', () => {
  const manifests = [
    manifest('a', [entry('f.ts', null, 'h0')]),
    manifest('b', [entry('f.ts', 'h0', 'h1')]),
    manifest('c', [entry('f.ts', 'h1', 'h2')]),
  ];

  test('navigate back to a user message (leaf → ancestor a), then roll forward to c', () => {
    // move 1: old leaf c → new leaf a (back).
    const back = resolveFileTargets(['r', 'a', 'b', 'c'], ['r', 'a'], manifests);
    expect(back.legs.undo).toEqual(['c', 'b']);
    // at c, f is h2; restoring to a means f → h0.
    expect(back.targets.find((t) => t.path === 'f.ts')).toEqual({ path: 'f.ts', target: 'h0', expectedCurrent: 'h2' });

    // move 2: old leaf a → new leaf c (roll forward) - resolved purely from
    // the new paths, no cached leaf state.
    const fwd = resolveFileTargets(['r', 'a'], ['r', 'a', 'b', 'c'], manifests);
    expect(fwd.legs.redo).toEqual(['b', 'c']);
    expect(fwd.targets.find((t) => t.path === 'f.ts')).toEqual({ path: 'f.ts', target: 'h2', expectedCurrent: 'h0' });
  });
});
