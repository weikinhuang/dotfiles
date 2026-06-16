/**
 * Tests for lib/node/pi/checkpoint/patch-paths.ts.
 *
 * Pure module - reuses the apply-patch parser to enumerate the paths a
 * Codex patch touches. Pins Add/Update/Delete and the Move-touches-both-ends
 * behavior, plus the malformed-patch → [] contract.
 */

import { describe, expect, test } from 'vitest';

import { patchAffectedPaths } from '../../../../../lib/node/pi/checkpoint/patch-paths.ts';

function wrap(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

describe('patchAffectedPaths', () => {
  test('Add File → one created path', () => {
    expect(patchAffectedPaths(wrap('*** Add File: src/new.ts\n+hello'))).toEqual([
      { path: 'src/new.ts', removed: false },
    ]);
  });

  test('Update File → one path, not removed', () => {
    const patch = wrap('*** Update File: src/a.ts\n@@\n-old\n+new');
    expect(patchAffectedPaths(patch)).toEqual([{ path: 'src/a.ts', removed: false }]);
  });

  test('Delete File → one removed path', () => {
    expect(patchAffectedPaths(wrap('*** Delete File: gone.ts'))).toEqual([{ path: 'gone.ts', removed: true }]);
  });

  test('Move File → source removed + destination created', () => {
    const patch = wrap('*** Move File: old/path.ts -> new/path.ts\n@@\n-a\n+b');
    expect(patchAffectedPaths(patch)).toEqual([
      { path: 'old/path.ts', removed: true },
      { path: 'new/path.ts', removed: false },
    ]);
  });

  test('multiple ops in one patch are all enumerated', () => {
    const patch = wrap('*** Add File: a.ts\n+x\n*** Delete File: b.ts');
    expect(patchAffectedPaths(patch)).toEqual([
      { path: 'a.ts', removed: false },
      { path: 'b.ts', removed: true },
    ]);
  });

  test('malformed patch yields []', () => {
    expect(patchAffectedPaths('not a patch')).toEqual([]);
    expect(patchAffectedPaths('')).toEqual([]);
  });
});
