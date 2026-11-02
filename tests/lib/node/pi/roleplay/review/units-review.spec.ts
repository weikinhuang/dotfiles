/**
 * Review reproductions on pure helpers. Each test asserts the CORRECT
 * behavior; a failure reproduces a finding. Synthetic data only.
 */
import { expect, test } from 'vitest';

import { frameReminder, type ReminderMessage } from '../../../../../../lib/node/pi/context-reminder.ts';
import { createReminderLifecycle } from '../../../../../../lib/node/pi/reminder-lifecycle.ts';
import { applyLayeredWindow, updateCharsPerToken } from '../../../../../../lib/node/pi/roleplay/context-window.ts';

test('review: projection never strips a framed block that a tool result legitimately returned', () => {
  // A `read` of a file whose text part is exactly a framed reminder (e.g. a saved
  // transcript or a doc about the convention). Not a producer block.
  const toolText = frameReminder('notes', 'FILE_BODY_THE_MODEL_ASKED_FOR');
  const messages: ReminderMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'read notes.md' }], timestamp: 1, cacheReminderEntryId: 'u1' },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
      timestamp: 2,
      cacheReminderEntryId: 'a1',
    },
    {
      role: 'toolResult',
      toolCallId: 'c1',
      content: [{ type: 'text', text: toolText }],
      timestamp: 3,
      cacheReminderEntryId: 't1',
    },
  ];
  const lifecycle = createReminderLifecycle();
  lifecycle.restore([]); // a tool continuation: nothing pending
  const { messages: out } = lifecycle.project(messages);
  expect(JSON.stringify(out)).toContain('FILE_BODY_THE_MODEL_ASKED_FOR');
});

test('review: calibration learns a dense-script ratio below one char per token', () => {
  // CJK prose is commonly ~0.6-1.0 chars/token. Rejecting observed < 1 pins the
  // estimate at the optimistic default of 4, a 4x+ underestimate of every request.
  const next = updateCharsPerToken(4, 9000, 12000);
  expect(next).toBeLessThan(4);
});

test('review: a drop boundary on a custom input never snaps forward past uncovered messages', () => {
  const msgs = [
    { role: 'user', content: 'u0' },
    { role: 'assistant', content: 'a0' },
    { role: 'custom', content: 'scheduled c1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ];
  // Coverage is [0, 2): only u0 / a0 are summarized.
  const { messages: out } = applyLayeredWindow(msgs, 2, 2, { keepTurns: 1, assistantChars: 200, userChars: 400 });
  expect(out.map((m) => m.content)).toContain('scheduled c1');
  expect(out.map((m) => m.content)).toContain('a1');
});
