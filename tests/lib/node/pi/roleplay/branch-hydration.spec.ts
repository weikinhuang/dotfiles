/**
 * Tests for lib/node/pi/roleplay/branch-hydration.ts.
 */

import { expect, test } from 'vitest';

import { scanBranchForRecap, scanBranchForTimeline } from '../../../../../lib/node/pi/roleplay/branch-hydration.ts';

const recapEntry = (data: Record<string, unknown>): Record<string, unknown> => ({
  type: 'custom',
  customType: 'roleplay-context-recap',
  data,
});
const timelineEntry = (timeline: string): Record<string, unknown> => ({
  type: 'custom',
  customType: 'roleplay-timeline',
  data: { timeline },
});
const newscene = (): Record<string, unknown> => ({ type: 'custom', customType: 'roleplay-newscene', data: {} });

test('scanBranchForRecap returns null on an empty branch', () => {
  expect(scanBranchForRecap([], 10)).toBeNull();
});

test('scanBranchForRecap picks the newest applied recap and clamps coveredTo to natural', () => {
  const entries = [
    recapEntry({ recap: 'old', coveredTo: 5, applied: true }),
    recapEntry({ recap: 'new recap', coveredTo: 999, applied: true }),
  ];
  expect(scanBranchForRecap(entries, 40)).toEqual({ recap: 'new recap', coveredTo: 40 });
});

test('scanBranchForRecap trims the recap text and floors coveredTo at 0', () => {
  const entries = [recapEntry({ recap: '  spaced  ', coveredTo: -3, applied: true })];
  expect(scanBranchForRecap(entries, 100)).toEqual({ recap: 'spaced', coveredTo: 0 });
});

test('scanBranchForRecap skips rejected rolls but keeps force-accepted ones', () => {
  const rejected = [recapEntry({ recap: 'rejected', coveredTo: 20, applied: false })];
  expect(scanBranchForRecap(rejected, 50)).toBeNull();

  const forced = [
    recapEntry({ recap: 'kept', coveredTo: 12, applied: true }),
    recapEntry({ recap: 'forced', coveredTo: 30, applied: false, forced: true }),
  ];
  expect(scanBranchForRecap(forced, 50)).toEqual({ recap: 'forced', coveredTo: 30 });
});

test('scanBranchForRecap accepts the legacy rp-context-recap customType', () => {
  const entries = [
    { type: 'custom', customType: 'rp-context-recap', data: { recap: 'legacy', coveredTo: 7, applied: true } },
  ];
  expect(scanBranchForRecap(entries, 50)).toEqual({ recap: 'legacy', coveredTo: 7 });
});

test('scanBranchForRecap cold-starts when a newscene marker shadows older recaps', () => {
  const entries = [recapEntry({ recap: 'archived', coveredTo: 8, applied: true }), newscene()];
  expect(scanBranchForRecap(entries, 50)).toBeNull();
});

test('scanBranchForRecap defaults coveredTo to 0 when the field is missing', () => {
  const entries = [recapEntry({ recap: 'here', applied: true })];
  expect(scanBranchForRecap(entries, 50)).toEqual({ recap: 'here', coveredTo: 0 });
});

test('scanBranchForRecap ignores non-custom and empty-recap entries', () => {
  const entries = [
    { type: 'message', role: 'user', content: 'hi' },
    recapEntry({ recap: '   ', coveredTo: 4, applied: true }),
  ];
  expect(scanBranchForRecap(entries, 50)).toBeNull();
});

test('scanBranchForTimeline returns the newest non-empty snapshot, trimmed', () => {
  const entries = [timelineEntry('older'), timelineEntry('  newest\n')];
  expect(scanBranchForTimeline(entries)).toBe('newest');
});

test('scanBranchForTimeline skips empty snapshots and returns null when none carry text', () => {
  expect(scanBranchForTimeline([timelineEntry('   ')])).toBeNull();
  expect(scanBranchForTimeline([])).toBeNull();
});

test('scanBranchForTimeline cold-starts on a newscene marker', () => {
  const entries = [timelineEntry('archived beats'), newscene()];
  expect(scanBranchForTimeline(entries)).toBeNull();
});
