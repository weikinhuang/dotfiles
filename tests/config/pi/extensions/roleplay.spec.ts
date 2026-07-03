/**
 * Tests for the roleplay extension's `/roleplay` command surface.
 *
 * The extension shell lives at `config/pi/extensions/roleplay.ts`; its
 * argument completion is delegated to the pure `completeSubverbs` helper
 * with an inline subverb spec. This spec reconstructs that exact spec so
 * the completion surface (notably the `event` subverb) stays in lockstep
 * with the helper, and pins the shared `ROLEPLAY_USAGE` string.
 *
 * Layout note: per `tests/lib/node/pi/README.md`, pure-helper specs live
 * under `tests/lib/node/pi/`. This spec sits under
 * `tests/config/pi/extensions/` to document the command surface; all code
 * under test is still pure (no pi-runtime imports).
 */

import { expect, test } from 'vitest';

import { completeSubverbs, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';
import { ROLEPLAY_USAGE } from '../../../../lib/node/pi/roleplay/usage.ts';

/** The subverb spec mirrored from roleplay.ts's `getArgumentCompletions`. */
const ROLEPLAY_SUBVERBS: SubverbSpec = {
  list: { description: 'List the active cast' },
  cast: { description: 'Switch / set the active cast', args: () => [{ label: 'exusiai' }, { label: 'texas' }] },
  import: { description: 'Import a SillyTavern card (.json/.png) into the active cast' },
  event: { description: 'Queue a one-shot scene complication (LLM-generated, or from the deck)' },
  newscene: { description: 'Start a fresh scene: archive + clear the recap / timeline / fact carry-overs' },
  dir: { description: 'Print the roleplay store dir' },
  rescan: { description: 'Rescan the active cast from disk' },
  casts: { description: 'List every cast on disk' },
};

test('roleplay command lists every subverb (including event) at level 1', () => {
  const all = completeSubverbs('', ROLEPLAY_SUBVERBS);
  const labels = (all ?? []).map((c) => c.label);
  expect(labels).toEqual(['list', 'cast', 'import', 'event', 'newscene', 'dir', 'rescan', 'casts']);
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
