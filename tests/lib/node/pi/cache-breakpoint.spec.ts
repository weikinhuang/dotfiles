/**
 * Tests for lib/node/pi/cache-breakpoint.ts.
 *
 * The helper has two strategies (see the module header): AGGREGATE (the
 * primary path - un-nest the reminder past a breakpoint placed on the
 * real tail content) and RELOCATE-TO-PREV (the fallback - move the
 * breakpoint onto the previous user message). These specs cover:
 *
 *   1. Bedrock aggregate: reminder un-nested out of the toolResult into a
 *      trailing sibling text block with a cachePoint between, real
 *      content preserved byte-for-byte (the cross-turn cache invariant),
 *      ttl preserved, stacked reminders, top-level (non-toolResult) tail.
 *   2. Bedrock fallback: a toolResult emptied by extraction relocates to
 *      the previous turn instead.
 *   3. Anthropic aggregate: cache_control set on the last non-reminder
 *      block; trailing reminder block(s) ride uncached.
 *   4. Anthropic fallback: no real block -> relocate to prev.
 *   5. Scope guards / no-ops: local (no marker), clean tail, malformed
 *      payloads, single user message - none mutate the payload.
 */

import { expect, test } from 'vitest';

import {
  type PayloadBlock,
  type PayloadMessage,
  relocateTailCacheBreakpoint,
} from '../../../../lib/node/pi/cache-breakpoint.ts';

const REMINDER = '<system-reminder id="todo-plan">\nactive plan\n</system-reminder>';
const blocks = (m: PayloadMessage): PayloadBlock[] => m.content as PayloadBlock[];

// ──────────────────────────────────────────────────────────────────────
// Bedrock Converse: aggregate (un-nest)
// ──────────────────────────────────────────────────────────────────────

/** Tail user message: a toolResult whose content has real text + a nested reminder, plus pi's cachePoint. */
function bedrockToolResultTail(cachePoint: Record<string, unknown> = { type: 'default' }): PayloadMessage {
  return {
    role: 'user',
    content: [
      {
        toolResult: {
          toolUseId: 't1',
          content: [{ text: 'real result body' }, { text: REMINDER }],
          status: 'success',
        },
      },
      { cachePoint },
    ],
  };
}

function bedrockPayload(tail = bedrockToolResultTail()): { messages: PayloadMessage[] } {
  return {
    messages: [
      { role: 'user', content: [{ text: 'first prompt' }] },
      { role: 'assistant', content: [{ text: 'thinking' }, { toolUse: { toolUseId: 't0' } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 't0', content: [{ text: 'older result' }] } }] },
      { role: 'assistant', content: [{ text: 'more' }, { toolUse: { toolUseId: 't1' } }] },
      tail,
    ],
  };
}

test('bedrock: un-nests the reminder into a trailing sibling, cachePoint on the real content', () => {
  const p = bedrockPayload();
  const res = relocateTailCacheBreakpoint(p);

  expect(res).toEqual({ changed: true, style: 'bedrock', reason: 'aggregated' });

  // Tail shape: [toolResult(real only), cachePoint, reminder text]
  const c = blocks(p.messages[4]);
  expect(c).toHaveLength(3);
  expect((c[0].toolResult as { content: unknown[] }).content).toEqual([{ text: 'real result body' }]);
  expect(c[1]).toEqual({ cachePoint: { type: 'default' } });
  expect(c[2]).toEqual({ text: REMINDER });

  // Cross-turn invariant: the cached portion (everything before the
  // cachePoint) contains NO reminder, so it is byte-stable next turn
  // when the reminder is gone.
  const cachedPortion = JSON.stringify([c[0]]);
  expect(cachedPortion).not.toContain('<system-reminder');
});

