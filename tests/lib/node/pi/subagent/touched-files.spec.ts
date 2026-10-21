/**
 * Tests for lib/node/pi/subagent/touched-files.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  pathsFromPatch,
  recordTouchedFiles,
  touchedPathsFromToolCall,
} from '../../../../../lib/node/pi/subagent/touched-files.ts';

describe('touchedPathsFromToolCall', () => {
  test('write / edit report their `path` arg', () => {
    expect(touchedPathsFromToolCall('write', { path: 'src/a.ts', content: 'x' })).toEqual(['src/a.ts']);
    expect(touchedPathsFromToolCall('edit', { path: ' src/b.ts ', edits: [] })).toEqual(['src/b.ts']);
  });

  test('read-only tools, bash, and malformed args report nothing', () => {
    expect(touchedPathsFromToolCall('read', { path: 'src/a.ts' })).toEqual([]);
    expect(touchedPathsFromToolCall('bash', { command: 'echo hi > out.txt' })).toEqual([]);
    expect(touchedPathsFromToolCall('write', { path: '' })).toEqual([]);
    expect(touchedPathsFromToolCall('write', null)).toEqual([]);
    expect(touchedPathsFromToolCall('edit', { path: 42 })).toEqual([]);
    expect(touchedPathsFromToolCall(undefined, { path: 'x' })).toEqual([]);
  });

  test('apply_patch reports every op header', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: lib/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: lib/new.ts',
      '+hello',
      '*** Delete File: lib/gone.ts',
      '*** Move File: lib/from.ts -> lib/to.ts',
      '*** End Patch',
    ].join('\n');
    expect(touchedPathsFromToolCall('apply_patch', { patch })).toEqual([
      'lib/a.ts',
      'lib/new.ts',
      'lib/gone.ts',
      'lib/from.ts',
      'lib/to.ts',
    ]);
    expect(touchedPathsFromToolCall('apply_patch', { patch: 7 })).toEqual([]);
  });
});

describe('pathsFromPatch', () => {
  test('tolerates CRLF and ignores body lines that only look similar', () => {
    expect(pathsFromPatch('*** Update File: a.ts\r\n+*** Add File: not-a-header\r\n')).toEqual(['a.ts']);
  });
});

describe('recordTouchedFiles', () => {
  test('de-duplicates while keeping first-seen order', () => {
    const set = new Set<string>();
    recordTouchedFiles(set, 'edit', { path: 'b.ts' });
    recordTouchedFiles(set, 'write', { path: 'a.ts' });
    recordTouchedFiles(set, 'edit', { path: 'b.ts' });
    recordTouchedFiles(set, 'read', { path: 'c.ts' });
    expect([...set]).toEqual(['b.ts', 'a.ts']);
  });
});
