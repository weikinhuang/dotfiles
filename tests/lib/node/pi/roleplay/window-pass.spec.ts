import { describe, expect, it } from 'vitest';

import {
  computeCutoff,
  DEFAULT_WINDOW_OPTIONS,
  estimateChars,
  RECAP_PREFIX,
  TIMELINE_PREFIX,
} from '../../../../../lib/node/pi/roleplay/context-window.ts';
import {
  applyWindowPass,
  FLOOR_MIN_OUTPUT_TOKENS,
  FLOOR_RESERVE_TOKENS,
  planWindowFloor,
} from '../../../../../lib/node/pi/roleplay/window-pass.ts';

type Msg = Record<string, unknown>;

/** Alternating user/assistant transcript; each message is `chars + ~4` chars long. */
function transcript(turns: number, chars: number): Msg[] {
  const body = 'x'.repeat(chars);
  const out: Msg[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `u${i} ${body}` });
    out.push({ role: 'assistant', content: `a${i} ${body}` });
  }
  return out;
}

function firstText(m: Msg | undefined): string {
  const c = m?.content;
  return typeof c === 'string' ? c : '';
}

describe('planWindowFloor', () => {
  const messages = transcript(20, 400);
  const base = {
    messages,
    sysChars: 0,
    injectChars: 0,
    charsPerToken: 4,
    frozenFloorCutoff: 0,
    recapCutoff: 0,
  };

  it('is disabled without a positive window size', () => {
    for (const windowTokens of [undefined, 0, -5, Number.NaN]) {
      expect(planWindowFloor({ ...base, windowTokens, frozenFloorCutoff: 7 })).toEqual({
        frozenFloorCutoff: 7,
        floorCutoff: 0,
      });
    }
  });

  it('cuts to the fit floor on the first pass (nothing frozen yet => held estimate is unbounded)', () => {
    const plan = planWindowFloor({ ...base, windowTokens: FLOOR_RESERVE_TOKENS + 2000 });
    // ~2000 tokens * 4 chars fits 19 ~404-char messages => 9 user turns kept.
    expect(plan.floorCutoff).toBe(computeCutoff(messages, 9));
    expect(plan.floorCutoff).toBe(22);
    expect(plan.frozenFloorCutoff).toBe(plan.floorCutoff);
    expect(messages[plan.floorCutoff].role).toBe('user');
  });

  it('keeps a transcript that fits entirely at floor 0', () => {
    expect(planWindowFloor({ ...base, windowTokens: 100_000 })).toEqual({ frozenFloorCutoff: 0, floorCutoff: 0 });
  });

  it('holds the frozen floor while the held suffix stays under the looser overflow limit', () => {
    // Held suffix from 30 = 10 messages (~1010 tokens); the fit target would be 22.
    const windowTokens = FLOOR_RESERVE_TOKENS + 2000;
    const held = estimateChars(messages.slice(30)) / 4;
    expect(held).toBeLessThan(windowTokens - FLOOR_MIN_OUTPUT_TOKENS);
    expect(planWindowFloor({ ...base, windowTokens, frozenFloorCutoff: 30 })).toEqual({
      frozenFloorCutoff: 30,
      floorCutoff: 30,
    });
    // A frozen floor BELOW the fit floor also holds while the overflow valve is closed.
    const loose = FLOOR_MIN_OUTPUT_TOKENS + Math.ceil(estimateChars(messages.slice(10)) / 4) + 1;
    expect(planWindowFloor({ ...base, windowTokens: loose, frozenFloorCutoff: 10 })).toEqual({
      frozenFloorCutoff: 10,
      floorCutoff: 10,
    });
  });

  it('opens the overflow valve and advances to the raw fit floor when holding would overflow', () => {
    // ~1000-token fit => 4 user turns; held suffix from 2 (~3838 tokens) exceeds the 3048-token valve.
    const windowTokens = FLOOR_RESERVE_TOKENS + 1000;
    expect(planWindowFloor({ ...base, windowTokens, frozenFloorCutoff: 2 })).toEqual({
      frozenFloorCutoff: 32,
      floorCutoff: 32,
    });
  });

  it('estimates the held suffix from the recap drop boundary when it drops more than the floor', () => {
    const windowTokens = FLOOR_RESERVE_TOKENS + 1000;
    expect(planWindowFloor({ ...base, windowTokens, frozenFloorCutoff: 2, recapCutoff: 30 })).toEqual({
      frozenFloorCutoff: 2,
      floorCutoff: 2,
    });
  });

  it('never regresses a frozen floor even when the valve fires with a smaller raw floor', () => {
    const windowTokens = FLOOR_RESERVE_TOKENS + 2000;
    // Inject overhead shrinks the fit, but a frozen floor past the raw one stays put.
    expect(planWindowFloor({ ...base, windowTokens, frozenFloorCutoff: 38, injectChars: 0 }).floorCutoff).toBe(38);
  });

  it('charges system + injected chars against the budget and defaults a non-positive cpt', () => {
    const windowTokens = FLOOR_RESERVE_TOKENS + 2000;
    const plain = planWindowFloor({ ...base, windowTokens }).floorCutoff;
    const heavy = planWindowFloor({ ...base, windowTokens, sysChars: 2000, injectChars: 2000 }).floorCutoff;
    expect(heavy).toBeGreaterThan(plain);
    expect(planWindowFloor({ ...base, windowTokens, charsPerToken: 0 }).floorCutoff).toBe(plain);
  });

  it('pins current behavior when the overhead alone exceeds the window: the valve stays shut', () => {
    // convBudget and overflowLimit are both negative, so a cold floor never engages and a frozen one holds.
    expect(planWindowFloor({ ...base, windowTokens: 1000, sysChars: 100_000 })).toEqual({
      frozenFloorCutoff: 0,
      floorCutoff: 0,
    });
    expect(planWindowFloor({ ...base, windowTokens: 1000, sysChars: 100_000, frozenFloorCutoff: 12 }).floorCutoff).toBe(
      12,
    );
  });
});

