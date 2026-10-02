import { expect, test } from 'vitest';

import { applyContextReminder, type ReminderMessage } from '../../../../lib/node/pi/context-reminder.ts';
import {
  composeReminderSpecs,
  createReminderLifecycle,
  readReminderSnapshots,
  REMINDER_SNAPSHOT_TYPE,
} from '../../../../lib/node/pi/reminder-lifecycle.ts';

const user: ReminderMessage = { role: 'user', content: [{ type: 'text', text: 'prompt' }], timestamp: 1 };
const inject = (messages: ReminderMessage[], body: string): ReminderMessage[] =>
  applyContextReminder(messages, { id: 'todo-plan', body });

test('stable ten-call tool loop never rewrites prior serialized items, even after state changes', () => {
  const lifecycle = createReminderLifecycle();
  const messages = [user];
  let previous: ReminderMessage[] = [];
  for (let i = 0; i < 10; i++) {
    const result = lifecycle.project(inject(messages, `state ${i}`));
    expect(result.messages.slice(0, previous.length)).toEqual(previous);
    expect(result.messages[1].content).toEqual([
      { type: 'text', text: '<system-reminder id="todo-plan">\nstate 0\n</system-reminder>' },
    ]);
    previous = result.messages;
    messages.push(
      { role: 'assistant', content: [], timestamp: 2 + i * 2 },
      { role: 'toolResult', content: [{ type: 'text', text: `result ${i}` }], timestamp: 3 + i * 2 },
    );
  }
});

test('empty run does not start injecting newly created tool-loop state; next user run captures it', () => {
  const lifecycle = createReminderLifecycle();
  expect(lifecycle.project([user]).messages).toEqual([user]);
  expect(lifecycle.project(inject([user], 'new plan')).messages).toEqual([user]);
  lifecycle.refresh();
  const next = { ...user, timestamp: 2 };
  expect(lifecycle.project(inject([user, next], 'new plan')).captured?.specs[0].body).toBe('new plan');
});

test('new user runs append snapshots without removing historical ones', () => {
  const lifecycle = createReminderLifecycle();
  const first = lifecycle.project(inject([user], 'pending')).messages;
  lifecycle.refresh();
  const second = lifecycle.project(inject([user, { ...user, timestamp: 2 }], 'complete')).messages;
  expect(second.slice(0, first.length)).toEqual(first);
});

test('composition sorts stable IDs and replay is a fixpoint', () => {
  expect(
    composeReminderSpecs([
      { id: 'z', body: 'Z' },
      { id: 'a', body: 'A' },
      { id: 'empty', body: null },
    ]).map((spec) => spec.id),
  ).toEqual(['a', 'z']);
  const lifecycle = createReminderLifecycle();
  const first = lifecycle.project(applyContextReminder(inject([user], 'PLAN'), { id: 'bg-jobs', body: 'JOBS' }));
  expect(first.captured?.specs.map((spec) => spec.id)).toEqual(['bg-jobs', 'todo-plan']);
  expect(lifecycle.project(first.messages).messages).toEqual(first.messages);
});

test('resume restores exact bytes, branch navigation does not leak abandoned snapshots', () => {
  const lifecycle = createReminderLifecycle();
  const first = lifecycle.project(inject([user], 'original'));
  const stored = readReminderSnapshots([{ type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data: first.captured }]);
  lifecycle.restore(stored);
  expect(lifecycle.project(inject([user], 'changed on resume')).messages).toEqual(first.messages);
  lifecycle.restore([]);
  expect(lifecycle.project([user]).messages).toEqual([user]);
  expect(readReminderSnapshots([null, { type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data: {} }])).toEqual([]);
});

test('compaction introduces a new snapshot once, without resurrecting removed history', () => {
  const lifecycle = createReminderLifecycle();
  lifecycle.project(inject([user], 'old'));
  lifecycle.refresh();
  const compacted: ReminderMessage[] = [{ role: 'compactionSummary', content: 'summary', timestamp: 10 }];
  const first = lifecycle.project(inject([...compacted, { ...user, timestamp: 11 }], 'current'));
  expect(JSON.stringify(first.messages)).not.toContain('old');
  expect(lifecycle.project(first.messages).messages).toEqual(first.messages);
});

test('compaction resets stored snapshots even when the old anchor survives; prompt and tools stay untouched', () => {
  const lifecycle = createReminderLifecycle();
  const system: ReminderMessage = {
    role: 'system',
    content: 'static prompt',
    toolsAdded: [{ name: 'todo' }],
    timestamp: 0,
  };
  const first = lifecycle.project(inject([system, user], 'old'));
  const entries = [
    { type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data: first.captured },
    { type: 'compaction' },
  ];
  lifecycle.restore(readReminderSnapshots(entries));
  const after = lifecycle.project(inject([system, user], 'restored current state'));
  expect(after.messages[0]).toBe(system);
  expect(after.captured?.specs[0].body).toBe('restored current state');
  expect(JSON.stringify(after.messages)).not.toContain('old');
});
