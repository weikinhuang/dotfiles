/**
 * Tests for lib/node/pi/checkpoint/format.ts - the `/rewind list` body and
 * the out-of-sync widget line.
 */

import { describe, expect, test } from 'vitest';

import { formatCheckpointList, outOfSyncWidgetText } from '../../../../../lib/node/pi/checkpoint/format.ts';
import type { CheckpointManifest } from '../../../../../lib/node/pi/checkpoint/types.ts';

function manifest(leafEntryId: string, timestamp: number, paths: string[]): CheckpointManifest {
  return {
    leafEntryId,
    timestamp,
    entries: paths.map((path) => ({ path, before: null, after: 'h', tool: 'write', toolCallId: 't' })),
  };
}

describe('formatCheckpointList', () => {
  test('renders a header plus one line per manifest, newest first', () => {
    const out = formatCheckpointList([manifest('older', 1000, ['a.txt']), manifest('newer', 2000, ['a.txt', 'b.txt'])]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Checkpoints (anchor · time · files):');
    // Newest manifest sorts first.
    expect(lines[1].startsWith('newer')).toBe(true);
    expect(lines[1]).toContain('2 files');
    expect(lines[2].startsWith('older')).toBe(true);
    expect(lines[2]).toContain('1 file');
  });

  test('deduplicates repeated paths in the file count', () => {
    const out = formatCheckpointList([manifest('anchor', 1, ['a.txt', 'a.txt', 'b.txt'])]);
    expect(out).toContain('2 files');
  });
});

describe('outOfSyncWidgetText', () => {
  test('pluralizes the file count', () => {
    expect(outOfSyncWidgetText(1)).toBe('⚠ code ahead of conversation - /rewind to review (1 file)');
    expect(outOfSyncWidgetText(3)).toBe('⚠ code ahead of conversation - /rewind to review (3 files)');
  });
});
