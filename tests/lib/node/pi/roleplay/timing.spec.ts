import { describe, expect, it } from 'vitest';

import { emptyLoreMeta, type LoreMeta } from '../../../../../lib/node/pi/roleplay/store.ts';
import { applyTiming, type TimingEntry, type TimingState } from '../../../../../lib/node/pi/roleplay/timing.ts';

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
});
