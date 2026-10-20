import { describe, expect, it } from 'vitest';

import { DEFAULT_CHARS_PER_TOKEN } from '../../../../../lib/node/pi/roleplay/context-window.ts';
import {
  createWindowState,
  invalidateRecap,
  resetWindowCoverage,
  resetWindowState,
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
    });
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
});
