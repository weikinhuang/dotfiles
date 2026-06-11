/**
 * Tests for lib/node/pi/context-reminder.ts.
 *
 * Covers the edge cases that make the generic helper worth centralizing:
 *   1. content normalization (string content, image blocks preserved)
 *   2. no trailing user/toolResult message → no injection
 *   3. idempotent GC / fixpoint (re-applying same spec is stable)
 *   4. determinism (same input + body → identical output)
 *   5. multi-id coexistence (one extension's strip never touches another's)
 *  plus: body=null strips only; injection target is the LAST user/toolResult.
 */

import { expect, test } from 'vitest';

import {
  applyContextReminder,
  frameReminder,
  type ReminderMessage,
  stripReminder,
} from '../../../../lib/node/pi/context-reminder.ts';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

const userText = (text: string, extra: Record<string, unknown> = {}): ReminderMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...extra,
});

const userString = (text: string): ReminderMessage => ({ role: 'user', content: text });

const assistant = (text: string): ReminderMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

const toolResult = (text: string): ReminderMessage => ({
  role: 'toolResult',
  content: [{ type: 'text', text }],
});

/** Pull every system-reminder text block (across all messages) for an id. */
function reminderBlocks(messages: readonly ReminderMessage[], id: string): string[] {
  const open = `<system-reminder id="${id}">`;
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'text' && typeof (b as { text?: string }).text === 'string') {
        const t = (b as { text: string }).text;
        if (t.startsWith(open)) out.push(t);
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// frameReminder
// ──────────────────────────────────────────────────────────────────────

test('frameReminder: wraps body in an id-tagged system-reminder', () => {
  expect(frameReminder('todo-plan', 'do the thing')).toBe(
    '<system-reminder id="todo-plan">\ndo the thing\n</system-reminder>',
  );
});

// ──────────────────────────────────────────────────────────────────────
// Basic injection
// ──────────────────────────────────────────────────────────────────────

test('injects a framed block onto the last user message', () => {
  const msgs = [userText('hello')];
  const out = applyContextReminder(msgs, { id: 'todo-plan', body: 'PLAN' });
  expect(reminderBlocks(out, 'todo-plan')).toEqual(['<system-reminder id="todo-plan">\nPLAN\n</system-reminder>']);
  // original untouched
  expect(msgs[0].content).toEqual([{ type: 'text', text: 'hello' }]);
});

test('does not mutate the input array or messages', () => {
  const msgs = [userText('hello')];
  const snapshot = JSON.stringify(msgs);
  applyContextReminder(msgs, { id: 'todo-plan', body: 'PLAN' });
  expect(JSON.stringify(msgs)).toBe(snapshot);
});

test('injection target is the LAST user/toolResult, not an earlier one', () => {
  const out = applyContextReminder([userText('first'), assistant('reply'), toolResult('tool out')], {
    id: 'x',
    body: 'B',
  });
  // the toolResult is the last injectable message
  expect(typeof out[0].content === 'object' && reminderBlocks([out[0]], 'x')).toEqual([]);
  expect(reminderBlocks([out[2]], 'x')).toHaveLength(1);
});

// ── Edge case 1: content normalization ─────────────────────────────────

test('normalizes string content to blocks, preserving the original text', () => {
  const out = applyContextReminder([userString('plain string prompt')], { id: 'todo-plan', body: 'PLAN' });
  expect(out[0].content).toEqual([
    { type: 'text', text: 'plain string prompt' },
    { type: 'text', text: '<system-reminder id="todo-plan">\nPLAN\n</system-reminder>' },
  ]);
});

test('preserves non-text (image) blocks when splicing', () => {
  const img = { type: 'image', image: 'data://x' };
  const out = applyContextReminder([{ role: 'user', content: [img, { type: 'text', text: 'hi' }] }], {
    id: 'x',
    body: 'B',
  });
  const content = out[0].content as { type: string }[];
  expect(content[0]).toEqual(img);
  expect(content[1]).toEqual({ type: 'text', text: 'hi' });
  expect(content[2].type).toBe('text');
});

test('preserves extra message fields (timestamp, etc.)', () => {
  const out = applyContextReminder([userText('hi', { timestamp: 123, foo: 'bar' })], { id: 'x', body: 'B' });
  expect(out[0].timestamp).toBe(123);
  expect(out[0].foo).toBe('bar');
});

// ── Edge case 2: no trailing user/toolResult ───────────────────────────

test('no injection when there is no user/toolResult message', () => {
  const msgs = [assistant('only an assistant turn')];
  const out = applyContextReminder(msgs, { id: 'x', body: 'B' });
  expect(reminderBlocks(out, 'x')).toEqual([]);
  expect(out[0].content).toEqual([{ type: 'text', text: 'only an assistant turn' }]);
});

test('no injection on an empty message array', () => {
  expect(applyContextReminder([], { id: 'x', body: 'B' })).toEqual([]);
});

test('does not inject after a trailing assistant message', () => {
  // assistant is the last message → not injectable
  const out = applyContextReminder([userText('q'), assistant('a')], { id: 'x', body: 'B' });
  expect(reminderBlocks(out, 'x')).toEqual([]);
});

// ── Edge case 3: idempotent GC / fixpoint ──────────────────────────────

test('re-applying the same spec is a fixpoint (single block, identical output)', () => {
  const base = [userText('hello')];
  const once = applyContextReminder(base, { id: 'todo-plan', body: 'PLAN' });
  const twice = applyContextReminder(once, { id: 'todo-plan', body: 'PLAN' });
  expect(reminderBlocks(twice, 'todo-plan')).toHaveLength(1);
  expect(twice).toEqual(once);
});

test('updating the body replaces the prior block, never stacks', () => {
  const base = [userText('hello')];
  const v1 = applyContextReminder(base, { id: 'todo-plan', body: 'PLAN A' });
  const v2 = applyContextReminder(v1, { id: 'todo-plan', body: 'PLAN B' });
  expect(reminderBlocks(v2, 'todo-plan')).toEqual(['<system-reminder id="todo-plan">\nPLAN B\n</system-reminder>']);
});

// ── Edge case 4: determinism ───────────────────────────────────────────

test('deterministic: identical input + body yields identical output', () => {
  const mk = (): ReminderMessage[] => [userText('hello'), toolResult('out')];
  const a = applyContextReminder(mk(), { id: 'x', body: 'B' });
  const b = applyContextReminder(mk(), { id: 'x', body: 'B' });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

// ── Edge case 5: multi-id coexistence ──────────────────────────────────

test('two different ids coexist; stripping one leaves the other', () => {
  const base = [userText('hello')];
  const withTodo = applyContextReminder(base, { id: 'todo-plan', body: 'TODO' });
  const withBoth = applyContextReminder(withTodo, { id: 'memory', body: 'MEM' });
  expect(reminderBlocks(withBoth, 'todo-plan')).toHaveLength(1);
  expect(reminderBlocks(withBoth, 'memory')).toHaveLength(1);

  // Re-running the todo reminder must not disturb the memory block.
  const refreshed = applyContextReminder(withBoth, { id: 'todo-plan', body: 'TODO2' });
  expect(reminderBlocks(refreshed, 'todo-plan')).toEqual([
    '<system-reminder id="todo-plan">\nTODO2\n</system-reminder>',
  ]);
  expect(reminderBlocks(refreshed, 'memory')).toEqual(['<system-reminder id="memory">\nMEM\n</system-reminder>']);
});

// ── body=null / empty → strip only ─────────────────────────────────────

test('body=null strips an existing block and injects nothing', () => {
  const withBlock = applyContextReminder([userText('hello')], { id: 'todo-plan', body: 'PLAN' });
  const cleared = applyContextReminder(withBlock, { id: 'todo-plan', body: null });
  expect(reminderBlocks(cleared, 'todo-plan')).toEqual([]);
  expect(cleared[0].content).toEqual([{ type: 'text', text: 'hello' }]);
});

test('whitespace-only body is treated as empty (strip only)', () => {
  const out = applyContextReminder([userText('hello')], { id: 'x', body: '   \n  ' });
  expect(reminderBlocks(out, 'x')).toEqual([]);
});

test('body is trimmed before framing', () => {
  const out = applyContextReminder([userText('hello')], { id: 'x', body: '  PLAN  ' });
  expect(reminderBlocks(out, 'x')).toEqual(['<system-reminder id="x">\nPLAN\n</system-reminder>']);
});

// ── stripReminder direct ───────────────────────────────────────────────

test('stripReminder removes only the matching id and keeps message identity for untouched messages', () => {
  const withBoth = applyContextReminder(
    applyContextReminder([userText('hello'), assistant('a'), toolResult('out')], { id: 'a', body: 'A' }),
    { id: 'b', body: 'B' },
  );
  const stripped = stripReminder(withBoth, 'a');
  expect(reminderBlocks(stripped, 'a')).toEqual([]);
  expect(reminderBlocks(stripped, 'b')).toHaveLength(1);
  // the assistant message was never touched → same reference
  expect(stripped[1]).toBe(withBoth[1]);
});

test('messages with non-array content (e.g. undefined) are passed through, not crashed on', () => {
  // Some AgentMessage kinds arrive with `content` undefined; stripReminder
  // must not call `.some` on them.
  const weird = { role: 'assistant', content: undefined } as unknown as ReminderMessage;
  const messages = [userText('hello'), weird, toolResult('out')];
  const stripped = stripReminder(messages, 'a');
  expect(stripped[1]).toBe(weird);

  // And a full apply still injects into the trailing toolResult.
  const out = applyContextReminder(messages, { id: 'x', body: 'PLAN' });
  expect(out[1]).toBe(weird);
  expect(reminderBlocks(out, 'x')).toEqual(['<system-reminder id="x">\nPLAN\n</system-reminder>']);
});

test('injecting into a trailing message with non-array content starts a fresh block array', () => {
  const weird = { role: 'toolResult', content: undefined } as unknown as ReminderMessage;
  const out = applyContextReminder([userText('hi'), weird], { id: 'x', body: 'PLAN' });
  expect(out[1].content).toEqual([{ type: 'text', text: '<system-reminder id="x">\nPLAN\n</system-reminder>' }]);
});
