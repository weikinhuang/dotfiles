import { describe, expect, it } from 'vitest';

import { clampSummary } from '../../../../../lib/node/pi/roleplay/summarize.ts';
import {
  acceptRecap,
  applyContextWindowAt,
  applyLayeredWindow,
  boundRollSpanTo,
  computeCutoff,
  condenseMessage,
  DEFAULT_CHARS_PER_TOKEN,
  deriveKeepTurns,
  deriveMaxSpanChars,
  estimateChars,
  freezeFloorCutoff,
  injectRecap,
  injectTimeline,
  planRecap,
  RECAP_PREFIX,
  shouldForceRecap,
  snapDropToUserBoundary,
  TIMELINE_PREFIX,
  truncateText,
  updateCharsPerToken,
  type WindowOptions,
} from '../../../../../lib/node/pi/roleplay/context-window.ts';

type Msg = Record<string, unknown>;

const OPTS: WindowOptions = { keepTurns: 2, assistantChars: 30, userChars: 40 };

/** Build a simple user/assistant transcript of `n` turn-pairs with given text length. */
function transcript(turns: number, chars = 100): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `U${i} ` + 'u'.repeat(chars) });
    out.push({ role: 'assistant', content: `A${i} ` + 'a'.repeat(chars) });
  }
  return out;
}

describe('truncateText', () => {
  it('returns null when text is within budget', () => {
    expect(truncateText('short', 100)).toBeNull();
  });

  it('keeps both head and tail with a marker', () => {
    const text = 'HEAD_START ' + 'x'.repeat(200) + ' TAIL_END';
    const out = truncateText(text, 40);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(text.length);
    expect(out).toContain('chars trimmed');
    expect(out).toContain('HEAD');
    expect(out).toContain('END');
  });

  it('preserves a buried-tail fact that head-only truncation would drop', () => {
    const text = 'The scene opens in a tavern. ' + 'filler '.repeat(60) + 'REMEMBER: User is allergic to shellfish.';
    const out = truncateText(text, 60);
    expect(out).not.toBeNull();
    expect(out).toContain('shellfish');
  });
});

describe('condenseMessage', () => {
  it('condenses string content over budget', () => {
    const msg: Msg = { role: 'assistant', content: 'z'.repeat(200) };
    const out = condenseMessage(msg, 30);
    expect(out).not.toBeNull();
    expect(String((out as Msg).content).length).toBeLessThan(200);
  });

  it('condenses text parts inside array content, leaving non-text parts intact', () => {
    const msg: Msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'q'.repeat(200) },
        { type: 'toolCall', name: 'x', arguments: { a: 1 } },
      ],
    };
    const out = condenseMessage(msg, 30) as Msg;
    expect(out).not.toBeNull();
    const parts = out.content as Record<string, unknown>[];
    expect(parts[1]).toEqual({ type: 'toolCall', name: 'x', arguments: { a: 1 } });
    expect((parts[0].text as string).length).toBeLessThan(200);
  });

  it('returns null for zero/negative budget', () => {
    expect(condenseMessage({ role: 'user', content: 'x'.repeat(50) }, 0)).toBeNull();
  });
});

describe('computeCutoff', () => {
  it('returns 0 when there is not enough history', () => {
    expect(computeCutoff(transcript(2), 2)).toBe(0);
    expect(computeCutoff(transcript(1), 2)).toBe(0);
  });

  it('lands on a user-message boundary', () => {
    const msgs = transcript(5); // 10 messages, users at 0,2,4,6,8
    const cutoff = computeCutoff(msgs, 2); // keep last 2 user-turns -> user idx 6
    expect(cutoff).toBe(6);
    expect(msgs[cutoff].role).toBe('user');
  });
});

describe('applyContextWindowAt', () => {
  it('no-ops at cutoff 0', () => {
    const msgs = transcript(3);
    const out = applyContextWindowAt(msgs, 0, OPTS);
    expect(out.condensed).toBe(0);
    expect(out.messages).toBe(msgs);
  });

  it('condenses before the cutoff, keeps the rest verbatim (every message kept)', () => {
    const msgs = transcript(5); // 10 msgs
    const cutoff = computeCutoff(msgs, 2); // 6
    const out = applyContextWindowAt(msgs, cutoff, OPTS);
    expect(out.messages.length).toBe(msgs.length); // nothing dropped
    expect(out.condensed).toBeGreaterThan(0);
    // verbatim tail unchanged
    expect(out.messages[cutoff]).toBe(msgs[cutoff]);
    // condensed head shortened
    expect(String(out.messages[0].content).length).toBeLessThan(String(msgs[0].content).length);
  });
});

