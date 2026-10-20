import { describe, expect, it } from 'vitest';

import {
  formatRecapReadout,
  recapUnavailableReason,
  type RecapReadoutOptions,
} from '../../../../../lib/node/pi/roleplay/recap-readout.ts';

function opts(over: Partial<RecapReadoutOptions> = {}): RecapReadoutOptions {
  return {
    unavailable: null,
    recapText: '',
    recapCutoff: 0,
    committedCutoff: 0,
    natural: undefined,
    inFlight: false,
    forceArmed: false,
    model: undefined,
    timelineEnabled: false,
    timelineBlock: null,
    ...over,
  };
}

describe('recapUnavailableReason', () => {
  it('names the first missing prerequisite', () => {
    const on = { summarizeEnabled: true, contextWindowEnabled: true, summarizerReady: true };
    expect(recapUnavailableReason(on)).toBeNull();
    expect(recapUnavailableReason({ ...on, summarizeEnabled: false })).toContain('summarize is disabled');
    expect(recapUnavailableReason({ ...on, contextWindowEnabled: false })).toContain('context window is disabled');
    expect(recapUnavailableReason({ ...on, summarizerReady: false })).toContain('no summarize model');
  });
});

describe('formatRecapReadout', () => {
  it('renders a populated recap with coverage, status, and timeline preview', () => {
    const out = formatRecapReadout(
      opts({
        recapText: ' The party reached the reef. ',
        recapCutoff: 8,
        committedCutoff: 16,
        natural: 20,
        inFlight: true,
        forceArmed: true,
        model: 'local/qwen',
        timelineEnabled: true,
        timelineBlock: 'TIMELINE BLOCK',
      }),
    );
    expect(out).toBe(
      [
        'Roleplay recap',
        '  mode     : on',
        '  model    : local/qwen',
        '  coverage : recap=8  committed=16  natural(last pass)=20',
        '  status   : async roll in flight; forced roll armed for the next pass',
        '',
        'Recap (27 chars):',
        'The party reached the reef.',
        '',
        'Timeline (injected preview, 14 chars):',
        'TIMELINE BLOCK',
      ].join('\n'),
    );
  });

  it('renders an off / empty state', () => {
    const out = formatRecapReadout(opts({ unavailable: 'summarize is disabled' }));
    expect(out).toContain('mode     : OFF (summarize is disabled)');
    expect(out).toContain('model    : (unresolved)');
    expect(out).toContain('natural(last pass)=n/a');
    expect(out).toContain('status   : idle');
    expect(out).toContain('Recap: (empty)');
    expect(out).toContain('Timeline: off');
  });

  it('notes an enabled timeline with no beats', () => {
    expect(formatRecapReadout(opts({ timelineEnabled: true }))).toContain('Timeline: on, no beats yet');
  });
});
