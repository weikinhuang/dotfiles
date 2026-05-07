/**
 * Tests for lib/node/pi/stall-detect.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  type AssistantSnapshot,
  buildRetryMessage,
  classifyAssistant,
  countTrailingStalls,
  hasStallMarker,
  lastAssistantSnapshot,
  snapshotFromAssistantMessage,
  STALL_MARKER,
  stripThinkingFromStalledTurns,
} from '../../../../lib/node/pi/stall-detect.ts';

// ──────────────────────────────────────────────────────────────────────
// classifyAssistant
// ──────────────────────────────────────────────────────────────────────

const snap = (overrides: Partial<AssistantSnapshot> = {}): AssistantSnapshot => ({
  text: '',
  toolCallCount: 0,
  ...overrides,
});

test('classifyAssistant: empty text and no tool calls → empty stall', () => {
  expect(classifyAssistant(snap())).toEqual({ kind: 'empty' });
});

test('classifyAssistant: whitespace-only text with no tool calls → empty stall', () => {
  expect(classifyAssistant(snap({ text: '   \n\t  \n' }))).toEqual({ kind: 'empty' });
});

test('classifyAssistant: any text → not a stall', () => {
  expect(classifyAssistant(snap({ text: 'Here is the answer.' }))).toBe(null);
});

test('classifyAssistant: tool calls only (no text) → not a stall', () => {
  expect(classifyAssistant(snap({ toolCallCount: 1 }))).toBe(null);
});

test('classifyAssistant: text + tool calls → not a stall', () => {
  expect(classifyAssistant(snap({ text: 'calling', toolCallCount: 2 }))).toBe(null);
});

test('classifyAssistant: single-word reply → not a stall (we trust any substantive output)', () => {
  expect(classifyAssistant(snap({ text: 'Done.' }))).toBe(null);
});

test('classifyAssistant: question handoff → not a stall (text is present)', () => {
  expect(classifyAssistant(snap({ text: 'Should I use approach A or approach B?' }))).toBe(null);
});

test('classifyAssistant: explicit error beats empty text', () => {
  expect(classifyAssistant(snap({ error: 'connection reset by peer' }))).toEqual({
    kind: 'error',
    error: 'connection reset by peer',
  });
});

test('classifyAssistant: error field wins over populated text too (turn is broken)', () => {
  expect(classifyAssistant(snap({ text: 'partial response…', error: 'stream aborted' }))).toEqual({
    kind: 'error',
    error: 'stream aborted',
  });
});

test('classifyAssistant: whitespace-only error is ignored (treat as no error)', () => {
  expect(classifyAssistant(snap({ error: '   ' }))).toEqual({ kind: 'empty' });
});

test('classifyAssistant: error trims whitespace', () => {
  expect(classifyAssistant(snap({ error: '  timeout  ' }))).toEqual({ kind: 'error', error: 'timeout' });
});

// User-initiated aborts (Ctrl+C) must NEVER be classified as a stall —
// auto-retrying past them would fight the user. See
// `StopReason` in `@mariozechner/pi-ai/types`.
test('classifyAssistant: stopReason="aborted" with empty turn → not a stall', () => {
  expect(classifyAssistant(snap({ stopReason: 'aborted' }))).toBe(null);
});

test('classifyAssistant: stopReason="aborted" outranks the error field (user cancel is not a transport failure)', () => {
  expect(
    classifyAssistant(
      snap({
        stopReason: 'aborted',
        error: 'Request aborted by user',
      }),
    ),
  ).toBe(null);
});

test('classifyAssistant: stopReason="aborted" with partial text → not a stall either', () => {
  expect(
    classifyAssistant(
      snap({
        stopReason: 'aborted',
        text: 'I was about to say tests pa',
      }),
    ),
  ).toBe(null);
});

test('classifyAssistant: other stopReasons do not suppress normal classification', () => {
  expect(classifyAssistant(snap({ stopReason: 'stop' }))).toEqual({ kind: 'empty' });
  expect(classifyAssistant(snap({ stopReason: 'error', error: 'boom' }))).toEqual({ kind: 'error', error: 'boom' });
});

// ──────────────────────────────────────────────────────────────────────
// snapshotFromAssistantMessage
// ──────────────────────────────────────────────────────────────────────

test('snapshotFromAssistantMessage: returns null for non-objects', () => {
  expect(snapshotFromAssistantMessage(null)).toBe(null);
  expect(snapshotFromAssistantMessage(undefined)).toBe(null);
  expect(snapshotFromAssistantMessage('hi')).toBe(null);
  expect(snapshotFromAssistantMessage(42)).toBe(null);
});

test('snapshotFromAssistantMessage: returns null for non-assistant roles', () => {
  expect(snapshotFromAssistantMessage({ role: 'user', content: 'x' })).toBe(null);
  expect(snapshotFromAssistantMessage({ role: 'toolResult', content: 'x' })).toBe(null);
});

test('snapshotFromAssistantMessage: string content', () => {
  const s = snapshotFromAssistantMessage({ role: 'assistant', content: 'hello world' });

  expect(s).toEqual({ text: 'hello world', toolCallCount: 0, error: undefined });
});

test('snapshotFromAssistantMessage: array content with text parts', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'part 1' },
      { type: 'text', text: 'part 2' },
    ],
  });

  expect(s).toEqual({ text: 'part 1\npart 2', toolCallCount: 0, error: undefined });
});

test('snapshotFromAssistantMessage: counts toolCall parts', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling…' },
      { type: 'toolCall', id: 'a', name: 'read' },
      { type: 'toolCall', id: 'b', name: 'bash' },
    ],
  });

  expect(s).toEqual({ text: 'calling…', toolCallCount: 2, error: undefined });
});

test('snapshotFromAssistantMessage: ignores unknown content part types', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'thinking', text: 'reasoning…' },
      { type: 'image', data: '…' },
    ],
  });

  expect(s).toEqual({ text: 'hi', toolCallCount: 0, error: undefined });
});

test('snapshotFromAssistantMessage: picks up explicit error field', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: '',
    error: 'upstream timeout',
  });

  expect(s).toEqual({ text: '', toolCallCount: 0, error: 'upstream timeout' });
});

test('snapshotFromAssistantMessage: empty assistant message produces empty snapshot', () => {
  const s = snapshotFromAssistantMessage({ role: 'assistant' });

  expect(s).toEqual({ text: '', toolCallCount: 0, error: undefined });
});

test('snapshotFromAssistantMessage: picks up stopReason when present', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: '',
    stopReason: 'aborted',
    errorMessage: 'Request aborted by user',
  });

  expect(s).toEqual({
    text: '',
    toolCallCount: 0,
    error: 'Request aborted by user',
    stopReason: 'aborted',
  });
});

test('snapshotFromAssistantMessage: prefers `error` over `errorMessage` when both present', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: '',
    error: 'legacy shape',
    errorMessage: 'new shape',
  });

  expect(s?.error).toBe('legacy shape');
});

test('snapshotFromAssistantMessage: ignores non-string stopReason', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: 'hi',
    stopReason: 42,
  });

  expect(s?.stopReason).toBeUndefined();
});

// ──────────────────────────────────────────────────────────────────────
// lastAssistantSnapshot
// ──────────────────────────────────────────────────────────────────────

test('lastAssistantSnapshot: empty array → null', () => {
  expect(lastAssistantSnapshot([])).toBe(null);
});

test('lastAssistantSnapshot: no assistant messages → null', () => {
  expect(lastAssistantSnapshot([{ message: { role: 'user', content: 'x' } }])).toBe(null);
});

test('lastAssistantSnapshot: picks the last assistant message in source order', () => {
  const messages = [
    { message: { role: 'user', content: 'p' } },
    { message: { role: 'assistant', content: 'first response' } },
    { message: { role: 'toolResult', content: 'r' } },
    { message: { role: 'assistant', content: 'second response' } },
  ];
  const s = lastAssistantSnapshot(messages);

  expect(s?.text).toBe('second response');
});

test('lastAssistantSnapshot: handles raw message objects too (no wrapper)', () => {
  const messages = [
    { role: 'user', content: 'p' },
    { role: 'assistant', content: 'a' },
  ];
  const s = lastAssistantSnapshot(messages);

  expect(s?.text).toBe('a');
});

test('lastAssistantSnapshot: skips wrapper entries that are not messages', () => {
  const messages = [
    { message: { role: 'assistant', content: 'target' } },
    { message: { role: 'toolResult', content: 'last' } },
    { otherShape: true },
  ];
  const s = lastAssistantSnapshot(messages);

  expect(s?.text).toBe('target');
});

// ──────────────────────────────────────────────────────────────────────
// buildRetryMessage / hasStallMarker
// ──────────────────────────────────────────────────────────────────────

test('buildRetryMessage: empty reason carries marker, budget, and directive', () => {
  const m = buildRetryMessage({ kind: 'empty' }, 1, 2);

  expect(m).toMatch(/⟳ \[pi-stall-recovery\]/);
  expect(m).toMatch(/\(1\/2\)/);
  expect(m).toMatch(/produced no output/i);
  expect(m).toMatch(/continue where you left off/i);
});

test('buildRetryMessage: error reason surfaces the error verbatim', () => {
  const m = buildRetryMessage({ kind: 'error', error: 'HTTP 429 rate limited' }, 2, 3);

  expect(m).toMatch(/⟳ \[pi-stall-recovery\]/);
  expect(m).toMatch(/\(2\/3\)/);
  expect(m).toMatch(/HTTP 429 rate limited/);
  expect(m).toMatch(/Retry the same approach/i);
});

test('buildRetryMessage: error truncates very long error strings', () => {
  const long = 'x'.repeat(500);
  const m = buildRetryMessage({ kind: 'error', error: long }, 1, 2);

  expect(m.length, 'message should cap the embedded error').toBeLessThan(500);
  expect(m, 'truncation marker present').toMatch(/…/);
});

test('hasStallMarker: detects our sentinel', () => {
  expect(hasStallMarker(`prefix ${STALL_MARKER} (1/2) continue…`)).toBe(true);
});

test('hasStallMarker: ignores unrelated strings', () => {
  expect(hasStallMarker('just a normal follow-up')).toBe(false);
  expect(hasStallMarker('')).toBe(false);
});

test('buildRetryMessage: final attempt (empty) escalates to imperative tone', () => {
  const gentle = buildRetryMessage({ kind: 'empty' }, 1, 2);
  const final = buildRetryMessage({ kind: 'empty' }, 2, 2);

  expect(gentle).toMatch(/\(1\/2\)/);
  expect(final).toMatch(/\(2\/2\)/);
  // Final attempt carries the imperative vocabulary.
  expect(final).toMatch(/ZERO output/);
  expect(final).toMatch(/MUST emit content/i);
  expect(final).toMatch(/Do NOT return another empty response/i);
  expect(final).toMatch(/Do NOT spend the whole turn in extended thinking/i);
  // Gentle message does not carry imperative vocabulary.
  expect(gentle).not.toMatch(/ZERO output/);
  expect(gentle).not.toMatch(/MUST emit/i);
});

test('buildRetryMessage: final attempt (error) escalates with transient/structural hint', () => {
  const gentle = buildRetryMessage({ kind: 'error', error: 'HTTP 429' }, 1, 2);
  const final = buildRetryMessage({ kind: 'error', error: 'HTTP 429' }, 2, 2);

  expect(gentle).toMatch(/Retry the same approach/i);
  expect(final).toMatch(/transient \(rate limit, DNS, timeout\)/i);
  expect(final).toMatch(/structural \(4xx, schema mismatch\)/i);
  expect(final).toMatch(/HTTP 429/);
});

test('buildRetryMessage: escalation triggers even when maxAttempts=1 (attempt>=max)', () => {
  const m = buildRetryMessage({ kind: 'empty' }, 1, 1);

  expect(m).toMatch(/\(1\/1\)/);
  expect(m).toMatch(/MUST emit content/i);
});

// ─────────────────────────────────────────────────────────────────────
// countTrailingStalls
// ─────────────────────────────────────────────────────────────────────

// Small factories for readable message histories. We use bare
// (un-wrapped) message objects; `lastAssistantSnapshot` already accepts
// both wrapped and bare shapes, and `countTrailingStalls` uses the same
// unwrap path.
const userMsg = (text: string): object => ({ role: 'user', content: text });
const stallNudge = (attempt: number, max: number): object =>
  userMsg(`${STALL_MARKER} (${attempt}/${max}) Your previous turn produced no output.`);
const emptyAsst = (): object => ({ role: 'assistant', content: [], stopReason: 'stop' });
const erroredAsst = (err: string): object => ({
  role: 'assistant',
  content: [],
  stopReason: 'error',
  errorMessage: err,
});
const toolUseAsst = (): object => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'a', name: 'read' }],
  stopReason: 'toolUse',
});
const toolResult = (): object => ({ role: 'toolResult', content: [{ type: 'text', text: 'r' }] });

test('countTrailingStalls: empty history → 0', () => {
  expect(countTrailingStalls([])).toBe(0);
});

test('countTrailingStalls: only a user prompt → 0', () => {
  expect(countTrailingStalls([userMsg('do a thing')])).toBe(0);
});

test('countTrailingStalls: last assistant healthy → 0', () => {
  expect(countTrailingStalls([userMsg('do a thing'), toolUseAsst()])).toBe(0);
});

test('countTrailingStalls: single trailing empty stall → 1', () => {
  expect(countTrailingStalls([userMsg('do a thing'), emptyAsst()])).toBe(1);
});

test('countTrailingStalls: single trailing errored stall → 1', () => {
  expect(countTrailingStalls([userMsg('do a thing'), erroredAsst('boom')])).toBe(1);
});

test('countTrailingStalls: two stalls with a nudge between → 2 (nudge is transparent)', () => {
  const msgs = [userMsg('do a thing'), emptyAsst(), stallNudge(1, 2), emptyAsst()];

  expect(countTrailingStalls(msgs)).toBe(2);
});

test('countTrailingStalls: toolResults interleaved with stalls are transparent', () => {
  const msgs = [userMsg('do a thing'), emptyAsst(), toolResult(), emptyAsst()];

  expect(countTrailingStalls(msgs)).toBe(2);
});

test('countTrailingStalls: intermediate healthy assistant resets the streak (event-41→48 regression)', () => {
  // Reproduces the 2026-05-06 session: after two retries+successful
  // unstick, three more healthy tool-use turns, then one fresh stall.
  // The old in-memory counter reported trailing=2 ("budget exhausted")
  // here; the stateless counter sees the healthy turns and returns 1.
  const msgs = [
    userMsg('do a thing'),
    emptyAsst(),
    stallNudge(1, 2),
    emptyAsst(),
    stallNudge(2, 2),
    toolUseAsst(),
    toolResult(),
    toolUseAsst(),
    toolResult(),
    toolUseAsst(),
    toolResult(),
    emptyAsst(), // fresh stall
  ];

  expect(countTrailingStalls(msgs)).toBe(1);
});

test('countTrailingStalls: a real (non-marker) user input breaks the streak', () => {
  // If the user manually typed "continue" and the next turn stalled
  // again, only the single trailing stall should count — the manual
  // continue resets the budget.
  const msgs = [userMsg('do a thing'), emptyAsst(), stallNudge(1, 2), emptyAsst(), userMsg('continue'), emptyAsst()];

  expect(countTrailingStalls(msgs)).toBe(1);
});

test('countTrailingStalls: stall marker embedded in a larger user message still counts as a nudge', () => {
  const msgs = [
    userMsg('do a thing'),
    emptyAsst(),
    userMsg(`prefix ${STALL_MARKER} (1/2) retry text suffix`),
    emptyAsst(),
  ];

  expect(countTrailingStalls(msgs)).toBe(2);
});

test('countTrailingStalls: accepts wrapped `{ message }` shape', () => {
  const msgs = [{ message: userMsg('do a thing') }, { message: emptyAsst() }];

  expect(countTrailingStalls(msgs)).toBe(1);
});

test('countTrailingStalls: aborted turn is not a stall (does not contribute to count)', () => {
  const aborted = { role: 'assistant', content: [], stopReason: 'aborted' };
  // The aborted turn is healthy-from-our-perspective, so the walk stops
  // there — trailing count is 0.

  expect(countTrailingStalls([userMsg('do a thing'), aborted])).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────
// stripThinkingFromStalledTurns
// ─────────────────────────────────────────────────────────────────────

const thinkingAsst = (thinking: string, extras: Record<string, unknown>[] = []): Record<string, unknown> => ({
  role: 'assistant',
  content: [{ type: 'thinking', thinking, thinkingSignature: 'sig' }, ...extras],
  stopReason: 'stop',
});

test('stripThinkingFromStalledTurns: no-op when last message is not a stall nudge', () => {
  const asst = thinkingAsst('deep thoughts');
  const msgs: Record<string, unknown>[] = [userMsg('hi') as Record<string, unknown>, asst];
  const before = structuredClone(msgs);
  stripThinkingFromStalledTurns(msgs);

  expect(msgs).toEqual(before);
});

test('stripThinkingFromStalledTurns: strips thinking blocks from trailing stall before a nudge', () => {
  const asst = thinkingAsst('ruminating about X');
  const msgs: Record<string, unknown>[] = [
    userMsg('do a thing') as Record<string, unknown>,
    asst,
    stallNudge(1, 2) as Record<string, unknown>,
  ];
  stripThinkingFromStalledTurns(msgs);

  expect(asst.content).toEqual([{ type: 'text', text: '' }]);
});

test('stripThinkingFromStalledTurns: healthy turns in the window are NOT stripped even if they contain thinking', () => {
  // A turn with non-empty text AND thinking is considered healthy by
  // `classifyAssistant` (text trims non-empty). Healthy turns are a
  // hard boundary for the walk — we never touch their thinking,
  // because the legitimate reasoning there is part of the successful
  // turn's trail and stripping it could break provider continuity.
  const healthy: Record<string, unknown> = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'reasoning that led to output' },
      { type: 'text', text: 'partial but real' },
      { type: 'toolCall', id: 'a', name: 'read' },
    ],
    stopReason: 'toolUse',
  };
  const msgs: Record<string, unknown>[] = [
    userMsg('do a thing') as Record<string, unknown>,
    healthy,
    stallNudge(1, 2) as Record<string, unknown>,
  ];
  stripThinkingFromStalledTurns(msgs);

  // Healthy turn preserved verbatim; walk stops at this boundary.
  expect(healthy.content).toEqual([
    { type: 'thinking', thinking: 'reasoning that led to output' },
    { type: 'text', text: 'partial but real' },
    { type: 'toolCall', id: 'a', name: 'read' },
  ]);
});

test('stripThinkingFromStalledTurns: strips across multiple trailing stalls separated by nudges', () => {
  const stall1 = thinkingAsst('thought 1');
  const stall2 = thinkingAsst('thought 2');
  const msgs: Record<string, unknown>[] = [
    userMsg('do a thing') as Record<string, unknown>,
    stall1,
    stallNudge(1, 2) as Record<string, unknown>,
    stall2,
    stallNudge(2, 2) as Record<string, unknown>,
  ];
  stripThinkingFromStalledTurns(msgs);

  expect(stall1.content).toEqual([{ type: 'text', text: '' }]);
  expect(stall2.content).toEqual([{ type: 'text', text: '' }]);
});

test('stripThinkingFromStalledTurns: stops at the first healthy assistant (leaves it untouched)', () => {
  const healthyThinking = thinkingAsst('legitimate reasoning', [{ type: 'text', text: 'answer' }]);
  const stall = thinkingAsst('stuck');
  const msgs: Record<string, unknown>[] = [
    userMsg('do a thing') as Record<string, unknown>,
    healthyThinking,
    stall,
    stallNudge(1, 2) as Record<string, unknown>,
  ];
  stripThinkingFromStalledTurns(msgs);

  // Healthy turn's thinking is preserved; only the stall's is stripped.
  expect(healthyThinking.content).toEqual([
    { type: 'thinking', thinking: 'legitimate reasoning', thinkingSignature: 'sig' },
    { type: 'text', text: 'answer' },
  ]);
  expect(stall.content).toEqual([{ type: 'text', text: '' }]);
});

test('stripThinkingFromStalledTurns: stops at a real user prompt (does not cross prompt boundaries)', () => {
  const olderStall = thinkingAsst('old rumination');
  const newStall = thinkingAsst('new rumination');
  const msgs: Record<string, unknown>[] = [
    userMsg('first prompt') as Record<string, unknown>,
    olderStall,
    userMsg('continue') as Record<string, unknown>, // real user input — resets boundary
    newStall,
    stallNudge(1, 2) as Record<string, unknown>,
  ];
  stripThinkingFromStalledTurns(msgs);

  // Older stall (from a previous prompt) is not touched.
  expect(olderStall.content).toEqual([{ type: 'thinking', thinking: 'old rumination', thinkingSignature: 'sig' }]);
  expect(newStall.content).toEqual([{ type: 'text', text: '' }]);
});

test('stripThinkingFromStalledTurns: works on wrapped `{ message }` entries', () => {
  const asst = thinkingAsst('ruminating');
  const msgs: Record<string, unknown>[] = [
    { message: userMsg('do a thing') },
    { message: asst },
    { message: stallNudge(1, 2) },
  ];
  stripThinkingFromStalledTurns(msgs);

  expect(asst.content).toEqual([{ type: 'text', text: '' }]);
});

test('stripThinkingFromStalledTurns: no-op on empty array', () => {
  const msgs: unknown[] = [];

  expect(stripThinkingFromStalledTurns(msgs)).toBe(msgs);
});

test('stripThinkingFromStalledTurns: returns the same array reference (mutation-based contract)', () => {
  const asst = thinkingAsst('stuck');
  const msgs: Record<string, unknown>[] = [
    userMsg('p') as Record<string, unknown>,
    asst,
    stallNudge(1, 2) as Record<string, unknown>,
  ];

  expect(stripThinkingFromStalledTurns(msgs)).toBe(msgs);
});
