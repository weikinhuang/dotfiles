import { describe, expect, it } from 'vitest';

import {
  emptyCharacterMeta,
  emptyLoreMeta,
  emptyRelationshipMeta,
  lastInteractionError,
} from '../../../../../lib/node/pi/roleplay/store.ts';
import {
  buildCharacterMeta,
  buildLoreMeta,
  buildRelationshipMeta,
} from '../../../../../lib/node/pi/roleplay/tool-params.ts';

describe('buildLoreMeta', () => {
  it('starts from empty lore meta with no params', () => {
    expect(buildLoreMeta({ action: 'save' })).toEqual(emptyLoreMeta());
  });

  it('cleans keyword lists, floors numbers, and maps every lore field', () => {
    expect(
      buildLoreMeta({
        action: 'save',
        triggers: [' reef ', '', '  '],
        secondaryKeys: ['tide', ' '],
        secondaryMode: 'NOT',
        constant: true,
        order: 3.9,
        depth: 2.7,
        recurse: true,
      }),
    ).toEqual({
      ...emptyLoreMeta(),
      triggers: ['reef'],
      secondaryKeys: ['tide'],
      secondaryMode: 'NOT',
      constant: true,
      order: 3,
      depth: 2,
      recurse: true,
    });
  });

  it('layers over a base without mutating it, and a negative depth clears it', () => {
    const base = { ...emptyLoreMeta(), triggers: ['a'], secondaryKeys: ['b'], depth: 4, order: 9 };
    const snapshot = structuredClone(base);
    const out = buildLoreMeta({ action: 'update', depth: -1 }, base);
    expect(out).not.toHaveProperty('depth');
    expect(out).toMatchObject({ triggers: ['a'], secondaryKeys: ['b'], order: 9 });
    expect(out.triggers).not.toBe(base.triggers);
    expect(base).toEqual(snapshot);
  });
});

describe('buildCharacterMeta', () => {
  it('maps aliases / triggers / pinned / order over a base copy', () => {
    const base = { ...emptyCharacterMeta(), aliases: ['Old'], triggers: ['t'], order: 2 };
    const out = buildCharacterMeta({ action: 'update', aliases: [' Mira ', ''], pinned: true, order: 5.5 }, base);
    expect(out).toEqual({ ...base, aliases: ['Mira'], pinned: true, order: 5 });
    expect(base.aliases).toEqual(['Old']);
    expect(buildCharacterMeta({ action: 'save' })).toEqual(emptyCharacterMeta());
  });
});

describe('buildRelationshipMeta', () => {
  it('clamps affinity to 0-100 and trims trust', () => {
    expect(buildRelationshipMeta({ action: 'save', affinity: 150.5, trust: ' high ' })).toEqual({
      ...emptyRelationshipMeta(),
      affinity: 100,
      trust: 'high',
    });
    expect(buildRelationshipMeta({ action: 'save', affinity: -3 }).affinity).toBe(0);
    expect(buildRelationshipMeta({ action: 'save', affinity: 42.9 }).affinity).toBe(42);
  });

  it('sets, trims, and clears lastInteraction, and cleans open threads', () => {
    const base = { ...emptyRelationshipMeta(), lastInteraction: '2024-01-01', openThreads: ['x'] };
    expect(buildRelationshipMeta({ action: 'update', lastInteraction: ' 2024-02-03 ' }, base).lastInteraction).toBe(
      '2024-02-03',
    );
    const cleared = buildRelationshipMeta({ action: 'update', lastInteraction: '  ', openThreads: [' a ', ''] }, base);
    expect(cleared).not.toHaveProperty('lastInteraction');
    expect(cleared.openThreads).toEqual(['a']);
    expect(base).toEqual({ ...emptyRelationshipMeta(), lastInteraction: '2024-01-01', openThreads: ['x'] });
  });

  it('lastInteraction validation (store.ts) accepts ISO dates and blanks only', () => {
    expect(lastInteractionError(undefined)).toBeNull();
    expect(lastInteractionError(' ')).toBeNull();
    expect(lastInteractionError('2024-02-03')).toBeNull();
    expect(lastInteractionError('yesterday')).toEqual(expect.any(String));
  });
});