describe('applyWindowPass', () => {
  const opts = { ...DEFAULT_WINDOW_OPTIONS, userChars: 40, assistantChars: 40 };
  const messages = transcript(10, 400);
  const base = {
    messages,
    dropCutoff: 0,
    floorCutoff: 0,
    committedCutoff: 0,
    recapText: '',
    timelineBlock: null,
    opts,
  };

  it('recap mode: drops, condenses, then prefixes recap and timeline onto the first user', () => {
    const out = applyWindowPass({
      ...base,
      recapMode: true,
      dropCutoff: 4,
      committedCutoff: 8,
      recapText: 'RECAP',
      timelineBlock: 'BEATS',
    });
    expect(out.changed).toBe(true);
    expect(out.messages).toHaveLength(messages.length - 4);
    const head = firstText(out.messages[0]);
    expect(out.messages[0].role).toBe('user');
    expect(head.startsWith(`${TIMELINE_PREFIX}\nBEATS\n]\n\n${RECAP_PREFIX}\nRECAP\n]\n\n`)).toBe(true);
    // [4, 8) condensed, [8, end) verbatim.
    expect(head).toContain('chars trimmed');
    expect(firstText(out.messages[4])).toBe(firstText(messages[8]));
  });

  it('recap mode: the condense boundary never falls below the drop boundary', () => {
    const out = applyWindowPass({ ...base, recapMode: true, dropCutoff: 6, committedCutoff: 2 });
    expect(out.messages).toHaveLength(messages.length - 6);
    expect(firstText(out.messages[0])).toBe(firstText(messages[6]));
  });

  it('recap mode: blank recap, no timeline, nothing to cut is a no-op on the same array', () => {
    const out = applyWindowPass({ ...base, recapMode: true, recapText: '   \n' });
    expect(out).toEqual({ messages, changed: false });
    expect(out.messages).toBe(messages);
  });

  it('recap mode ignores floorCutoff except through dropCutoff', () => {
    const out = applyWindowPass({ ...base, recapMode: true, floorCutoff: 6 });
    expect(out.changed).toBe(false);
  });

  it('non-recap floor: hard-drops to floorCutoff and condenses up to committedCutoff', () => {
    const out = applyWindowPass({
      ...base,
      recapMode: false,
      floorCutoff: 4,
      committedCutoff: 8,
      recapText: 'IGNORED',
      timelineBlock: 'IGNORED',
    });
    expect(out.changed).toBe(true);
    expect(out.messages).toHaveLength(messages.length - 4);
    expect(JSON.stringify(out.messages)).not.toContain('IGNORED');
    expect(firstText(out.messages[0])).toContain('chars trimmed');
  });

  it('condense-only floor: keeps every message and condenses before committedCutoff', () => {
    const out = applyWindowPass({ ...base, recapMode: false, committedCutoff: 4, recapText: 'IGNORED' });
    expect(out.changed).toBe(true);
    expect(out.messages).toHaveLength(messages.length);
    expect(firstText(out.messages[3])).toContain('chars trimmed');
    expect(out.messages[4]).toBe(messages[4]);
    expect(applyWindowPass({ ...base, recapMode: false })).toEqual({ messages, changed: false });
  });
});
