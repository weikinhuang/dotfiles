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
  listLoreBundles,
  loreBundleDir,
  parseLoreBundleSelection,
  readEntryBody,
  rebuildCast,
  removeFileIfExists,
  portraitPath,
  scanCast,
  scanCastComplete,
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

/** Write a base (top-level `lore/<slug>.md`) lore record. */
function writeLore(cast: string, slug: string, name: string, body: string): void {
  atomicWriteFile(
    fileFor(cast, 'lore', slug, root),
    serializeEntry({ name, description: `d ${slug}`, kind: 'lore', body }),
  );
}

/** Write a lore record into a named bundle subfolder (`lore/<bundle>/<slug>.md`). */
function writeBundleLore(cast: string, bundle: string, slug: string, name: string, body: string): void {
  atomicWriteFile(
    join(loreBundleDir(cast, bundle, root), `${slug}.md`),
    serializeEntry({ name, description: `d ${slug}`, kind: 'lore', body }),
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

test('parseLoreBundleSelection: splits, trims, dedupes, preserves order', () => {
  expect(parseLoreBundleSelection(undefined)).toEqual([]);
  expect(parseLoreBundleSelection('')).toEqual([]);
  expect(parseLoreBundleSelection('  ')).toEqual([]);
  expect(parseLoreBundleSelection('winter-arc, loft ,,winter-arc')).toEqual(['winter-arc', 'loft']);
});

test('scanCast: base lore only when no bundle activated; bundle stays inert', () => {
  writeLore('pl', 'setting', 'Setting', 'The city, by default.');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'The loft variant.');
  writeBundleLore('pl', 'loft', 'loft-only', 'Loft only', 'Extra loft detail.');

  const { entries, warnings } = scanCast('pl', root);
  expect(warnings).toEqual([]);
  // Only the base record loads; the loft bundle subfolder is not scanned.
  expect(entries.map((e) => e.id)).toEqual(['setting']);
  expect(readEntryBody('pl', entries[0], root)!.trim()).toBe('The city, by default.');
});

test('scanCast: an activated bundle overrides a base record with the same id and adds its own', () => {
  writeLore('pl', 'setting', 'Setting', 'The city, by default.');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'The loft variant.');
  writeBundleLore('pl', 'loft', 'loft-only', 'Loft only', 'Extra loft detail.');

  const { entries, warnings } = scanCast('pl', root, { loreBundles: ['loft'] });
  expect(warnings).toEqual([]);
  expect(entries.map((e) => e.id)).toEqual(['loft-only', 'setting']);
  // The bundle's `setting` wins over the base `setting` (bundle-overrides-base).
  const setting = entries.find((e) => e.id === 'setting')!;
  expect(setting.name).toBe('Loft setting');
  expect(readEntryBody('pl', setting, root)!.trim()).toBe('The loft variant.');
});

test('scanCast: a NOT-activated second bundle does not bleed in', () => {
  writeLore('pl', 'setting', 'Setting', 'The city, by default.');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'The loft variant.');
  writeBundleLore('pl', 'cabin', 'setting', 'Cabin setting', 'The cabin variant.');
  writeBundleLore('pl', 'cabin', 'cabin-only', 'Cabin only', 'Extra cabin detail.');

  const { entries } = scanCast('pl', root, { loreBundles: ['loft'] });
  // Only `loft` is active: no `cabin-only`, and `setting` is the loft variant.
  expect(entries.map((e) => e.id)).toEqual(['setting']);
  expect(entries[0].name).toBe('Loft setting');
});

test('scanCast: later bundle in the selection wins over an earlier one', () => {
  writeLore('pl', 'setting', 'Setting', 'base');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'loft');
  writeBundleLore('pl', 'cabin', 'setting', 'Cabin setting', 'cabin');

  const { entries } = scanCast('pl', root, { loreBundles: ['loft', 'cabin'] });
  expect(entries.map((e) => e.id)).toEqual(['setting']);
  // Ascending precedence: `cabin` is listed last, so it overrides `loft`.
  expect(entries[0].name).toBe('Cabin setting');
});

