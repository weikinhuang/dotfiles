/**
 * Tests for lib/node/pi/roleplay/paths.ts.
 *
 * Exercises the disk layer against an explicit temp root (no env, no pi).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  atomicWriteFile,
  castDir,
  fileFor,
  indexFileFor,
  listCasts,
  readEntryBody,
  rebuildCast,
  removeFileIfExists,
  scanCast,
  writeIndex,
} from '../../../../../lib/node/pi/roleplay/paths.ts';
import { serializeEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rp-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeChar(cast: string, slug: string, name: string, body: string): void {
  atomicWriteFile(
    fileFor(cast, 'character', slug, root),
    serializeEntry({ name, description: `d ${slug}`, kind: 'character', body }),
  );
}

test('scanCast parses well-formed files and reports the cast empty otherwise', () => {
  expect(scanCast('pl', root)).toEqual({ entries: [], warnings: [] });
  writeChar('pl', 'exusiai', 'Exusiai', 'Voice: bright.');
  const { entries, warnings } = scanCast('pl', root);
  expect(warnings).toEqual([]);
  expect(entries).toEqual([{ id: 'exusiai', kind: 'character', name: 'Exusiai', description: 'd exusiai' }]);
});

test('scanCast warns on malformed frontmatter without blinding the rest', () => {
  writeChar('pl', 'good', 'Good', 'ok');
  atomicWriteFile(fileFor('pl', 'character', 'bad', root), 'no frontmatter at all');
  const { entries, warnings } = scanCast('pl', root);
  expect(entries.map((e) => e.id)).toEqual(['good']);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('malformed frontmatter');
});

test('readEntryBody returns the body, null when absent', () => {
  writeChar('pl', 'exusiai', 'Exusiai', 'Voice: bright.');
  const { entries } = scanCast('pl', root);
  expect(readEntryBody('pl', entries[0], root)!.trim()).toBe('Voice: bright.');
  expect(readEntryBody('pl', { id: 'ghost', kind: 'character', name: 'x', description: 'y' }, root)).toBeNull();
});

test('rebuildCast + writeIndex produce a readable INDEX.md', () => {
  writeChar('pl', 'exusiai', 'Exusiai', 'b');
  const { state } = rebuildCast('pl', root);
  writeIndex(state, root);
  const md = readFileSync(indexFileFor('pl', root), 'utf8');
  expect(md).toContain('# Roleplay cast: pl');
  expect(md).toContain('[Exusiai](character/exusiai.md)');
});

test('removeFileIfExists reports whether it deleted', () => {
  writeChar('pl', 'exusiai', 'Exusiai', 'b');
  expect(removeFileIfExists(fileFor('pl', 'character', 'exusiai', root))).toBe(true);
  expect(removeFileIfExists(fileFor('pl', 'character', 'exusiai', root))).toBe(false);
});

test('listCasts returns sorted cast dir names', () => {
  expect(listCasts(root)).toEqual([]);
  writeChar('texas-cast', 'a', 'A', 'b');
  writeChar('exusiai-cast', 'a', 'A', 'b');
  expect(listCasts(root)).toEqual(['exusiai-cast', 'texas-cast']);
  // sanity: the cast dir actually exists where we expect.
  expect(castDir('pl', root)).toBe(join(root, 'casts', 'pl'));
});
