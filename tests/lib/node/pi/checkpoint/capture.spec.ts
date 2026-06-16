/**
 * Tests for lib/node/pi/checkpoint/capture.ts.
 *
 * Pure module - maps a tool_call input to the paths to snapshot. Pins the
 * write/edit single-path read, the apply_patch fan-out, and the defensive
 * [] for malformed input.
 */

import { describe, expect, test } from 'vitest';

import { capturePaths } from '../../../../../lib/node/pi/checkpoint/capture.ts';

describe('capturePaths', () => {
  test('write → single non-removed path from input.path', () => {
    expect(capturePaths('write', { path: 'a/b.ts', content: 'x' })).toEqual([{ path: 'a/b.ts', removed: false }]);
  });

  test('edit → single non-removed path from input.path', () => {
    expect(capturePaths('edit', { path: 'a/b.ts', edits: [] })).toEqual([{ path: 'a/b.ts', removed: false }]);
  });

  test('apply_patch → fans out to every affected path', () => {
    const patch = '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Delete File: b.ts\n*** End Patch';
    expect(capturePaths('apply_patch', { patch })).toEqual([
      { path: 'a.ts', removed: false },
      { path: 'b.ts', removed: true },
    ]);
  });

  test('missing / wrong-typed input → []', () => {
    expect(capturePaths('write', null)).toEqual([]);
    expect(capturePaths('write', {})).toEqual([]);
    expect(capturePaths('write', { path: 42 })).toEqual([]);
    expect(capturePaths('apply_patch', { patch: '' })).toEqual([]);
  });
});