test('scanCast: a missing / unknown bundle name warns and is skipped gracefully', () => {
  writeLore('pl', 'setting', 'Setting', 'base');

  const { entries, warnings } = scanCast('pl', root, { loreBundles: ['ghost'] });
  // Base lore still loads.
  expect(entries.map((e) => e.id)).toEqual(['setting']);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('lore bundle "ghost" not found');
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

test('listLoreBundles enumerates every bundle subfolder on disk, sorted (index-only)', () => {
  expect(listLoreBundles('pl', root)).toEqual([]);
  writeLore('pl', 'setting', 'Setting', 'base');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'loft');
  writeBundleLore('pl', 'cabin', 'setting', 'Cabin setting', 'cabin');
  // Every subfolder is a bundle, regardless of the active selection.
  expect(listLoreBundles('pl', root)).toEqual(['cabin', 'loft']);
});

test('scanCastComplete includes base + EVERY bundle with no cross-tier dedup', () => {
  writeChar('pl', 'exusiai', 'Exusiai', 'char body');
  writeLore('pl', 'setting', 'Setting', 'base');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'loft');
  writeBundleLore('pl', 'loft', 'loft-only', 'Loft only', 'extra');
  writeBundleLore('pl', 'cabin', 'setting', 'Cabin setting', 'cabin');

  const { entries, warnings } = scanCastComplete('pl', root);
  expect(warnings).toEqual([]);
  // Base `setting` and both bundles' `setting` all survive (no dedup),
  // each tagged with its source bundle (base = undefined).
  expect(entries.map((e) => `${e.kind}/${e.bundle ?? ''}/${e.id}`)).toEqual([
    'character//exusiai',
    'lore//setting',
    'lore/cabin/setting',
    'lore/loft/loft-only',
    'lore/loft/setting',
  ]);
});

test('scanCast (runtime) still active-only + deduped after the complete-index refactor', () => {
  writeLore('pl', 'setting', 'Setting', 'base');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'loft');
  writeBundleLore('pl', 'cabin', 'setting', 'Cabin setting', 'cabin');

  // No selection: base only, one record.
  expect(scanCast('pl', root).entries.map((e) => `${e.bundle ?? ''}/${e.id}`)).toEqual(['/setting']);
  // Active `loft`: loft overrides base, cabin does NOT bleed in.
  const active = scanCast('pl', root, { loreBundles: ['loft'] });
  expect(active.entries.map((e) => `${e.bundle ?? ''}/${e.id}`)).toEqual(['loft/setting']);
  expect(active.entries[0].name).toBe('Loft setting');
});

test('writeIndex renders a COMPLETE bundle-aware INDEX.md with correct per-bundle paths', () => {
  writeChar('pl', 'exusiai', 'Exusiai', 'char body');
  writeLore('pl', 'setting', 'Setting', 'base');
  writeBundleLore('pl', 'loft', 'setting', 'Loft setting', 'loft');
  writeBundleLore('pl', 'loft', 'loft-only', 'Loft only', 'extra loft');
  writeBundleLore('pl', 'cabin', 'setting', 'Cabin setting', 'cabin');

  // Even when only `loft` is active in the live state, INDEX is complete.
  const { state } = rebuildCast('pl', root, { loreBundles: ['loft'] });
  writeIndex(state, root);
  const md = readFileSync(indexFileFor('pl', root), 'utf8');

  // Base lore links to the top-level path.
  expect(md).toContain('[Setting](lore/setting.md)');
  // Per-bundle subsections with real bundle-relative paths.
  expect(md).toContain('### Lore bundle: cabin');
  expect(md).toContain('[Cabin setting](lore/cabin/setting.md)');
  expect(md).toContain('### Lore bundle: loft');
  expect(md).toContain('[Loft setting](lore/loft/setting.md)');
  expect(md).toContain('[Loft only](lore/loft/loft-only.md)');
  // A bundle-sourced record never emits a base-path link.
  expect(md).not.toContain('[Loft setting](lore/setting.md)');
  // Other kinds are unaffected.
  expect(md).toContain('[Exusiai](character/exusiai.md)');
});

