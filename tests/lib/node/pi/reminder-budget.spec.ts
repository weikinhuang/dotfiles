import { expect, test } from 'vitest';

import type { ReminderMessage } from '../../../../lib/node/pi/context-reminder.ts';
import { limitReminderContext, reminderRequestChars } from '../../../../lib/node/pi/reminder-budget.ts';
import { createReminderLifecycle, reminderMessageAnchor } from '../../../../lib/node/pi/reminder-lifecycle.ts';

const input = (index: number): ReminderMessage => ({ role: 'user', content: `scene ${index}`, timestamp: index });

test('the request size includes SDK structured system sections and toolsAdded', () => {
  const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }];
  const messages: ReminderMessage[] = [
    { role: 'system', content: '', sections: { base: 'SYSTEM_BASE', persona: 'PERSONA' }, toolsAdded: tools },
    { role: 'user', content: 'hello' },
  ];
  expect(reminderRequestChars(messages)).toBe(
    'SYSTEM_BASE'.length + 'PERSONA'.length + JSON.stringify(tools).length + 5,
  );
});

test('the hard floor counts all replayed snapshots, including the pending first request', () => {
  const lifecycle = createReminderLifecycle();
  const history: ReminderMessage[] = [{ role: 'system', content: 'STATIC' }];
  for (let i = 0; i < 7; i++) {
    const user = input(i);
    history.push(user);
    lifecycle.refresh({ messageType: 'user' });
    lifecycle.stageInsertions([{ depth: 0, text: 'tone '.repeat(600) }]);
    lifecycle.project(history);
  }
  const current = input(8);
  history.push(current);
  lifecycle.refresh({ messageType: 'user' });
  lifecycle.stageInsertions([{ depth: 0, text: 'tone '.repeat(600) }]);
  const prepared = lifecycle.prepare(history);
  const preview = (messages: readonly ReminderMessage[]): ReminderMessage[] => lifecycle.preview(messages, prepared);
  expect(reminderRequestChars(preview(history)) / 4).toBeGreaterThan(4096);
  const result = limitReminderContext({
    messages: history,
    preview,
    origin: reminderMessageAnchor(current),
    windowTokens: 4096,
    charsPerToken: 4,
  });
  expect(result.fits).toBe(true);
  expect(result.messages).toContain(current);
  expect(result.messages[0].role).toBe('system');
  expect(reminderRequestChars(preview(result.messages)) / 4).toBeLessThanOrEqual(1024);
  // Planning does not commit the candidate or consume its initial capture.
  expect(lifecycle.project(result.messages, prepared).captured?.anchor).toBe(reminderMessageAnchor(current));
});

test('a frozen late floor never reintroduces earlier history and only advances on overflow', () => {
  const users = [input(1), input(2), input(3)];
  const first = limitReminderContext({
    messages: users,
    preview: (messages) => messages.map((message) => ({ ...message, content: 'x'.repeat(5000) })),
    origin: reminderMessageAnchor(users[2]),
    windowTokens: 4096,
    charsPerToken: 4,
  });
  expect(first.fits).toBe(true);
  expect(first.floorAnchor).toBe(reminderMessageAnchor(users[1]));
  const next = limitReminderContext({
    messages: [...users, { role: 'toolResult', content: 'result' }],
    preview: (messages) => messages,
    origin: reminderMessageAnchor(users[2]),
    floorAnchor: first.floorAnchor,
    windowTokens: 4096,
    charsPerToken: 4,
  });
  expect(next.messages).toEqual([users[1], users[2], { role: 'toolResult', content: 'result' }]);
  expect(next.floorAnchor).toBe(first.floorAnchor);
});

test('startup guidance remains after the protected input while older turns are removed', () => {
  const user = input(2);
  const guide: ReminderMessage = { role: 'custom', content: 'startup guide' };
  const messages = [input(1), user, guide];
  const result = limitReminderContext({
    messages,
    origin: reminderMessageAnchor(user),
    windowTokens: 4096,
    charsPerToken: 4,
    preview: (candidate) =>
      candidate.map((message) => ({
        ...message,
        content: message.timestamp === 1 ? 'x'.repeat(20000) : message.content,
      })),
  });
  expect(result.fits).toBe(true);
  expect(result.messages).toEqual([user, guide]);
});

test('an indivisible oversized trigger cannot be silently dropped or sent over budget', () => {
  const current = { ...input(1), content: 'x'.repeat(20000) };
  const result = limitReminderContext({
    messages: [current],
    preview: (messages) => messages,
    origin: reminderMessageAnchor(current),
    windowTokens: 4096,
    charsPerToken: 4,
  });
  expect(result.fits).toBe(false);
  expect(result.messages).toEqual([current]);
});

test('when the reserve target is impossible, keeps the earliest suffix that fits the hard limit', () => {
  const users = [input(1), input(2), input(3)];
  const messages: ReminderMessage[] = [
    { role: 'system', content: 'x'.repeat(6000) },
    { ...users[0], content: 'x'.repeat(7000) },
    ...users.slice(1),
  ];
  const result = limitReminderContext({
    messages,
    preview: (candidate) => candidate,
    origin: reminderMessageAnchor(users[2]),
    windowTokens: 4096,
    charsPerToken: 4,
  });
  expect(result.fits).toBe(true);
  expect(result.messages).toEqual([messages[0], users[1], users[2]]);
  expect(result.floorAnchor).toBe(reminderMessageAnchor(users[1]));
});

test('request accounting includes system tool declarations and SDK summary messages', () => {
  const tools = [{ name: 'read', parameters: { type: 'object' } }];
  const messages = [{ role: 'system', content: 'header', tools }];
  expect(reminderRequestChars(messages)).toBe('header'.length + JSON.stringify(tools).length);
  const result = limitReminderContext({
    messages: [input(1)],
    preview: (messages) => messages,
    windowTokens: 4096,
    charsPerToken: Number.NaN,
    floorAnchor: 'missing',
  });
  expect(result.fits).toBe(true);
  expect(result.floorAnchor).toBeUndefined();
});