describe('applyLayeredWindow', () => {
  it('drops the recap-covered prefix (bounded), condenses the boundary, keeps the tail', () => {
    const msgs = transcript(6); // 12 msgs, users at 0,2,4,6,8,10
    const condenseCutoff = computeCutoff(msgs, 2); // 8
    const dropCutoff = 4; // user boundary
    const out = applyLayeredWindow(msgs, dropCutoff, condenseCutoff, OPTS);
    expect(out.dropped).toBe(4);
    expect(out.messages.length).toBe(msgs.length - 4);
    expect(out.condensed).toBeGreaterThan(0);
    // last message preserved verbatim
    expect(out.messages[out.messages.length - 1]).toBe(msgs[msgs.length - 1]);
  });

  it('no-ops when both cutoffs are 0', () => {
    const msgs = transcript(3);
    const out = applyLayeredWindow(msgs, 0, 0, OPTS);
    expect(out).toEqual({ messages: msgs, dropped: 0, condensed: 0 });
  });

  it('clamps condenseCutoff below dropCutoff up to dropCutoff', () => {
    const msgs = transcript(4);
    const out = applyLayeredWindow(msgs, 4, 2, OPTS);
    expect(out.dropped).toBe(4);
    expect(out.messages.length).toBe(msgs.length - 4);
  });

  it('never leaves a leading toolResult when the drop splits a toolCall from its result', () => {
    const msgs: Msg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'x', arguments: {} }] },
      { role: 'toolResult', toolCallId: 't1', content: 'r1' },
      { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't2', name: 'x', arguments: {} }] },
      { role: 'toolResult', toolCallId: 't2', content: 'r2' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    for (const drop of [2, 6]) {
      const out = applyLayeredWindow(msgs, drop, drop, OPTS);
      expect(out.messages[0].role).toBe('user');
      expect(msgs[out.dropped].role).toBe('user');
    }
    // drop=6 (toolResult) snaps back to the user at 4
    expect(applyLayeredWindow(msgs, 6, 6, OPTS).dropped).toBe(4);
  });
});

describe('acceptRecap', () => {
  it('accepts when there is no prior', () => {
    expect(acceptRecap('', 'a fresh recap')).toBe(true);
  });

  it('rejects an empty/null candidate', () => {
    expect(acceptRecap('prior', null)).toBe(false);
    expect(acceptRecap('prior', '   ')).toBe(false);
  });

  it('rejects a collapse below the floor fraction', () => {
    const prior = 'x'.repeat(3456);
    expect(acceptRecap(prior, 'y'.repeat(95))).toBe(false);
    expect(acceptRecap(prior, 'y'.repeat(2000))).toBe(true);
  });
});

describe('injectRecap', () => {
  it('prefixes the first user message (string content)', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hello' }];
    const out = injectRecap(msgs, 'the scene so far');
    expect(String(out[0].content)).toContain(RECAP_PREFIX);
    expect(String(out[0].content)).toContain('hello');
  });

  it('prefixes the first text part of array content', () => {
    const msgs: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const out = injectRecap(msgs, 'recap');
    const parts = out[0].content as Record<string, unknown>[];
    expect(parts[0].text).toContain('recap');
    expect(parts[0].text).toContain('hi');
  });

  it('returns the same array when recap is empty', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hi' }];
    expect(injectRecap(msgs, '   ')).toBe(msgs);
  });
});

describe('injectTimeline', () => {
  it('prefixes the first user message with the timeline block', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hello' }];
    const out = injectTimeline(msgs, '- [Thursday 6pm] Mira visits');
    expect(String(out[0].content)).toContain(TIMELINE_PREFIX);
    expect(String(out[0].content)).toContain('Mira visits');
    expect(String(out[0].content)).toContain('hello');
  });

  it('stacks separately from the recap prefix', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'x' }];
    const out = injectTimeline(injectRecap(msgs, 'recap here'), '- a beat');
    const content = String(out[0].content);
    expect(content).toContain(TIMELINE_PREFIX);
    expect(content).toContain(RECAP_PREFIX);
  });

  it('returns the same array when the block is empty', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hi' }];
    expect(injectTimeline(msgs, '   ')).toBe(msgs);
  });
});

describe('planRecap', () => {
  it('fires once the aged span grows by chunk since the last roll', () => {
    expect(planRecap(0, 0, 8)).toBe(false);
    expect(planRecap(7, 0, 8)).toBe(false);
    expect(planRecap(8, 0, 8)).toBe(true);
    expect(planRecap(16, 8, 8)).toBe(true);
    expect(planRecap(15, 8, 8)).toBe(false);
  });
});

