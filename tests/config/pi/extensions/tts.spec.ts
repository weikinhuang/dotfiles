/**
 * Tests for the tts extension's command surface.
 *
 * The extension shell lives at `config/pi/extensions/tts.ts` and is
 * intentionally thin - all logic is delegated to the pure helpers under
 * `lib/node/pi/tts/`. The `/tts` command's argument completion is built on
 * the shared `completeSubverbs` helper; this spec reconstructs the exact
 * subverb spec object the extension passes it (with a static voice-roster
 * resolver standing in for the live `voiceCandidates()`) and asserts level-1
 * verb completion, level-2 voice completion carrying the verb prefix, and the
 * shared `--help` recognition + USAGE source-of-truth.
 *
 * Layout note: per `tests/lib/node/pi/README.md`, pure-helper specs live
 * under `tests/lib/node/pi/`. This spec sits under
 * `tests/config/pi/extensions/` to document the extension's command
 * surface; all code under test is still pure (no pi-runtime imports).
 */

import { expect, test } from 'vitest';

import { completeSubverbs, type ArgCandidate, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import { TTS_USAGE } from '../../../../lib/node/pi/tts/usage.ts';

/** Static stand-in for the extension's live `voiceCandidates()` resolver. */
const voiceCandidates = (): ArgCandidate[] => [{ label: 'exusiai' }, { label: 'narrator' }];

/** The exact subverb spec object the `/tts` command registers. */
const ttsSpec: SubverbSpec = {
  on: { description: 'Enable RP dialogue narration' },
  off: { description: 'Disable RP dialogue narration' },
  narrate: { description: 'Toggle agent-output narration', args: ['on', 'off'] },
  voice: { description: 'Set the RP voice', args: () => voiceCandidates() },
  'narration-voice': { description: 'Set the narration voice', args: () => voiceCandidates() },
  say: { description: 'Speak literal text now (debug; uses the RP voice, bypasses gating)' },
  status: { description: 'Show modes, engine, resolved voices, reachability', args: () => voiceCandidates() },
};

test('completion: level-1 lists every verb on empty prefix', () => {
  const items = completeSubverbs('', ttsSpec);
  expect(items?.map((i) => i.value).sort()).toEqual([
    'narrate',
    'narration-voice',
    'off',
    'on',
    'say',
    'status',
    'voice',
  ]);
});

test('completion: level-1 filters by partial verb', () => {
  const items = completeSubverbs('na', ttsSpec);
  expect(items?.map((i) => i.value).sort()).toEqual(['narrate', 'narration-voice']);
});

test('completion: narrate args are the static on|off list', () => {
  const items = completeSubverbs('narrate ', ttsSpec);
  expect(items?.map((i) => i.value)).toEqual(['narrate on', 'narrate off']);
});

test('completion: voice args carry the verb prefix in value', () => {
  const items = completeSubverbs('voice ', ttsSpec);
  expect(items?.map((i) => i.value)).toEqual(['voice exusiai', 'voice narrator']);
  // label stays the bare candidate so the menu shows the voice name.
  expect(items?.map((i) => i.label)).toEqual(['exusiai', 'narrator']);
});

test('completion: voice args filter by partial tail', () => {
  const items = completeSubverbs('voice ex', ttsSpec);
  expect(items?.map((i) => i.value)).toEqual(['voice exusiai']);
});

test('completion: narration-voice resolver also completes voices', () => {
  const items = completeSubverbs('narration-voice nar', ttsSpec);
  expect(items?.map((i) => i.value)).toEqual(['narration-voice narrator']);
});

test('completion: status resolver completes a named voice', () => {
  const items = completeSubverbs('status exu', ttsSpec);
  expect(items?.map((i) => i.value)).toEqual(['status exusiai']);
});

test('completion: terminal verb (say) has no deeper completions', () => {
  expect(completeSubverbs('say ', ttsSpec)).toBeNull();
});

test('completion: unknown verb -> null', () => {
  expect(completeSubverbs('bogus ', ttsSpec)).toBeNull();
});

test('help: the shared help tokens are recognised', () => {
  for (const token of ['help', '--help', '-h', '?']) {
    expect(isHelpArg(token)).toBe(true);
  }
  expect(isHelpArg('status')).toBe(false);
});

test('usage: TTS_USAGE documents every verb', () => {
  for (const verb of ['on', 'off', 'narrate', 'voice', 'narration-voice', 'say', 'status']) {
    expect(TTS_USAGE).toContain(verb);
  }
});
