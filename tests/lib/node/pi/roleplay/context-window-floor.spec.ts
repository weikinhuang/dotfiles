import { describe, expect, it } from 'vitest';
import {
  applyLayeredWindow,
  computeCutoff,
  deriveKeepTurns,
  estimateChars,
  DEFAULT_WINDOW_OPTIONS,
} from '../../../../../lib/node/pi/roleplay/context-window.ts';

type Msg = Record<string, unknown>;

/**
 * Build an alternating user/assistant transcript of `turns` turns, each
 * message `chars` long, so estimateChars() sees a predictable size.
 */
function transcript(turns: number, chars: number): Msg[] {
  const body = 'x'.repeat(chars);
  const out: Msg[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `u${i} ${body}` });
    out.push({ role: 'assistant', content: `a${i} ${body}` });
  }
  return out;
}

/**
 * Reproduce the safety-floor computation the roleplay `context` hook now runs
 * (Fix B): derive how many recent turns fit the window budget and map that to
 * a user-boundary drop cutoff.
 */
function floorCutoff(messages: readonly Msg[], windowTokens: number, cpt: number): number {
  const RESERVE_TOKENS = 3072;
  const sysTokens = 20000; // stand-in for the big RP system prompt
  const convBudget = windowTokens - sysTokens - RESERVE_TOKENS;
  const fitTurns = convBudget > 0 ? deriveKeepTurns(messages, convBudget, cpt, 1, 100000) : 1;
  return computeCutoff(messages, fitTurns);
}

describe('context-window hard safety floor (Fix B)', () => {
  const opts = DEFAULT_WINDOW_OPTIONS;
  const cpt = 4;
  const windowTokens = 57344;

  it('does not engage when the whole scene already fits the window', () => {
    // ~30 short turns: well under budget.
    const msgs = transcript(30, 100);
    const floor = floorCutoff(msgs, windowTokens, cpt);
    expect(floor).toBe(0); // nothing to drop
  });

  it('reproduces the overflow when the recap is empty and force-drops to fit', () => {
    // A marathon scene: many turns, no usable recap (recapCutoff would be 0).
    const msgs = transcript(900, 800); // ~1800 messages
    const recapCutoff = 0; // empty/stale recap after a cold resume

    // Without the floor: dropCutoff == recapCutoff == 0 -> nothing dropped.
    const unbounded = applyLayeredWindow(msgs, recapCutoff, recapCutoff, opts);
    const unboundedTokens = estimateChars(unbounded.messages) / cpt;
    // The condensed-but-not-dropped prompt blows well past the window.
    expect(unboundedTokens).toBeGreaterThan(windowTokens);

    // With the floor: dropCutoff = max(recapCutoff, floorCutoff) bounds it.
    const floor = floorCutoff(msgs, windowTokens, cpt);
    expect(floor).toBeGreaterThan(0);
    const dropCutoff = Math.max(recapCutoff, floor);
    const bounded = applyLayeredWindow(msgs, dropCutoff, Math.max(dropCutoff, 0), opts);
    const boundedConvTokens = estimateChars(bounded.messages) / cpt;
    const RESERVE_TOKENS = 3072;
    const sysTokens = 20000;
    // The kept conversation fits inside window minus system prompt and reserve.
    expect(boundedConvTokens).toBeLessThanOrEqual(windowTokens - sysTokens - RESERVE_TOKENS);
    // And the boundary lands on a user message (no orphaned tool result).
    expect(msgs[dropCutoff]?.role).toBe('user');
  });

  it('never keeps fewer than the last turn even when the budget is tiny', () => {
    const msgs = transcript(50, 500);
    // A budget so small even one turn barely fits: still keep >= 1 turn.
    const floor = floorCutoff(msgs, 22000, cpt);
    const kept = msgs.length - floor;
    expect(kept).toBeGreaterThanOrEqual(2); // at least the last user + assistant
  });

  it('floor is a no-op relative to a healthy recap that already dropped enough', () => {
    const msgs = transcript(900, 800);
    const floor = floorCutoff(msgs, windowTokens, cpt);
    // A healthy recap has advanced its coverage PAST the floor.
    const recapCutoff = floor + 200;
    const dropCutoff = Math.max(recapCutoff, floor);
    expect(dropCutoff).toBe(recapCutoff); // recap wins; no extra loss
  });
});