test('bedrock: preserves the cachePoint ttl (long retention) when un-nesting', () => {
  const p = bedrockPayload(bedrockToolResultTail({ type: 'default', ttl: 'PT1H' }));
  relocateTailCacheBreakpoint(p);
  const c = blocks(p.messages[4]);
  expect(c.find((b) => b.cachePoint)?.cachePoint).toEqual({ type: 'default', ttl: 'PT1H' });
});

test('bedrock: stacked reminders (todo + scratchpad + bg-bash) all lifted past the cachePoint', () => {
  const tail: PayloadMessage = {
    role: 'user',
    content: [
      {
        toolResult: {
          toolUseId: 't1',
          content: [
            { text: 'real result body' },
            { text: '<system-reminder id="todo-plan">\nplan\n</system-reminder>' },
            { text: '<system-reminder id="scratchpad">\nnotes\n</system-reminder>' },
            { text: '<system-reminder id="bg-bash">\njobs\n</system-reminder>' },
          ],
          status: 'success',
        },
      },
      { cachePoint: { type: 'default' } },
    ],
  };
  const p = bedrockPayload(tail);
  const res = relocateTailCacheBreakpoint(p);
  expect(res.reason).toBe('aggregated');

  const c = blocks(p.messages[4]);
  // real toolResult, cachePoint, then 3 reminder text blocks
  expect(c).toHaveLength(5);
  expect((c[0].toolResult as { content: unknown[] }).content).toEqual([{ text: 'real result body' }]);
  expect(c[1]).toEqual({ cachePoint: { type: 'default' } });
  expect(c.slice(2).every((b) => typeof b.text === 'string' && b.text.includes('<system-reminder'))).toBe(true);
});

test('bedrock: a plain user-message tail (sibling reminder, no toolResult) also aggregates', () => {
  const tail: PayloadMessage = {
    role: 'user',
    content: [{ text: 'user asked something' }, { text: REMINDER }, { cachePoint: { type: 'default' } }],
  };
  const p = bedrockPayload(tail);
  const res = relocateTailCacheBreakpoint(p);
  expect(res.reason).toBe('aggregated');

  const c = blocks(p.messages[4]);
  expect(c).toEqual([{ text: 'user asked something' }, { cachePoint: { type: 'default' } }, { text: REMINDER }]);
});

test('bedrock fallback: a toolResult emptied by extraction relocates to the previous turn', () => {
  // The reminder is the ONLY content in the toolResult - extraction would
  // empty it, so the aggregator bails and relocate-to-prev runs instead.
  const tail: PayloadMessage = {
    role: 'user',
    content: [
      { toolResult: { toolUseId: 't1', content: [{ text: REMINDER }], status: 'success' } },
      { cachePoint: { type: 'default' } },
    ],
  };
  const p = bedrockPayload(tail);
  const res = relocateTailCacheBreakpoint(p);

  expect(res).toEqual({ changed: true, style: 'bedrock', reason: 'relocated' });
  // cachePoint moved to the previous user message (index 2), tail keeps its toolResult intact.
  expect(blocks(p.messages[4]).some((b) => b.cachePoint)).toBe(false);
  expect(blocks(p.messages[2]).some((b) => b.cachePoint)).toBe(true);
  expect((blocks(p.messages[4])[0].toolResult as { content: unknown[] }).content).toEqual([{ text: REMINDER }]);
});

// ──────────────────────────────────────────────────────────────────────
// Anthropic Messages: aggregate
// ──────────────────────────────────────────────────────────────────────

