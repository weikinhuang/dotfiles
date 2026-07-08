/**
 * Tests for lib/node/pi/roleplay/context-readout.ts.
 */

import { expect, test } from 'vitest';

import {
  type ContextWindowReadoutSnapshot,
  formatContextWindowReadout,
} from '../../../../../lib/node/pi/roleplay/context-readout.ts';

const snapshot = (over: Partial<ContextWindowReadoutSnapshot> = {}): ContextWindowReadoutSnapshot => ({
  ts: 0,
  messagesIn: 200,
  messagesOut: 120,
  natural: 180,
  committedCutoff: 100,
  recapCutoff: 100,
  floorCutoff: 0,
  dropCutoff: 100,
  frozenFloorCutoff: 0,
  recapChars: 2400,
  recapInFlight: false,
  estSystemTokens: 1200,
  estFullPromptTokens: 40000,
  estSentPromptTokens: 18000,
  estSavedTokens: 22000,
  charsPerToken: 3.7,
  dropMoved: false,
  recapChanged: false,
  ...over,
});

test('formatContextWindowReadout reports OFF when recap mode is disabled', () => {
  const out = formatContextWindowReadout({
    recapMode: false,
    snapshot: null,
    stride: 8,
    maxAdvance: 24,
    windowTokens: 60000,
  });
  expect(out).toBe(
    'Roleplay context windowing is OFF (needs both summarize and context-window enabled). Full history is sent every turn; no recap or drop is applied.',
  );
});

test('formatContextWindowReadout reports not-yet-engaged when there is no snapshot', () => {
  const out = formatContextWindowReadout({
    recapMode: true,
    snapshot: null,
    stride: 8,
    maxAdvance: 24,
    windowTokens: 60000,
  });
  expect(out).toContain('window management has not engaged yet this session');
});

test('formatContextWindowReadout renders the full snapshot with a drain estimate', () => {
  const out = formatContextWindowReadout({
    recapMode: true,
    snapshot: snapshot({ natural: 180, recapCutoff: 100, dropCutoff: 100, frozenFloorCutoff: 40 }),
    stride: 8,
    maxAdvance: 24,
    windowTokens: 60000,
  });
  expect(out).toBe(
    [
      'Roleplay context window (snapshot of last turn)',
      '  messages : 200 in -> 120 sent  (80 dropped)',
      '  cutoffs  : natural=180  drop=100  recap=100  floor=40(frozen)  committed=100',
      '  binding  : recap coverage sets the drop boundary',
      '  recap    : 2400 chars',
      '  tokens   : sent=18000 (30% of window)  system=1200  full=40000  saved=22000  window=60000  (~3.7 ch/tok)',
      '  cache    : prefix reused (drop boundary + recap held) -> cache hit',
      '  drain    : 80 msgs behind; ~5 rolls (~20 turns) to drain  [maxAdvance=24, stride=8]',
    ].join('\n'),
  );
});

test('formatContextWindowReadout shows the caught-up drain line + floor binding + unknown window', () => {
  const out = formatContextWindowReadout({
    recapMode: true,
    snapshot: snapshot({ natural: 100, recapCutoff: 100, floorCutoff: 100, recapInFlight: true }),
    stride: 8,
    maxAdvance: 24,
    windowTokens: undefined,
  });
  expect(out).toContain('  binding  : safety floor sets the drop boundary');
  expect(out).toContain('  recap    : 2400 chars  [async roll in flight]');
  expect(out).toContain('window=(unknown)');
  expect(out).toContain('  drain    : caught up to the kept window (rolls fire at the stride cadence).');
});

test('formatContextWindowReadout explains the cache-bust reason', () => {
  const both = formatContextWindowReadout({
    recapMode: true,
    snapshot: snapshot({ dropMoved: true, recapChanged: true }),
    stride: 8,
    maxAdvance: 24,
    windowTokens: 60000,
  });
  expect(both).toContain('prefix REPROCESSED last turn (drop boundary moved + recap changed)');

  const dropOnly = formatContextWindowReadout({
    recapMode: true,
    snapshot: snapshot({ dropMoved: true }),
    stride: 8,
    maxAdvance: 24,
    windowTokens: 60000,
  });
  expect(dropOnly).toContain('prefix REPROCESSED last turn (drop boundary moved)');

  const recapOnly = formatContextWindowReadout({
    recapMode: true,
    snapshot: snapshot({ recapChanged: true }),
    stride: 8,
    maxAdvance: 24,
    windowTokens: 60000,
  });
  expect(recapOnly).toContain('prefix REPROCESSED last turn (recap text changed)');
});
