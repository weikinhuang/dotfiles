/**
 * Tests for config/pi/extensions/lib/stall-detect.ts.
 *
 * Run:  node --test config/pi/tests/extensions/stall-detect.test.ts
 *   or: node --test config/pi/tests/
 *
 * Pure module — no pi runtime needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AssistantSnapshot,
  buildRetryMessage,
  classifyAssistant,
  hasStallMarker,
  lastAssistantSnapshot,
  snapshotFromAssistantMessage,
  STALL_MARKER,
} from '../../extensions/lib/stall-detect.ts';

// ──────────────────────────────────────────────────────────────────────
// classifyAssistant
// ──────────────────────────────────────────────────────────────────────

const snap = (overrides: Partial<AssistantSnapshot> = {}): AssistantSnapshot => ({
  text: '',
  toolCallCount: 0,
  ...overrides,
});

test('classifyAssistant: empty text and no tool calls → empty stall', () => {
  assert.deepEqual(classifyAssistant(snap()), { kind: 'empty' });
});

test('classifyAssistant: whitespace-only text with no tool calls → empty stall', () => {
  assert.deepEqual(classifyAssistant(snap({ text: '   \n\t  \n' })), { kind: 'empty' });
});

test('classifyAssistant: any text → not a stall', () => {
  assert.equal(classifyAssistant(snap({ text: 'Here is the answer.' })), null);
});

test('classifyAssistant: tool calls only (no text) → not a stall', () => {
  assert.equal(classifyAssistant(snap({ toolCallCount: 1 })), null);
});

test('classifyAssistant: text + tool calls → not a stall', () => {
  assert.equal(classifyAssistant(snap({ text: 'calling', toolCallCount: 2 })), null);
});

test('classifyAssistant: single-word reply → not a stall (we trust any substantive output)', () => {
  assert.equal(classifyAssistant(snap({ text: 'Done.' })), null);
});

test('classifyAssistant: question handoff → not a stall (text is present)', () => {
  assert.equal(classifyAssistant(snap({ text: 'Should I use approach A or approach B?' })), null);
});

test('classifyAssistant: explicit error beats empty text', () => {
  assert.deepEqual(classifyAssistant(snap({ error: 'connection reset by peer' })), {
    kind: 'error',
    error: 'connection reset by peer',
  });
});

test('classifyAssistant: error field wins over populated text too (turn is broken)', () => {
  assert.deepEqual(classifyAssistant(snap({ text: 'partial response…', error: 'stream aborted' })), {
    kind: 'error',
    error: 'stream aborted',
  });
});

test('classifyAssistant: whitespace-only error is ignored (treat as no error)', () => {
  assert.deepEqual(classifyAssistant(snap({ error: '   ' })), { kind: 'empty' });
});

test('classifyAssistant: error trims whitespace', () => {
  assert.deepEqual(classifyAssistant(snap({ error: '  timeout  ' })), { kind: 'error', error: 'timeout' });
});

// ──────────────────────────────────────────────────────────────────────
// snapshotFromAssistantMessage
// ──────────────────────────────────────────────────────────────────────

test('snapshotFromAssistantMessage: returns null for non-objects', () => {
  assert.equal(snapshotFromAssistantMessage(null), null);
  assert.equal(snapshotFromAssistantMessage(undefined), null);
  assert.equal(snapshotFromAssistantMessage('hi'), null);
  assert.equal(snapshotFromAssistantMessage(42), null);
});

test('snapshotFromAssistantMessage: returns null for non-assistant roles', () => {
  assert.equal(snapshotFromAssistantMessage({ role: 'user', content: 'x' }), null);
  assert.equal(snapshotFromAssistantMessage({ role: 'toolResult', content: 'x' }), null);
});

test('snapshotFromAssistantMessage: string content', () => {
  const s = snapshotFromAssistantMessage({ role: 'assistant', content: 'hello world' });
  assert.deepEqual(s, { text: 'hello world', toolCallCount: 0, error: undefined });
});

test('snapshotFromAssistantMessage: array content with text parts', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'part 1' },
      { type: 'text', text: 'part 2' },
    ],
  });
  assert.deepEqual(s, { text: 'part 1\npart 2', toolCallCount: 0, error: undefined });
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
  assert.deepEqual(s, { text: 'calling…', toolCallCount: 2, error: undefined });
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
  assert.deepEqual(s, { text: 'hi', toolCallCount: 0, error: undefined });
});

test('snapshotFromAssistantMessage: picks up explicit error field', () => {
  const s = snapshotFromAssistantMessage({
    role: 'assistant',
    content: '',
    error: 'upstream timeout',
  });
  assert.deepEqual(s, { text: '', toolCallCount: 0, error: 'upstream timeout' });
});

test('snapshotFromAssistantMessage: empty assistant message produces empty snapshot', () => {
  const s = snapshotFromAssistantMessage({ role: 'assistant' });
  assert.deepEqual(s, { text: '', toolCallCount: 0, error: undefined });
});

// ──────────────────────────────────────────────────────────────────────
// lastAssistantSnapshot
// ──────────────────────────────────────────────────────────────────────

test('lastAssistantSnapshot: empty array → null', () => {
  assert.equal(lastAssistantSnapshot([]), null);
});

test('lastAssistantSnapshot: no assistant messages → null', () => {
  assert.equal(lastAssistantSnapshot([{ message: { role: 'user', content: 'x' } }]), null);
});

test('lastAssistantSnapshot: picks the last assistant message in source order', () => {
  const messages = [
    { message: { role: 'user', content: 'p' } },
    { message: { role: 'assistant', content: 'first response' } },
    { message: { role: 'toolResult', content: 'r' } },
    { message: { role: 'assistant', content: 'second response' } },
  ];
  const s = lastAssistantSnapshot(messages);
  assert.equal(s?.text, 'second response');
});

test('lastAssistantSnapshot: handles raw message objects too (no wrapper)', () => {
  const messages = [
    { role: 'user', content: 'p' },
    { role: 'assistant', content: 'a' },
  ];
  const s = lastAssistantSnapshot(messages);
  assert.equal(s?.text, 'a');
});

test('lastAssistantSnapshot: skips wrapper entries that are not messages', () => {
  const messages = [
    { message: { role: 'assistant', content: 'target' } },
    { message: { role: 'toolResult', content: 'last' } },
    { otherShape: true },
  ];
  const s = lastAssistantSnapshot(messages);
  assert.equal(s?.text, 'target');
});

// ──────────────────────────────────────────────────────────────────────
// buildRetryMessage / hasStallMarker
// ──────────────────────────────────────────────────────────────────────

test('buildRetryMessage: empty reason carries marker, budget, and directive', () => {
  const m = buildRetryMessage({ kind: 'empty' }, 1, 2);
  assert.match(m, /⟳ \[pi-stall-recovery\]/);
  assert.match(m, /\(1\/2\)/);
  assert.match(m, /produced no output/i);
  assert.match(m, /continue where you left off/i);
});

test('buildRetryMessage: error reason surfaces the error verbatim', () => {
  const m = buildRetryMessage({ kind: 'error', error: 'HTTP 429 rate limited' }, 2, 3);
  assert.match(m, /⟳ \[pi-stall-recovery\]/);
  assert.match(m, /\(2\/3\)/);
  assert.match(m, /HTTP 429 rate limited/);
  assert.match(m, /Retry the same approach/i);
});

test('buildRetryMessage: error truncates very long error strings', () => {
  const long = 'x'.repeat(500);
  const m = buildRetryMessage({ kind: 'error', error: long }, 1, 2);
  assert.ok(m.length < 500, 'message should cap the embedded error');
  assert.match(m, /…/, 'truncation marker present');
});

test('hasStallMarker: detects our sentinel', () => {
  assert.equal(hasStallMarker(`prefix ${STALL_MARKER} (1/2) continue…`), true);
});

test('hasStallMarker: ignores unrelated strings', () => {
  assert.equal(hasStallMarker('just a normal follow-up'), false);
  assert.equal(hasStallMarker(''), false);
});
