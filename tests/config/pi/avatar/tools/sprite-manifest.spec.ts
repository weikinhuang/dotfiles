/**
 * Unit tests for the sprite-manifest sheet packing. These assert the
 * tier-partitioned, atomic-emote-block packing contract that the prompt
 * generator, slicer, and assembler all depend on (no state split across a
 * sheet, dense fill, tier isolation).
 */
import { describe, expect, test } from 'vitest';

import {
  CELLS,
  GROUPS,
  TIERS,
  type Sheet,
  allSheets,
  frameCount,
  sheetsForTier,
  tierOf,
} from '../../../../../config/pi/avatar/tools/sprite-manifest.ts';

const SHEETS: Sheet[] = allSheets();

test('tierOf: groups map to their declared tier (default standard)', () => {
  expect(tierOf('activities')).toBe('standard');
  expect(tierOf('sultry')).toBe('suggestive');
  expect(tierOf('desire')).toBe('mature');
  expect(tierOf('intensity')).toBe('mature');
  expect(tierOf('intimacy')).toBe('mature');
});

test('allSheets: every sheet has exactly CELLS slots with blanks only at the end', () => {
  for (const sheet of SHEETS) {
    expect(sheet.cells.length).toBe(CELLS);
    const firstBlank = sheet.cells.findIndex((c) => c === null);
    const tail = firstBlank < 0 ? [] : sheet.cells.slice(firstBlank);
    expect(tail.every((c) => c === null)).toBe(true);
    // No fully-empty sheets.
    expect(sheet.cells.some((c) => c !== null)).toBe(true);
  }
});

test('allSheets: a state is never split across sheets and its frames are contiguous', () => {
  const stateToSheets = new Map<string, Set<string>>();
  const stateFrames = new Map<string, number[]>();
  for (const sheet of SHEETS) {
    for (const cell of sheet.cells) {
      if (cell === null) continue;
      (stateToSheets.get(cell.state) ?? stateToSheets.set(cell.state, new Set()).get(cell.state)!).add(sheet.name);
      (stateFrames.get(cell.state) ?? stateFrames.set(cell.state, []).get(cell.state)!).push(cell.frame);
    }
  }
  for (const [state, sheetNames] of stateToSheets) {
    expect.soft(sheetNames.size, `state ${state} spans ${[...sheetNames].join(', ')}`).toBe(1);
  }
  for (const [state, frames] of stateFrames) {
    const expected = [...Array(frames.length).keys()];
    expect
      .soft(
        frames.slice().sort((a, b) => a - b),
        `state ${state} frames`,
      )
      .toEqual(expected);
  }
});

test('allSheets: every (group,state,frame) cell from the manifest appears exactly once', () => {
  const seen = new Set<string>();
  let total = 0;
  for (const sheet of SHEETS) {
    for (const cell of sheet.cells) {
      if (cell === null) continue;
      const key = `${cell.group}/${cell.state}/${cell.frame}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      total += 1;
    }
  }
  let expected = 0;
  for (const [name, group] of Object.entries(GROUPS)) {
    for (const state of group.states) expected += frameCount(name, state);
  }
  expect(total).toBe(expected);
});

test('allSheets: sheets are emitted in TIERS order with sequential <tier>.<n> names', () => {
  const perTier = new Map<string, number>();
  let lastTierIdx = -1;
  for (const sheet of SHEETS) {
    const tierIdx = (TIERS as readonly string[]).indexOf(sheet.tier);
    expect(tierIdx).toBeGreaterThanOrEqual(lastTierIdx);
    lastTierIdx = tierIdx;
    const n = (perTier.get(sheet.tier) ?? 0) + 1;
    perTier.set(sheet.tier, n);
    expect(sheet.name).toBe(`${sheet.tier}.${n}`);
  }
});

test('allSheets: a sheet only contains states from its own tier', () => {
  for (const sheet of SHEETS) {
    for (const cell of sheet.cells) {
      if (cell === null) continue;
      expect(tierOf(cell.group)).toBe(sheet.tier);
    }
  }
});

describe('sheetsForTier', () => {
  test('returns exactly the sheets of one tier', () => {
    for (const tier of TIERS) {
      const subset = sheetsForTier(tier);
      expect(subset).toEqual(SHEETS.filter((s) => s.tier === tier));
      expect(subset.every((s) => s.tier === tier)).toBe(true);
    }
  });
});