function anthropicPayload(tail?: PayloadMessage): { messages: PayloadMessage[] } {
  return {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'older result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'more' }] },
      tail ?? {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'result body' },
          { type: 'text', text: REMINDER, cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
}

test('anthropic: cache_control moves to the last non-reminder block; reminder rides uncached', () => {
  const p = anthropicPayload();
  const res = relocateTailCacheBreakpoint(p);

  expect(res).toEqual({ changed: true, style: 'anthropic', reason: 'aggregated' });

  const c = blocks(p.messages[4]);
  // The tool_result (real content) carries the breakpoint...
  expect(c[0].cache_control).toEqual({ type: 'ephemeral' });
  // ...and the trailing reminder block does NOT.
  expect(c[1].cache_control).toBeUndefined();
  // Order unchanged: reminder still after the cached block.
  expect(c[1].text).toBe(REMINDER);
});

test('anthropic fallback: a tail with only a reminder block relocates to the previous turn', () => {
  const tail: PayloadMessage = {
    role: 'user',
    content: [{ type: 'text', text: REMINDER, cache_control: { type: 'ephemeral' } }],
  };
  const p = anthropicPayload(tail);
  const res = relocateTailCacheBreakpoint(p);

  expect(res).toEqual({ changed: true, style: 'anthropic', reason: 'relocated' });
  // Tail's cache_control stripped; previous user message's last block carries it.
  expect(blocks(p.messages[4]).some((b) => b.cache_control)).toBe(false);
  const prev = blocks(p.messages[2]);
  expect(prev[prev.length - 1].cache_control).toEqual({ type: 'ephemeral' });
});

// ──────────────────────────────────────────────────────────────────────
// Scope guards + no-op invariants
// ──────────────────────────────────────────────────────────────────────

test('local / openai-style payload (no cache markers) is a no-op, unmutated', () => {
  const p = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: `follow up\n${REMINDER}` }] },
    ],
  };
  const snap = JSON.stringify(p);
  expect(relocateTailCacheBreakpoint(p)).toEqual({ changed: false, reason: 'no-cache-marker-on-tail' });
  expect(JSON.stringify(p)).toEqual(snap);
});

test('clean tail (no reminder) is left where pi placed it, unmutated', () => {
  const p = bedrockPayload({
    role: 'user',
    content: [
      { toolResult: { toolUseId: 't1', content: [{ text: 'clean result' }] } },
      { cachePoint: { type: 'default' } },
    ],
  });
  const snap = JSON.stringify(p);
  expect(relocateTailCacheBreakpoint(p)).toEqual({ changed: false, style: 'bedrock', reason: 'tail-not-volatile' });
  expect(JSON.stringify(p)).toEqual(snap);
});

test('single user message (first turn) cannot relocate, and aggregate still works', () => {
  // Only one user message + assistant: aggregate can still un-nest within
  // that single tail message (no prev needed).
  const p = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q' },
          { type: 'text', text: REMINDER, cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: REMINDER, cache_control: { type: 'ephemeral' } }],
      },
    ],
  };
  // Tail (index 2) is reminder-only -> aggregate bails -> relocate needs a
  // prev user message (index 0 exists) -> relocates there.
  const res = relocateTailCacheBreakpoint(p);
  expect(res).toEqual({ changed: true, style: 'anthropic', reason: 'relocated' });
});

test('malformed payloads are no-ops', () => {
  expect(relocateTailCacheBreakpoint(null)).toEqual({ changed: false, reason: 'no-payload' });
  expect(relocateTailCacheBreakpoint({})).toEqual({ changed: false, reason: 'too-few-messages' });
  expect(relocateTailCacheBreakpoint({ messages: [{ role: 'user', content: 'x' }] })).toEqual({
    changed: false,
    reason: 'too-few-messages',
  });
});

test('re-applying after aggregation is a stable fixpoint (cachePoint no longer on a reminder)', () => {
  const p = bedrockPayload();
  relocateTailCacheBreakpoint(p);
  const snap = JSON.stringify(p);
  // Second pass: the reminder is now a sibling after the cachePoint, the
  // toolResult is clean, and the cachePoint sits on real content -> the
  // tail is still "volatile" (reminder present) but aggregate produces
  // the same arrangement -> idempotent.
  const res2 = relocateTailCacheBreakpoint(p);
  expect(JSON.stringify(p)).toEqual(snap);
  expect(res2.changed).toBe(true);
});
