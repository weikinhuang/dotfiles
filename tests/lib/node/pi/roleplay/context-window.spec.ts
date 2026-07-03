import { describe, expect, it } from 'vitest';

import {
  acceptRecap,
  applyContextWindowAt,
  applyLayeredWindow,
  computeCutoff,
  condenseMessage,
  DEFAULT_CHARS_PER_TOKEN,
  deriveKeepTurns,
  deriveMaxSpanChars,
  estimateChars,
  injectRecap,
  injectTimeline,
  planRecap,
  RECAP_PREFIX,
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
    const text = 'The scene opens in a tavern. ' + 'filler '.repeat(60) + 'REMEMBER: Wei is allergic to shellfish.';
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
    expect(String((out.messages[0] as Msg).content).length).toBeLessThan(String(msgs[0].content).length);
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
    expect(String((out[0] as Msg).content)).toContain(RECAP_PREFIX);
    expect(String((out[0] as Msg).content)).toContain('hello');
  });

  it('prefixes the first text part of array content', () => {
    const msgs: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const out = injectRecap(msgs, 'recap');
    const parts = (out[0] as Msg).content as Record<string, unknown>[];
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
    expect(String((out[0] as Msg).content)).toContain(TIMELINE_PREFIX);
    expect(String((out[0] as Msg).content)).toContain('Mira visits');
    expect(String((out[0] as Msg).content)).toContain('hello');
  });

  it('stacks separately from the recap prefix', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'x' }];
    const out = injectTimeline(injectRecap(msgs, 'recap here'), '- a beat');
    const content = String((out[0] as Msg).content);
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
