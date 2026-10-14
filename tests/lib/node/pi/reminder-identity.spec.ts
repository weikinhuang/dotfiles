import { expect, test } from 'vitest';

import { applyContextReminder, type ReminderMessage } from '../../../../lib/node/pi/context-reminder.ts';
import {
  ensureReminderIdentities,
  persistedReminderOrigin,
  reminderMessageAnchor,
  reminderOriginIndex,
  reminderProjectionIds,
  REMINDER_ENTRY_ID,
} from '../../../../lib/node/pi/reminder-identity.ts';
import { createReminderLifecycle } from '../../../../lib/node/pi/reminder-lifecycle.ts';

const user: ReminderMessage = { role: 'user', content: 'scene', timestamp: 1 };
const guide: ReminderMessage = { role: 'custom', customType: 'guide', content: 'startup guidance', timestamp: 2 };
const projection = (messages: ReminderMessage[]): unknown => ({
  entries: messages.map((message, index) => ({ sourceEntry: { id: `id-${index}` }, messages: [message] })),
});

test('persisted identities survive content overlays and same-tick messages stay distinct', () => {
  const other = { ...user, content: 'another scene' };
  const tagged = ensureReminderIdentities([user, other], projection([user, other]));
  expect(tagged.map((message) => message[REMINDER_ENTRY_ID])).toEqual(['entry:id-0:0', 'entry:id-1:0']);
  expect(reminderMessageAnchor({ ...tagged[0], content: 'redacted or condensed' })).toBe(
    reminderMessageAnchor(tagged[0]),
  );
  expect(user).not.toHaveProperty(REMINDER_ENTRY_ID);
});

test('live custom timestamps can differ from persisted timestamps without changing identity', () => {
  const live = { ...guide, timestamp: 10 };
  const saved = { ...guide, timestamp: 20 };
  const first = ensureReminderIdentities([live], projection([saved]));
  const resumed = ensureReminderIdentities([saved], projection([saved]));
  expect(reminderMessageAnchor(first[0])).toBe(reminderMessageAnchor(resumed[0]));
});

test('unique envelope matching works on a reduced window and ambiguous matches are not guessed', () => {
  const unique = ensureReminderIdentities([guide], projection([user, guide]));
  expect(unique[0][REMINDER_ENTRY_ID]).toBe('entry:id-1:0');
  const ambiguous = ensureReminderIdentities([user], projection([user, { ...user, content: 'different' }]));
  expect(ambiguous[0]).not.toHaveProperty(REMINDER_ENTRY_ID);
  expect(reminderOriginIndex(ambiguous, { messageType: 'user' })).toBe(-1);
});

test('actual run inputs precede nextTurn and startup-handler messages', () => {
  const past = projection([user]);
  const current = { ...user, timestamp: 3, content: 'new scene' };
  const projected = projection([user, current, guide]);
  const origin = persistedReminderOrigin(projected, reminderProjectionIds(past), { messageType: 'user' });
  const tagged = ensureReminderIdentities([user, current, guide], projected);
  expect(origin).toBe('entry:id-1:0');
  expect(reminderOriginIndex(tagged, { messageType: 'user' }, origin)).toBe(1);
  expect(reminderOriginIndex(tagged, { messageType: 'user' })).toBe(1);
});

test('bound custom identity beats an appended identical-type startup message', () => {
  const scheduled = { ...guide, customType: 'scheduled-prompt' };
  const extra = { ...scheduled, content: 'operational extra' };
  const projected = projection([scheduled, extra]);
  const tagged = ensureReminderIdentities([scheduled, extra], projected);
  const origin = persistedReminderOrigin(projected, new Set(), {
    messageType: 'custom',
    customType: 'scheduled-prompt',
  });
  expect(reminderOriginIndex(tagged, undefined, origin)).toBe(0);
  expect(
    reminderOriginIndex([scheduled], { messageType: 'custom', customType: 'scheduled-prompt', timestamp: 2 }),
  ).toBe(0);
  expect(
    reminderOriginIndex([scheduled, extra], { messageType: 'custom', customType: 'scheduled-prompt', timestamp: 2 }),
  ).toBe(-1);
});

test('stamps and older content-based callers both project without depending on mutable text', () => {
  const tagged = ensureReminderIdentities([user], projection([user]));
  const lifecycle = createReminderLifecycle();
  lifecycle.refresh({ messageType: 'user' });
  lifecycle.stageInsertions([{ depth: 0, text: 'standing note' }]);
  const first = lifecycle.project(applyContextReminder(tagged, { id: 'todo-plan', body: 'pending' }));
  const changed = [{ ...tagged[0], content: 'a transformed prompt' }];
  expect(lifecycle.project(changed).messages.slice(1)).toEqual(first.messages.slice(1));
  expect(reminderOriginIndex([{ role: 'toolResult', content: 'result' }])).toBe(-1);
});

test('synthetic messages and malformed provenance remain safe and projection stamps are idempotent', () => {
  const tagged = ensureReminderIdentities([user, guide]);
  expect(ensureReminderIdentities(tagged)).toEqual(tagged);
  expect(
    ensureReminderIdentities([user], { entries: [null, { sourceEntry: {}, messages: [] }] }).map(
      (message) => message.role,
    ),
  ).toEqual(['user']);
  const snapshot = { ...user, cacheReminderSnapshot: true };
  expect(ensureReminderIdentities([snapshot])[0]).toBe(snapshot);
});