test('listLoreBundles discovers nested/grouped leaf bundles, skipping pure grouping dirs', () => {
  // A flat bundle and a two-level group with two variants under it.
  writeBundleLore('pl', 'seasonal', 'winter', 'Winter', 'flat bundle');
  writeBundleLore('pl', 'home/brooklyn-brownstone', 'layout', 'Brownstone layout', 'v1');
  writeBundleLore('pl', 'home/queens-midrise', 'layout', 'Midrise layout', 'v2');
  // `home/` itself holds no `*.md` - it is a pure grouping dir.
  expect(listLoreBundles('pl', root)).toEqual(['home/brooklyn-brownstone', 'home/queens-midrise', 'seasonal']);
});

test('listLoreBundles: a group dir that ALSO holds its own *.md is itself a bundle', () => {
  writeBundleLore('pl', 'home', 'shared', 'Shared home lore', 'group-level md');
  writeBundleLore('pl', 'home/loft', 'layout', 'Loft layout', 'nested');
  // `home` has a direct .md so it counts, and `home/loft` is a distinct bundle.
  expect(listLoreBundles('pl', root)).toEqual(['home', 'home/loft']);
});

test('scanCastComplete + INDEX cover nested bundles with real nested paths', () => {
  writeChar('pl', 'mira', 'Mira', 'char');
  writeLore('pl', 'city', 'The City', 'base');
  writeBundleLore('pl', 'home/brooklyn-brownstone', 'layout', 'Brownstone layout', 'v1');
  writeBundleLore('pl', 'home/queens-midrise', 'layout', 'Midrise layout', 'v2');

  const { entries, warnings } = scanCastComplete('pl', root);
  expect(warnings).toEqual([]);
  expect(entries.map((e) => `${e.kind}/${e.bundle ?? ''}/${e.id}`)).toEqual([
    'character//mira',
    'lore//city',
    'lore/home/brooklyn-brownstone/layout',
    'lore/home/queens-midrise/layout',
  ]);

  writeIndex({ cast: 'pl', entries: [] }, root);
  const md = readFileSync(indexFileFor('pl', root), 'utf8');
  expect(md).toContain('### Lore bundle: home/brooklyn-brownstone');
  expect(md).toContain('[Brownstone layout](lore/home/brooklyn-brownstone/layout.md)');
  expect(md).toContain('### Lore bundle: home/queens-midrise');
  expect(md).toContain('[Midrise layout](lore/home/queens-midrise/layout.md)');
  // No pure grouping dir subsection, and no base-path link for a nested record.
  expect(md).not.toContain('### Lore bundle: home\n');
  expect(md).not.toContain('[Brownstone layout](lore/layout.md)');
});

test('scanCast (runtime) loads a nested bundle token active-only and stays unchanged', () => {
  writeLore('pl', 'city', 'The City', 'base');
  writeBundleLore('pl', 'home/brooklyn-brownstone', 'layout', 'Brownstone layout', 'v1');
  writeBundleLore('pl', 'home/queens-midrise', 'layout', 'Midrise layout', 'v2');

  // No selection: base only.
  expect(scanCast('pl', root).entries.map((e) => `${e.bundle ?? ''}/${e.id}`)).toEqual(['/city']);
  // Active nested token: only that bundle loads; the sibling variant does not bleed in.
  const active = scanCast('pl', root, { loreBundles: ['home/brooklyn-brownstone'] });
  expect(active.entries.map((e) => `${e.bundle ?? ''}/${e.id}`)).toEqual(['/city', 'home/brooklyn-brownstone/layout']);
  expect(active.warnings).toEqual([]);
});
