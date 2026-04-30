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
  hasStallMarker,
  lastAssistantSnapshot,
  snapshotFromAssistantMessage,
  STALL_MARKER,
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