describe('freezeFloorCutoff', () => {
  it('holds the frozen index between rolls even as the raw floor creeps up', () => {
    // The raw fit floor advances a message or two every turn; freezing pins the
    // drop boundary so the prompt prefix stays byte-stable and cache survives.
    let frozen = 100;
    for (const rawFloor of [102, 104, 106, 108]) {
      frozen = freezeFloorCutoff({ frozen, rawFloor, overflow: false });
      expect(frozen).toBe(100);
    }
  });

  it('advances mid-cycle only when holding would overflow (hard-safety valve)', () => {
    expect(freezeFloorCutoff({ frozen: 100, rawFloor: 130, overflow: true })).toBe(130);
    // Never regresses below the frozen index on an overflow valve.
    expect(freezeFloorCutoff({ frozen: 140, rawFloor: 120, overflow: true })).toBe(140);
  });
});

describe('boundRollSpanTo', () => {
  /** `n` user messages: every index is a user boundary, so snapping is the identity. */
  const users = (n: number): Msg[] => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `U${i}` }));
  const U = { role: 'user', content: 'u' };
  const A = { role: 'assistant', content: 'a' };
  const T = { role: 'toolResult', content: 'r' };

  it('caps the advance to recapCutoff + maxAdvance', () => {
    expect(boundRollSpanTo(users(2000), 1643, 1947, 24)).toBe(1667);
  });

  it('never overshoots natural when the remaining span is small', () => {
    expect(boundRollSpanTo(users(2000), 1940, 1947, 24)).toBe(1947);
  });

  it('maxAdvance <= 0 disables the cap (legacy spanTo = natural)', () => {
    expect(boundRollSpanTo(users(2000), 1643, 1947, 0)).toBe(1947);
    expect(boundRollSpanTo(users(2000), 1643, 1947, -5)).toBe(1947);
  });

  it('drains a stalled backlog in bounded steps instead of re-attempting it whole', () => {
    // A wedged recap 300 messages behind advances 24/roll rather than retrying
    // the entire 300-message span (which is what collapsed + wedged it).
    const msgs = users(2000);
    let recapCutoff = 1643;
    const natural = 1943; // 300 behind; fixed for this check
    const steps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const spanTo = boundRollSpanTo(msgs, recapCutoff, natural, 24);
      steps.push(spanTo - recapCutoff);
      recapCutoff = spanTo; // simulate an accepted incremental roll
    }
    expect(steps).toEqual([24, 24, 24, 24, 24]);
    expect(recapCutoff).toBe(1763); // 1643 + 5*24, still draining toward natural
  });

  it('snaps down to a user boundary when the bound lands on an assistant message', () => {
    const msgs = transcript(10); // users at even indices
    // bound = 0 + 5 = 5 (assistant) -> last user in (0, 5] is 4
    expect(boundRollSpanTo(msgs, 0, 18, 5)).toBe(4);
    expect(msgs[4].role).toBe('user');
  });

  it('snaps down past a toolResult so a tool call is never split from its result', () => {
    // 0:U 1:A(toolCall) 2:T 3:A 4:U 5:A 6:T 7:A 8:U 9:A 10:U
    const msgs: Msg[] = [U, A, T, A, U, A, T, A, U, A, U];
    expect(boundRollSpanTo(msgs, 0, 10, 6)).toBe(4); // bound 6 = toolResult
    expect(boundRollSpanTo(msgs, 0, 10, 7)).toBe(4); // bound 7 = assistant
  });

  it('falls forward to the next user when (recapCutoff, bound] holds none', () => {
    // 0:U then a long single turn 1..6, next user at 7, natural 9
    const msgs: Msg[] = [U, A, T, A, T, A, T, U, A, U];
    expect(boundRollSpanTo(msgs, 0, 9, 3)).toBe(7);
  });

  it('falls forward to natural when no user lies before it, and never exceeds natural', () => {
    const msgs: Msg[] = [U, A, T, A, T, A, T, A, U, A];
    expect(boundRollSpanTo(msgs, 0, 8, 3)).toBe(8);
    for (let adv = 1; adv < 20; adv++) {
      expect(boundRollSpanTo(msgs, 0, 8, adv)).toBeLessThanOrEqual(8);
    }
  });
});

