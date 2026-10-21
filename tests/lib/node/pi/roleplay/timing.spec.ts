import { describe, expect, it } from 'vitest';

import { emptyLoreMeta, type LoreMeta } from '../../../../../lib/node/pi/roleplay/store.ts';
import {
  applyTiming,
  timingAllows,
  type TimingEntry,
  type TimingState,
} from '../../../../../lib/node/pi/roleplay/timing.ts';

/** Deterministic rng: cycles the given draws, repeating the last. */
function seqRng(...draws: number[]): () => number {
  let i = 0;
  return () => {
    const v = draws.length > 0 ? draws[Math.min(i, draws.length - 1)] : 0;
    i += 1;
    return v;
  };
}

function entry(id: string, matched: boolean, meta: Partial<LoreMeta> = {}): TimingEntry {
  return { id, matched, meta: { ...emptyLoreMeta(), ...meta } };
}

const NO_RNG = (): number => {
  throw new Error('rng should not be called');
};

describe('applyTiming', () => {
  it('fires matched default entries, skips unmatched', () => {
    const res = applyTiming([entry('a', true), entry('b', false)], 0, {}, NO_RNG);
    expect(res.fired).toEqual(['a']);
    expect(res.nextState).toEqual({});
  });

  it('constant entries fire without a match', () => {
    const res = applyTiming([entry('c', false, { constant: true })], 0, {}, NO_RNG);
    expect(res.fired).toEqual(['c']);
  });

  it('disabled lore cannot fire by match, constant, or sticky carry and never draws rng', () => {
    const res = applyTiming(
      [
        entry('matched', true, { enabled: false, probability: 50 }),
        entry('constant', false, { enabled: false, constant: true, probability: 50 }),
        entry('sticky', false, { enabled: false }),
        entry('active', true),
      ],
      1,
      { sticky: { stickyUntil: 99, cooldownUntil: 100 } },
      NO_RNG,
    );
    expect(res.fired).toEqual(['active']);
    expect(res.nextState).toEqual({});
  });

  it('re-enabling lore does not resurrect a disabled sticky window', () => {
    const disabled = applyTiming(
      [entry('a', false, { enabled: false })],
      1,
      { a: { stickyUntil: 99, cooldownUntil: 100 } },
      NO_RNG,
    );
    expect(applyTiming([entry('a', false)], 2, disabled.nextState, NO_RNG).fired).toEqual([]);
  });

  it('delay gates eligibility until turn >= delay', () => {
    const e = [entry('a', true, { delay: 2 })];
    expect(applyTiming(e, 0, {}, NO_RNG).fired).toEqual([]);
    expect(applyTiming(e, 1, {}, NO_RNG).fired).toEqual([]);
    expect(applyTiming(e, 2, {}, NO_RNG).fired).toEqual(['a']);
  });

  it('probability gates a fresh activation via rng', () => {
    const e = [entry('a', true, { probability: 30 })];
    expect(applyTiming(e, 0, {}, seqRng(0.29)).fired).toEqual(['a']); // 29 < 30
    expect(applyTiming(e, 0, {}, seqRng(0.3)).fired).toEqual([]); // 30 !< 30
    expect(applyTiming(e, 0, {}, seqRng(0.99)).fired).toEqual([]);
  });

  it('probability 0 never fires, 100 never draws rng', () => {
    expect(applyTiming([entry('a', true, { probability: 0 })], 0, {}, seqRng(0)).fired).toEqual([]);
    expect(applyTiming([entry('a', true, { probability: 100 })], 0, {}, NO_RNG).fired).toEqual(['a']);
  });

  it('sticky keeps an entry active for N further turns without a re-match', () => {
    const meta = { sticky: 2 };
    let state: Record<string, TimingState> = {};
    // turn 0: matched -> fresh fire, arms sticky window.
    let res = applyTiming([entry('a', true, meta)], 0, state, NO_RNG);
    expect(res.fired).toEqual(['a']);
    state = res.nextState;
    // turns 1 and 2: NOT matched, still carried by sticky.
    res = applyTiming([entry('a', false, meta)], 1, state, NO_RNG);
    expect(res.fired).toEqual(['a']);
    state = res.nextState;
    res = applyTiming([entry('a', false, meta)], 2, state, NO_RNG);
    expect(res.fired).toEqual(['a']);
    state = res.nextState;
    // turn 3: sticky window over, no match -> silent.
    res = applyTiming([entry('a', false, meta)], 3, state, NO_RNG);
    expect(res.fired).toEqual([]);
  });

  it('cooldown blocks re-firing for N turns after the active window', () => {
    const meta = { cooldown: 2 };
    let state: Record<string, TimingState> = {};
    const fireAt = (turn: number): string[] => {
      const res = applyTiming([entry('a', true, meta)], turn, state, NO_RNG);
      state = res.nextState;
      return res.fired;
    };
    expect(fireAt(0)).toEqual(['a']); // fresh fire
    expect(fireAt(1)).toEqual([]); // cooling
    expect(fireAt(2)).toEqual([]); // cooling
    expect(fireAt(3)).toEqual(['a']); // eligible again
  });

  it('inclusion group keeps exactly one fired member (weighted pick)', () => {
    const e = [entry('a', true, { group: 'g' }), entry('b', true, { group: 'g' })];
    // weights 100/100, total 200; rng 0.1 -> r=20 -> A wins (20-100<0).
    const win = applyTiming(e, 0, {}, seqRng(0.1));
    expect(win.fired).toEqual(['a']);
    // rng 0.9 -> r=180 -> A: 180-100=80>=0, B: 80-100<0 -> B wins.
    const win2 = applyTiming(e, 0, {}, seqRng(0.9));
    expect(win2.fired).toEqual(['b']);
  });

  it('group losers do not arm sticky/cooldown state', () => {
    const e = [entry('a', true, { group: 'g', sticky: 5 }), entry('b', true, { group: 'g', sticky: 5 })];
    const res = applyTiming(e, 0, {}, seqRng(0.1)); // A wins
    expect(res.fired).toEqual(['a']);
    expect(res.nextState.a).toBeDefined();
    expect(res.nextState.b).toBeUndefined(); // loser reverted, no sticky armed
  });

  it('groupWeight skews the pick', () => {
    const e = [entry('a', true, { group: 'g', groupWeight: 10 }), entry('b', true, { group: 'g', groupWeight: 90 })];
    // total 100; rng 0.5 -> r=50 -> A:50-10=40>=0, B:40-90<0 -> B wins.
    expect(applyTiming(e, 0, {}, seqRng(0.5)).fired).toEqual(['b']);
    // rng 0.05 -> r=5 -> A:5-10<0 -> A wins.
    expect(applyTiming(e, 0, {}, seqRng(0.05)).fired).toEqual(['a']);
  });

  it('a sticky carry is the group incumbent: it wins with no rng draw, fresh rivals stay unarmed', () => {
    const e = [entry('a', true, { group: 'g', sticky: 5 }), entry('b', true, { group: 'g', sticky: 5 })];
    const prior: Record<string, TimingState> = { b: { stickyUntil: 4, cooldownUntil: 4 } };
    const res = applyTiming(e, 1, prior, NO_RNG);
    expect(res.fired).toEqual(['b']);
    expect(res.nextState.b).toEqual({ stickyUntil: 4, cooldownUntil: 4 });
    expect(res.nextState.a).toBeUndefined();
    // The loser does not keep re-contesting: next turn the carry still wins outright.
    expect(applyTiming(e, 2, res.nextState, NO_RNG).fired).toEqual(['b']);
  });

  it('several carries in a group: highest groupWeight wins, then id', () => {
    const prior: Record<string, TimingState> = {
      a: { stickyUntil: 5, cooldownUntil: 5 },
      b: { stickyUntil: 5, cooldownUntil: 5 },
      c: { stickyUntil: 5, cooldownUntil: 5 },
    };
    const weighted = [
      entry('a', false, { group: 'g', groupWeight: 10 }),
      entry('b', false, { group: 'g', groupWeight: 90 }),
      entry('c', true, { group: 'g', groupWeight: 90 }),
    ];
    const res = applyTiming(weighted, 1, prior, NO_RNG);
    expect(res.fired).toEqual(['b']);
    // Losing carries keep their (unchanged) window.
    expect(res.nextState.a).toEqual(prior.a);
    expect(res.nextState.c).toEqual(prior.c);
  });

  it('carry tie-break uses code-unit id order, not locale order', () => {
    const prior: Record<string, TimingState> = {
      a: { stickyUntil: 5, cooldownUntil: 5 },
      B: { stickyUntil: 5, cooldownUntil: 5 },
    };
    const e = [entry('a', false, { group: 'g' }), entry('B', false, { group: 'g' })];
    // 'B' (0x42) < 'a' (0x61); localeCompare would pick 'a'.
    expect(applyTiming(e, 1, prior, NO_RNG).fired).toEqual(['B']);
  });

  it('rng order: probability rolls first, then only groups without an incumbent draw', () => {
    const draws: number[] = [];
    const rng = (): number => {
      const v = [0.1, 0.1, 0.9][draws.length] ?? 0;
      draws.push(v);
      return v;
    };
    const e = [
      entry('a', true, { group: 'g1', probability: 50 }),
      entry('b', true, { group: 'g1', probability: 50 }),
      entry('c', true, { group: 'g2' }),
      entry('d', false, { group: 'g2' }),
      entry('x', true, { group: 'g3' }),
      entry('y', true, { group: 'g3' }),
    ];
    const prior: Record<string, TimingState> = { d: { stickyUntil: 3, cooldownUntil: 3 } };
    const res = applyTiming(e, 1, prior, rng);
    // 2 probability rolls (a, b), g1 pick (0.9 -> b), g2 resolved by incumbent d (no draw), g3 pick (0 -> x).
    expect(draws).toEqual([0.1, 0.1, 0.9, 0]);
    expect(res.fired).toEqual(['b', 'd', 'x']);
  });
});

describe('timingAllows', () => {
  const meta = (over: Partial<LoreMeta> = {}): LoreMeta => ({ ...emptyLoreMeta(), ...over });

  it('rejects disabled entries and entries before their delay', () => {
    expect(timingAllows(meta({ enabled: false }), undefined, 5)).toBe(false);
    expect(timingAllows(meta({ delay: 3 }), undefined, 2)).toBe(false);
    expect(timingAllows(meta({ delay: 3 }), undefined, 3)).toBe(true);
  });

  it('rejects an active cooldown but allows a live sticky window', () => {
    expect(timingAllows(meta(), { stickyUntil: 2, cooldownUntil: 6 }, 4)).toBe(false);
    expect(timingAllows(meta(), { stickyUntil: 2, cooldownUntil: 6 }, 6)).toBe(true);
    expect(timingAllows(meta(), { stickyUntil: 5, cooldownUntil: 8 }, 4)).toBe(true);
  });
});
