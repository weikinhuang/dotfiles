/**
 * Tests for lib/node/pi/roleplay/paths.ts.
 *
 * Exercises the disk layer against an explicit temp root (no env, no pi).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { existsSync } from 'node:fs';

import {
  archiveCarryOver,
  archiveFacts,
  archiveFile,
  atomicWriteFile,
  castDir,
  factFile,
  factsArchiveDir,
  fileFor,
  indexFileFor,
  listCasts,
  listFactSidecars,
  readEntryBody,
  rebuildCast,
  removeFileIfExists,
  portraitPath,
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

test('portraitPath builds <cast>/portraits/<slug>.png under the root', () => {
  expect(portraitPath('pl', 'exusiai', root)).toBe(join(root, 'casts', 'pl', 'portraits', 'exusiai.png'));
});

test('scanCast carries relationship metadata onto the entry', () => {
  atomicWriteFile(
    fileFor('pl', 'relationship', 'pair', root),
    serializeEntry({
      name: 'Pair',
      description: 'warm',
      kind: 'relationship',
      body: 'rapport',
      relationship: { affinity: 80, trust: 'high', lastInteraction: '2026-06-01', openThreads: ['the invite'] },
    }),
  );
  const { entries, warnings } = scanCast('pl', root);
  expect(warnings).toEqual([]);
  expect(entries).toHaveLength(1);
  expect(entries[0].kind).toBe('relationship');
  expect(entries[0].relationship).toStrictEqual({
    affinity: 80,
    trust: 'high',
    lastInteraction: '2026-06-01',
    openThreads: ['the invite'],
  });
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

test('scanCast reads only top-level carry-over auto.md, skipping archive/', () => {
  atomicWriteFile(
    fileFor('pl', 'summary', 'auto', root),
    serializeEntry({ name: 'Auto recap', description: 'carry-over', kind: 'summary', body: 'carry body' }),
  );
  // Only the top-level carry-over auto.md is scanned.
  const { entries } = scanCast('pl', root);
  expect(entries.map((e) => e.id)).toEqual(['auto']);
});

test('archiveCarryOver moves <kind>/auto.md into archive/<ts>.md', () => {
  expect(archiveCarryOver('pl', 'summary', '20260101T000000', root)).toBe(false);
  atomicWriteFile(
    fileFor('pl', 'summary', 'auto', root),
    serializeEntry({ name: 'Auto recap', description: 'd', kind: 'summary', body: 'body' }),
  );
  expect(archiveCarryOver('pl', 'summary', '20260101T000000', root)).toBe(true);
  expect(existsSync(fileFor('pl', 'summary', 'auto', root))).toBe(false);
  expect(existsSync(archiveFile('pl', 'summary', '20260101T000000', root))).toBe(true);
});

test('fact sidecars: list, then archive clears them', () => {
  expect(listFactSidecars('pl', root)).toEqual([]);
  atomicWriteFile(
    factFile('pl', 'user-allergic', root),
    serializeEntry({
      name: 'User is allergic to shellfish',
      description: 'stated over dinner',
      kind: 'summary',
      body: '',
    }),
  );
  atomicWriteFile(
    factFile('pl', 'mira-thursday', root),
    serializeEntry({ name: 'Mira visits Thursday 6pm', description: 'planned', kind: 'summary', body: '' }),
  );
  const facts = listFactSidecars('pl', root);
  expect(facts.map((f) => f.slug)).toEqual(['mira-thursday', 'user-allergic']);
  expect(facts[1].name).toBe('User is allergic to shellfish');

  expect(archiveFacts('pl', '20260101T000000', root)).toBe(2);
  expect(listFactSidecars('pl', root)).toEqual([]);
  expect(existsSync(join(factsArchiveDir('pl', '20260101T000000', root), 'user-allergic.md'))).toBe(true);
});

test('listCasts returns sorted cast dir names', () => {
  expect(listCasts(root)).toEqual([]);
  writeChar('texas-cast', 'a', 'A', 'b');
  writeChar('exusiai-cast', 'a', 'A', 'b');
  expect(listCasts(root)).toEqual(['exusiai-cast', 'texas-cast']);
  // sanity: the cast dir actually exists where we expect.
  expect(castDir('pl', root)).toBe(join(root, 'casts', 'pl'));
});