describe('snapDropToUserBoundary', () => {
  const U = { role: 'user', content: 'u' };
  const A = { role: 'assistant', content: 'a' };
  const T = { role: 'toolResult', content: 'r' };
  // 0:U 1:A 2:T 3:A 4:U 5:A
  const msgs: Msg[] = [U, A, T, A, U, A];

  it('leaves a user index unchanged', () => {
    expect(snapDropToUserBoundary(msgs, 4)).toBe(4);
  });

  it('snaps an assistant or toolResult index back to the previous user', () => {
    expect(snapDropToUserBoundary(msgs, 5)).toBe(4);
    // No user in (0, 2], so it falls forward to the next user.
    expect(snapDropToUserBoundary(msgs, 2)).toBe(4);
    const more: Msg[] = [U, A, U, A, T, A];
    expect(snapDropToUserBoundary(more, 3)).toBe(2);
    expect(snapDropToUserBoundary(more, 4)).toBe(2);
  });

  it('returns 0 and >= length unchanged', () => {
    expect(snapDropToUserBoundary(msgs, 0)).toBe(0);
    expect(snapDropToUserBoundary(msgs, msgs.length)).toBe(msgs.length);
    expect(snapDropToUserBoundary(msgs, msgs.length + 3)).toBe(msgs.length + 3);
  });
});

describe('shouldForceRecap', () => {
  it('does not force while the lag is tolerable', () => {
    expect(shouldForceRecap({ candidate: 'short recap', lag: 40, lagCeiling: 96 })).toBe(false);
  });

  it('forces once the uncovered lag reaches the ceiling', () => {
    expect(shouldForceRecap({ candidate: 'short recap', lag: 96, lagCeiling: 96 })).toBe(true);
    expect(shouldForceRecap({ candidate: 'short recap', lag: 300, lagCeiling: 96 })).toBe(true);
  });

  it('never forces an empty / null candidate (nothing usable to accept)', () => {
    expect(shouldForceRecap({ candidate: null, lag: 300, lagCeiling: 96 })).toBe(false);
    expect(shouldForceRecap({ candidate: '   ', lag: 300, lagCeiling: 96 })).toBe(false);
  });

  it('lagCeiling <= 0 disables the breaker', () => {
    expect(shouldForceRecap({ candidate: 'short recap', lag: 9999, lagCeiling: 0 })).toBe(false);
  });
});

describe('recap wedge regression (persistent over-cap candidate)', () => {
  // Reproduces the latent wedge: the summarizer keeps overshooting the char
  // cap, so validateSummary drops the candidate to null every roll. Before the
  // fix, acceptRecap(prior, null) === false AND shouldForceRecap({ candidate:
  // null }) === false, so recapCutoff never advanced and the safety floor
  // silently dropped the uncovered span. The fix surfaces the RAW over-cap
  // text and, on the forced path only (lag >= ceiling), clamps it so coverage
  // eventually advances. This simulation mirrors the extension's roll loop
  // over the pure helpers it composes.
  const CAP = 1500; // summarizeMaxChars
  const CEILING = 96; // recapLagCeiling
  const MAX_ADVANCE = 24; // recapMaxAdvance

  // Model that persistently overshoots the cap: every recap is > CAP chars.
  const overCapRecap = (): string => 'X'.repeat(CAP + 500);

  it('never wedges: coverage advances once lag passes the ceiling', () => {
    // Every index is a user message, so the user-boundary snap is the identity.
    const msgs: Msg[] = Array.from({ length: 301 }, (_, i) => ({ role: 'user', content: `U${i}` }));
    let recapCutoff = 0;
    let recapText = '';
    let natural = 0;
    const advances: number[] = [];

    // 300 turns of aged messages arrive; a roll fires each iteration.
    for (let turn = 0; turn < 300; turn++) {
      natural += 1; // one more aged message each turn
      const spanTo = boundRollSpanTo(msgs, recapCutoff, natural, MAX_ADVANCE);
      const lag = natural - recapCutoff;

      // doRecap: the raw model text is over-cap, so validateSummary => null.
      const raw = overCapRecap();
      const next = raw.length > CAP ? null : raw; // validateSummary behavior
      const applied = acceptRecap(recapText, next);

      // Forced-path salvage (Option A): clamp the raw over-cap text.
      const salvaged = applied ? next : clampSummary(raw, CAP);
      const forced = !applied && shouldForceRecap({ candidate: salvaged, lag, lagCeiling: CEILING });
      const commit = applied ? next : forced ? salvaged : null;
      if (commit) {
        const before = recapCutoff;
        recapText = commit;
        recapCutoff = spanTo;
        advances.push(recapCutoff - before);
      }
    }

    // Coverage must have advanced (the pre-fix bug pinned recapCutoff at 0).
    expect(recapCutoff).toBeGreaterThan(0);
    expect(advances.length).toBeGreaterThan(0);
    // Once forced, the committed recap is a clamped (<= cap) non-empty string,
    // never the discarded null.
    expect(recapText.length).toBeGreaterThan(0);
    expect(recapText.length).toBeLessThanOrEqual(CAP);
    // And the uncovered lag stays bounded by the ceiling (+ one roll stride) -
    // it can no longer grow without limit.
    const finalLag = 300 - recapCutoff;
    expect(finalLag).toBeLessThanOrEqual(CEILING + MAX_ADVANCE);
  });

  it('normal path still drops a one-off over-cap runaway (no premature clamp)', () => {
    // Lag below the ceiling: an over-cap candidate is NOT committed - the
    // "drop a runaway, do not truncate" rule holds until the breaker trips.
    const raw = overCapRecap();
    const next = raw.length > CAP ? null : raw;
    const applied = acceptRecap('a solid prior recap', next);
    const salvaged = applied ? next : clampSummary(raw, CAP);
    const forced = !applied && shouldForceRecap({ candidate: salvaged, lag: 10, lagCeiling: CEILING });
    const commit = applied ? next : forced ? salvaged : null;
    expect(applied).toBe(false);
    expect(forced).toBe(false);
    expect(commit).toBeNull();
  });
});

