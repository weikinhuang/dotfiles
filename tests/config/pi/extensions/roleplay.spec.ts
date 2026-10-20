/**
 * Tests for the roleplay extension's `/roleplay` command surface.
 *
 * The extension shell lives at `config/pi/extensions/roleplay.ts`; its
 * argument completion is delegated to the pure `completeSubverbs` helper
 * with the shared `roleplaySubverbs` spec from `roleplay/usage.ts`. This
 * spec asserts against that real spec so the completion surface stays in
 * lockstep with the command, and pins the shared `ROLEPLAY_USAGE` string.
 *
 * Layout note: per `tests/lib/node/pi/README.md`, pure-helper specs live
 * under `tests/lib/node/pi/`. This spec sits under
 * `tests/config/pi/extensions/` to document the command surface; all code
 * under test is still pure (no pi-runtime imports).
 */

import { expect, test } from 'vitest';

import { completeSubverbs, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';
import { ROLEPLAY_USAGE, roleplaySubverbs } from '../../../../lib/node/pi/roleplay/usage.ts';

/** The real subverb spec roleplay.ts registers, with a fixed cast list. */
const ROLEPLAY_SUBVERBS: SubverbSpec = roleplaySubverbs(
  () => ['exusiai', 'texas'],
  () => ['mira', 'kai'],
);

test('roleplay command lists every subverb (including event) at level 1', () => {
  const all = completeSubverbs('', ROLEPLAY_SUBVERBS);
  const labels = (all ?? []).map((c) => c.label);
  expect(labels).toEqual([
    'list',
    'context',
    'lore',
    'recap',
    'relationships',
    'cast',
    'import',
    'export',
    'event',
    'images',
    'newscene',
    'dir',
    'rescan',
    'casts',
  ]);
});

test('roleplay command completes the event subverb from a prefix', () => {
  const matched = completeSubverbs('ev', ROLEPLAY_SUBVERBS);
  expect(matched).toEqual([
    {
      value: 'event',
      label: 'event',
      description: 'Queue a one-shot scene complication (LLM-generated, or from the deck)',
    },
  ]);
});

test('event is a terminal subverb - the freeform hint takes no completions', () => {
  expect(completeSubverbs('event ', ROLEPLAY_SUBVERBS)).toBeNull();
  expect(completeSubverbs('event a storm', ROLEPLAY_SUBVERBS)).toBeNull();
});

test('image mode completion carries the entire prefix and is documented', () => {
  expect(completeSubverbs('images s', ROLEPLAY_SUBVERBS)).toEqual([{ value: 'images simple', label: 'simple' }]);
  expect(ROLEPLAY_USAGE).toContain('images [simple|full|off]');
});

test('ROLEPLAY_USAGE documents the event subverb', () => {
  expect(ROLEPLAY_USAGE).toContain('event [hint]');
});

test('newscene is a terminal subverb documented in USAGE', () => {
  const matched = completeSubverbs('newsc', ROLEPLAY_SUBVERBS);
  expect(matched).toEqual([
    {
      value: 'newscene',
      label: 'newscene',
      description: 'Start a fresh scene: archive + clear the recap / timeline / fact carry-overs',
    },
  ]);
  expect(completeSubverbs('newscene ', ROLEPLAY_SUBVERBS)).toBeNull();
  expect(ROLEPLAY_USAGE).toContain('newscene');
});

test('context is a terminal subverb documented in USAGE (with its aliases)', () => {
  expect(completeSubverbs('cont', ROLEPLAY_SUBVERBS)?.map((c) => c.label)).toEqual(['context']);
  expect(completeSubverbs('context ', ROLEPLAY_SUBVERBS)).toBeNull();
  expect(ROLEPLAY_USAGE).toContain('context');
  expect(ROLEPLAY_USAGE).toContain('`ctx`');
});

test('cast subverb completes from the injected cast list', () => {
  expect(completeSubverbs('cast t', ROLEPLAY_SUBVERBS)?.map((c) => c.label)).toEqual(['texas']);
});

test('lore and relationships are terminal subverbs documented in USAGE', () => {
  expect(completeSubverbs('lore ', ROLEPLAY_SUBVERBS)).toBeNull();
  expect(completeSubverbs('relationships ', ROLEPLAY_SUBVERBS)).toBeNull();
  expect(completeSubverbs('rel', ROLEPLAY_SUBVERBS)?.map((c) => c.label)).toEqual(['relationships']);
  expect(ROLEPLAY_USAGE).toContain('`lore`');
  expect(ROLEPLAY_USAGE).toContain('alias `rel`');
});

test('recap subverb completes show / force with the full verb prefix', () => {
  expect(completeSubverbs('recap ', ROLEPLAY_SUBVERBS)).toEqual([
    { value: 'recap show', label: 'show' },
    { value: 'recap force', label: 'force' },
  ]);
  expect(completeSubverbs('recap f', ROLEPLAY_SUBVERBS)).toEqual([{ value: 'recap force', label: 'force' }]);
  expect(ROLEPLAY_USAGE).toContain('recap [show|force]');
});

test('export subverb completes character ids from the injected list', () => {
  expect(completeSubverbs('export m', ROLEPLAY_SUBVERBS)).toEqual([{ value: 'export mira', label: 'mira' }]);
  expect(ROLEPLAY_USAGE).toContain('export [character] [path]');
});

test('export completion defaults to no characters when none are injected', () => {
  expect(
    completeSubverbs(
      'export ',
      roleplaySubverbs(() => []),
    ),
  ).toBeNull();
});
