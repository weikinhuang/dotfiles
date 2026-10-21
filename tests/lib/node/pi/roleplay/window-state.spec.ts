import { describe, expect, it } from 'vitest';

import { DEFAULT_CHARS_PER_TOKEN } from '../../../../../lib/node/pi/roleplay/context-window.ts';
import {
  anchorAfterCompaction,
  armForcedRecap,
  createWindowState,
  invalidateRecap,
  planRoll,
  resetWindowCoverage,
  resetWindowState,
  settleForcedRecap,
  type WindowState,
} from '../../../../../lib/node/pi/roleplay/window-state.ts';

function dirty(abort: AbortController): WindowState {
  return {
    recapText: 'recap',
    timelineText: 'beats',
    committedCutoff: 10,
    recapCutoff: 8,
    frozenFloorCutoff: 6,
    recapHydrated: true,
    recapGen: 3,
    recapInFlight: true,
    recapAbort: abort,
    charsPerToken: 3.5,
    lastSentEstChars: 1234,
    projectedFloorAnchor: 'anchor',
    forceRecap: true,
    postCompaction: false,
    timelineSeedBase: 'seed',
  };
}

describe('window state', () => {
  it('creates a cold state', () => {
    expect(createWindowState()).toEqual({
      recapText: '',
      timelineText: '',
      committedCutoff: 0,
      recapCutoff: 0,
      frozenFloorCutoff: 0,
      recapHydrated: false,
      recapGen: 0,
      recapInFlight: false,
      recapAbort: null,
      charsPerToken: DEFAULT_CHARS_PER_TOKEN,
      lastSentEstChars: 0,
      projectedFloorAnchor: undefined,
      postCompaction: false,
      timelineSeedBase: null,
      forceRecap: false,
    });
  });

  it('resetWindowState clears everything but the calibration and bumps the generation', () => {
    const abort = new AbortController();
    const win = dirty(abort);
    resetWindowState(win);
    expect(abort.signal.aborted).toBe(true);
    expect(win).toEqual({ ...createWindowState(), recapGen: 4, charsPerToken: 3.5 });
  });

  it('resetWindowCoverage keeps recap / timeline text and the floor anchor', () => {
    const abort = new AbortController();
    const win = dirty(abort);
    resetWindowCoverage(win);
    expect(abort.signal.aborted).toBe(true);
    expect(win).toEqual({
      ...dirty(abort),
      committedCutoff: 0,
      recapCutoff: 0,
      frozenFloorCutoff: 0,
      recapGen: 4,
      recapInFlight: false,
      recapAbort: null,
      lastSentEstChars: 0,
      postCompaction: true,
    });
  });

  it('anchorAfterCompaction anchors committedCutoff at natural once, keeping recapCutoff 0', () => {
    const win = createWindowState();
    expect(anchorAfterCompaction(win, 30)).toBe(false);
    expect(win.committedCutoff).toBe(0);
    resetWindowCoverage(win);
    expect(anchorAfterCompaction(win, 30)).toBe(true);
    expect(win).toMatchObject({ committedCutoff: 30, recapCutoff: 0, postCompaction: false });
    // No roll due on the anchored pass: the stride gate sees no new aged messages.
    expect(planRoll(win, 30, 1)).toEqual({ roll: false, forced: false });
    expect(anchorAfterCompaction(win, 40)).toBe(false);
  });

  it('invalidateRecap tolerates a missing or throwing controller', () => {
    const win = createWindowState();
    invalidateRecap(win);
    expect(win.recapGen).toBe(1);
    win.recapAbort = {
      abort: () => {
        throw new Error('boom');
      },
    } as unknown as AbortController;
    win.recapInFlight = true;
    expect(() => invalidateRecap(win)).not.toThrow();
    expect(win).toMatchObject({ recapGen: 2, recapInFlight: false, recapAbort: null });
  });

  it('planRoll follows the stride gate when no force is armed', () => {
    const win = createWindowState();
    expect(planRoll(win, 10, 4)).toEqual({ roll: true, forced: false });
    win.committedCutoff = 8;
    expect(planRoll(win, 10, 4)).toEqual({ roll: false, forced: false });
  });

  it('an armed force rolls off-stride until a recap starts', () => {
    const win = createWindowState();
    win.committedCutoff = 8;
    win.recapCutoff = 4;
    armForcedRecap(win);
    expect(planRoll(win, 10, 4)).toEqual({ roll: true, forced: true });
    // Blocked by an in-flight recap: stays armed for the next pass.
    settleForcedRecap(win, false);
    expect(win.forceRecap).toBe(true);
    settleForcedRecap(win, true);
    expect(win.forceRecap).toBe(false);
    expect(planRoll(win, 10, 4)).toEqual({ roll: false, forced: false });
  });

  it('a force with nothing uncovered is dropped', () => {
    const win = createWindowState();
    win.recapCutoff = 10;
    win.committedCutoff = 10;
    armForcedRecap(win);
    expect(planRoll(win, 10, 4)).toEqual({ roll: false, forced: false });
    expect(win.forceRecap).toBe(false);
  });
});
