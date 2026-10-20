import { describe, expect, it } from 'vitest';

import { type LoreChunk } from '../../../../../lib/node/pi/roleplay/budget.ts';
import {
  createLoreSelection,
  formatLoreReadout,
  loreTimingRows,
  recordDepthSelection,
  recordKeywordSelection,
  type LoreReadoutOptions,
} from '../../../../../lib/node/pi/roleplay/lore-readout.ts';
import { emptyLoreMeta, type RoleplayEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

function lore(id: string, order = 0, depth?: number): RoleplayEntry {
  return {
    id,
    kind: 'lore',
    name: id.toUpperCase(),
    description: '',
    lore: { ...emptyLoreMeta(), order, ...(depth === undefined ? {} : { depth }) },
  };
}

const chunk = (entry: RoleplayEntry, body: string): LoreChunk => ({ entry, body });

function opts(over: Partial<LoreReadoutOptions> = {}): LoreReadoutOptions {
  return {
    lorebookEnabled: true,
    snapshot: null,
    turn: 0,
    timingState: {},
    nameOf: (id) => id.toUpperCase(),
    bundles: [],
    ...over,
  };
}

describe('lore selection snapshot', () => {
  it('records kept + dropped keyword and depth lore', () => {
    const snap = createLoreSelection(3);
    recordKeywordSelection(snap, { kept: [chunk(lore('reef', 5), 'abcd')], dropped: [lore('spire', 1)] });
    recordDepthSelection(snap, { kept: [chunk(lore('deep', 0, 2), 'x')], dropped: [lore('far', 0, 4)] });
    expect(snap).toEqual({
      turn: 3,
      keywordKept: [{ id: 'reef', name: 'REEF', order: 5, chars: 4 }],
      keywordDropped: [{ id: 'spire', name: 'SPIRE', order: 1 }],
      depthKept: [{ id: 'deep', name: 'DEEP', depth: 2 }],
      depthDropped: [{ id: 'far', name: 'FAR', depth: 4 }],
    });
  });
});

describe('loreTimingRows', () => {
  it('counts remaining sticky and cooldown turns after the current turn', () => {
    // Fired at turn 2 with sticky 2, cooldown 3 => stickyUntil 5, cooldownUntil 8.
    const state = { a: { stickyUntil: 5, cooldownUntil: 8 }, b: { stickyUntil: 3, cooldownUntil: 5 } };
    expect(loreTimingRows(state, 2, (id) => id)).toEqual([
      { id: 'a', name: 'a', stickyTurns: 2, cooldownTurns: 3 },
      { id: 'b', name: 'b', stickyTurns: 0, cooldownTurns: 2 },
    ]);
    // Everything expired.
    expect(loreTimingRows(state, 8, (id) => id)).toEqual([]);
  });

  it('falls back to the id when the entry has no name', () => {
    expect(loreTimingRows({ gone: { stickyUntil: 9, cooldownUntil: 9 } }, 1, () => undefined)[0].name).toBe('gone');
  });
});

describe('formatLoreReadout', () => {
  it('reports a disabled lorebook', () => {
    expect(formatLoreReadout(opts({ lorebookEnabled: false }))).toContain('Lorebook is disabled');
  });

  it('reports no narrative turn yet', () => {
    const out = formatLoreReadout(opts({ bundles: ['winter', 'night'] }));
    expect(out).toContain('bundles: winter, night');
    expect(out).toContain('No narrative turn yet');
  });

  it('renders kept, dropped, depth, and timing rows', () => {
    const snap = createLoreSelection(2);
    recordKeywordSelection(snap, { kept: [chunk(lore('reef', 5), 'abcd')], dropped: [lore('spire', 1)] });
    recordDepthSelection(snap, { kept: [chunk(lore('deep', 0, 2), 'x')], dropped: [] });
    const out = formatLoreReadout(
      opts({ snapshot: snap, turn: 2, timingState: { reef: { stickyUntil: 4, cooldownUntil: 6 } } }),
    );
    expect(out).toBe(
      [
        'Roleplay lore (turn 2; bundles: (none))',
        '  Last selection: turn 2',
        '  Keyword lore kept (1):',
        '    REEF  order=5  4 chars',
        '  Dropped by the lore budget (1):',
        '    SPIRE  order=1',
        '  Depth lore kept (1):',
        '    DEEP  depth=2',
        '  Timing windows (1):',
        '    REEF: sticky 1 turn, then cooldown 2 turns',
      ].join('\n'),
    );
  });

  it('notes empty selections and unselected depth lore', () => {
    const out = formatLoreReadout(opts({ snapshot: createLoreSelection(1), turn: 1 }));
    expect(out).toContain('(none fired)');
    expect(out).toContain('Depth lore: not selected this turn');
    expect(out).toContain('(no active sticky or cooldown)');
  });
});