describe('estimateChars', () => {
  it('sums text, tool payloads, and charges flat for images', () => {
    const msgs: Msg[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }, { type: 'image' }],
      },
    ];
    expect(estimateChars(msgs)).toBe(5 + 5 + 4000);
  });
});

describe('updateCharsPerToken', () => {
  it('moves the ratio toward observed usage', () => {
    const next = updateCharsPerToken(4, 8000, 2000, 0.5); // observed = 4
    expect(next).toBeCloseTo(4, 5);
    const up = updateCharsPerToken(4, 10000, 2000, 0.5); // observed = 5
    expect(up).toBeGreaterThan(4);
    expect(up).toBeLessThan(5);
  });

  it('ignores nonsense / absurd ratios', () => {
    expect(updateCharsPerToken(4, 0, 2000)).toBe(4);
    expect(updateCharsPerToken(4, 2000, 0)).toBe(4);
    expect(updateCharsPerToken(4, 100000, 100)).toBe(4); // ratio 1000 -> ignored
  });
});

describe('deriveMaxSpanChars', () => {
  it('falls back to 8000 when the window is unknown', () => {
    expect(deriveMaxSpanChars({})).toBe(8000);
    expect(deriveMaxSpanChars({ contextWindowTokens: 0 })).toBe(8000);
    expect(deriveMaxSpanChars({ contextWindowTokens: NaN, fallbackChars: 8000 })).toBe(8000);
  });

  it('scales up with a large recap-model window (fixes the silent-loss bug)', () => {
    const span = deriveMaxSpanChars({
      contextWindowTokens: 32768,
      outputReserveTokens: 512,
      overheadTokens: 512,
      charsPerToken: 4,
    });
    // way above the old hardcoded 8000, so a chunk=36 span fits losslessly
    expect(span).toBeGreaterThan(100000);
  });

  it('subtracts the prior recap and respects the floor', () => {
    const big = deriveMaxSpanChars({ contextWindowTokens: 8000, priorRecapChars: 0, charsPerToken: 4 });
    const small = deriveMaxSpanChars({ contextWindowTokens: 8000, priorRecapChars: 20000, charsPerToken: 4 });
    expect(small).toBeLessThan(big);
    expect(small).toBeGreaterThanOrEqual(2000); // MIN_SPAN_CHARS floor
  });
});

describe('deriveKeepTurns', () => {
  it('keeps more turns when prose is terse, fewer when verbose', () => {
    const terse = deriveKeepTurns(transcript(20, 20), 500, DEFAULT_CHARS_PER_TOKEN, 2, 64);
    const verbose = deriveKeepTurns(transcript(20, 2000), 500, DEFAULT_CHARS_PER_TOKEN, 2, 64);
    expect(terse).toBeGreaterThan(verbose);
  });

  it('respects the min and max clamps', () => {
    expect(deriveKeepTurns(transcript(20, 5000), 10, DEFAULT_CHARS_PER_TOKEN, 3, 64)).toBe(3);
    expect(deriveKeepTurns(transcript(4, 1), 1_000_000, DEFAULT_CHARS_PER_TOKEN, 2, 64)).toBe(4);
  });
});
