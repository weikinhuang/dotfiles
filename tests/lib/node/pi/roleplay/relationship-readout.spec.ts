import { describe, expect, it } from 'vitest';

import { formatRelationshipsReadout } from '../../../../../lib/node/pi/roleplay/relationship-readout.ts';

const now = new Date('2024-03-11T12:00:00Z');
const decay = { decayPerDay: 1, baseline: 50 };

describe('formatRelationshipsReadout', () => {
  it('reports an empty cast', () => {
    expect(formatRelationshipsReadout([], now, decay)).toContain('no relationship records');
  });

  it('lists stored + projected affinity, trust, last interaction, and threads sorted by name', () => {
    const out = formatRelationshipsReadout(
      [
        {
          id: 'mira-kai',
          name: 'Mira & Kai',
          meta: { affinity: 72, trust: 'high', lastInteraction: '2024-03-01', openThreads: ['the debt', 'the map'] },
        },
        { id: 'ash-bo', name: 'Ash & Bo', meta: { affinity: 40, trust: '', openThreads: [] } },
      ],
      now,
      decay,
    );
    expect(out).toBe(
      [
        'Relationships (2; decay 1/day toward 50):',
        '  Ash & Bo (ash-bo)',
        '    affinity 40/100',
        '    last interaction: (unset; no decay)',
        '    open threads: (none)',
        '  Mira & Kai (mira-kai)',
        '    affinity 62/100 (stored 72, neutral 50), trust: high',
        '    last interaction: 2024-03-01 (10 day(s) ago)',
        '    open threads: the debt; the map',
      ].join('\n'),
    );
  });
});
