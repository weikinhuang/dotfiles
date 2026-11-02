/**
 * Regression: collision-proof carry-over archives and lore-bundle name
 * validation in lib/node/pi/roleplay/paths.ts. All I/O is under a fresh
 * mkdtemp root.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  archiveCarryOver,
  archiveDir,
  archiveFacts,
  factFile,
  factsArchiveDir,
  factsDir,
  fileFor,
  isSafeLoreBundleName,
  loreBundleDir,
  scanCast,
} from '../../../../../../lib/node/pi/roleplay/paths.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roleplay-paths-review-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('paths-review: two newscene archives with the same second-resolution stamp keep both carry-overs', () => {
  const ts = '20261102T100000Z';
  put(fileFor('c', 'summary', 'auto', root), 'first recap');
  expect(archiveCarryOver('c', 'summary', ts, root)).toBe(true);
  put(fileFor('c', 'summary', 'auto', root), 'second recap');
  expect(archiveCarryOver('c', 'summary', ts, root)).toBe(true);
  const names = readdirSync(archiveDir('c', 'summary', root)).toSorted();
  expect(names).toEqual([`${ts}.md`, `${ts}_02.md`]);
  // Lexical order == archive order, so a reverse listing stays newest-first.
  expect(names.map((n) => readFileSync(join(archiveDir('c', 'summary', root), n), 'utf8'))).toEqual([
    'first recap',
    'second recap',
  ]);
  expect(archiveCarryOver('c', 'summary', ts, root)).toBe(false); // nothing left to archive
});

test('paths-review: two fact archives with the same stamp keep both generations of a same-slug sidecar', () => {
  const ts = '20261102T100000Z';
  put(factFile('c', 'allergy', root), 'gen1');
  archiveFacts('c', ts, root);
  put(factFile('c', 'allergy', root), 'gen2');
  archiveFacts('c', ts, root);
  const archiveRoot = join(factsDir('c', root), 'archive');
  expect(readdirSync(archiveRoot).toSorted()).toEqual([ts, `${ts}_02`]);
  expect(readFileSync(join(factsArchiveDir('c', ts, root), 'allergy.md'), 'utf8')).toBe('gen1');
  expect(readFileSync(join(archiveRoot, `${ts}_02`, 'allergy.md'), 'utf8')).toBe('gen2');
  expect(existsSync(factFile('c', 'allergy', root))).toBe(false);
});

test('paths-review: lore bundle names must stay under lore/', () => {
  for (const ok of ['loft', 'home/loft', 'winter-arc', 'a.b']) expect(isSafeLoreBundleName(ok)).toBe(true);
  for (const bad of ['', '..', '../other', 'a/../../x', '/abs', 'a//b', './a', 'a/.', 'a\\b', 'a\0b']) {
    expect(isSafeLoreBundleName(bad)).toBe(false);
  }
});

test('paths-review: scanCast refuses a traversing bundle with a warning instead of reading outside lore/', () => {
  const lore = (name: string): string => `---\nname: ${name}\ndescription: d\nkind: lore\n---\n\nbody\n`;
  // A sibling cast's lore that `../../other/lore` would otherwise resolve to.
  put(join(root, 'casts', 'other', 'lore', 'secret.md'), lore('Secret'));
  put(join(loreBundleDir('c', 'loft', root), 'room.md'), lore('Room'));
  const { entries, warnings } = scanCast('c', root, { loreBundles: ['../../other/lore', 'loft'] });
  expect(entries.map((e) => e.id)).toEqual(['room']);
  expect(warnings.some((w) => w.includes('"../../other/lore" is not a valid bundle name'))).toBe(true);
});
