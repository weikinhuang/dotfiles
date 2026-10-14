import { expect, test } from 'vitest';

import { applyContextReminder, type ReminderMessage } from '../../../../lib/node/pi/context-reminder.ts';
import {
  composeReminderSpecs,
  createReminderLifecycle,
  readReminderSnapshots,
  reminderMessageAnchor,
  REMINDER_SNAPSHOT_TYPE,
  type ReminderPlacement,
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

test('restore and refresh cannot append a new snapshot after a tool-result continuation', () => {
  const lifecycle = createReminderLifecycle();
  const first = lifecycle.project(inject([user], 'original'));
  const tool: ReminderMessage = { role: 'toolResult', content: [{ type: 'text', text: 'result' }], timestamp: 3 };
  lifecycle.restore([first.captured!]);
  const continued = lifecycle.project(inject([user, tool], 'changed on recovery'));
  expect(continued.captured).toBeUndefined();
  expect(continued.messages).toEqual([...first.messages, tool]);
  lifecycle.refresh();
  expect(lifecycle.project(inject([user, tool], 'changed on retry')).captured).toBeUndefined();
  lifecycle.refresh();
  const next = { ...user, timestamp: 4 };
  expect(lifecycle.project(inject([user, tool, next], 'next user state')).captured?.specs[0].body).toBe(
    'next user state',
  );
});

test('new user runs append snapshots without removing historical ones', () => {
  const lifecycle = createReminderLifecycle();
  const first = lifecycle.project(inject([user], 'pending')).messages;
  lifecycle.refresh();
  const second = lifecycle.project(inject([user, { ...user, timestamp: 2 }], 'complete')).messages;
  expect(second.slice(0, first.length)).toEqual(first);
});

test('a custom-triggered run captures a stable snapshot without changing its historical message', () => {
  const lifecycle = createReminderLifecycle();
  const first = lifecycle.project(inject([user], 'first run')).messages;
  const custom: ReminderMessage = {
    role: 'custom',
    customType: 'scheduled-prompt',
    content: [{ type: 'text', text: 'continue the scene' }],
    timestamp: 2,
    display: true,
  };
  lifecycle.refresh();
  const current = lifecycle.project(inject([user, custom], 'scheduled run'));
  expect(current.captured?.specs).toEqual([{ id: 'todo-plan', body: 'scheduled run' }]);
  expect(current.messages.slice(0, first.length)).toEqual(first);
  expect(current.messages[first.length]).toEqual(custom);
  expect(custom.content).toEqual([{ type: 'text', text: 'continue the scene' }]);
  const next = lifecycle.project(
    inject([user, custom, { role: 'toolResult', content: 'tool output', timestamp: 3 }], 'changed mid-run'),
  );
  expect(next.messages.slice(0, current.messages.length)).toEqual(current.messages);
  lifecycle.restore([current.captured!]);
  expect(lifecycle.project(inject([user, custom], 'changed on resume')).messages.slice(-2)).toEqual(
    current.messages.slice(-2),
  );
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

test('compaction retains frozen snapshots when their origin survives; prompt and tools stay untouched', () => {
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
  expect(after.captured).toBeUndefined();
  expect(after.messages).toEqual(first.messages);
});

const older: ReminderMessage = { role: 'assistant', content: 'older scene', timestamp: 0 };
const positioned = (message: ReminderMessage, before: boolean, text: string): ReminderPlacement => ({
  anchor: reminderMessageAnchor(message),
  before,
  text,
});

test('positioned snapshots surround resolved anchors and remain byte-stable through tools and replay', () => {
  const lifecycle = createReminderLifecycle();
  const placements = [positioned(older, true, 'before older'), positioned(older, false, 'after older')];
  lifecycle.stagePlacements(placements);
  placements[0].text = 'mutated producer state';
  const first = lifecycle.project(inject([older, user], 'generic'));
  expect(first.captured?.anchor).toBe(reminderMessageAnchor(user));
  expect(first.captured?.placements).toEqual([
    positioned(older, true, 'before older'),
    positioned(older, false, 'after older'),
  ]);
  expect(first.messages.map((message) => message.content)).toEqual([
    'before older',
    older.content,
    'after older',
    user.content,
    [{ type: 'text', text: '<system-reminder id="todo-plan">\ngeneric\n</system-reminder>' }],
  ]);
  const outputs = first.messages.filter((message) => message.cacheReminderSnapshot === true);
  expect(outputs).toHaveLength(3);
  expect(outputs.every((message) => message.role === 'user' && message.timestamp === 1)).toBe(true);
  const originalBytes = JSON.stringify(first.messages);
  expect(JSON.stringify(lifecycle.project(first.messages).messages)).toBe(originalBytes);
  const history = [older, user];
  for (let index = 0; index < 10; index++) {
    history.push(
      { role: 'assistant', content: [], timestamp: index * 2 + 2 },
      { role: 'toolResult', content: `result ${index}`, timestamp: index * 2 + 3 },
    );
    lifecycle.stagePlacements([positioned(history.at(-1)!, true, 'moved during tools')]);
    const next = lifecycle.project(inject(history, 'changed generic'));
    expect(next.captured).toBeUndefined();
    expect(JSON.stringify(next.messages.slice(0, first.messages.length))).toBe(originalBytes);
  }
});

test('placement-only roots have no empty generic item and canonical string/array anchors survive resume and tree', () => {
  expect(reminderMessageAnchor(older)).toBe(
    reminderMessageAnchor({ ...older, content: [{ type: 'text', text: 'older scene' }] }),
  );
  const custom: ReminderMessage = { role: 'custom', content: 'continue', timestamp: 5, customType: 'scene' };
  const lifecycle = createReminderLifecycle();
  lifecycle.stagePlacements([positioned(older, false, 'standalone text')]);
  const first = lifecycle.project([older, custom]);
  expect(first.captured?.specs).toEqual([]);
  expect(first.captured?.anchor).toBe(reminderMessageAnchor(custom));
  expect(first.messages).toHaveLength(3);
  expect(first.messages[1].content).toBe('standalone text');
  expect(first.messages[1].timestamp).toBe(5);
  const entries = [{ type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data: first.captured }];
  const stored = readReminderSnapshots(JSON.parse(JSON.stringify(entries)) as unknown[]);
  expect(stored).toEqual([first.captured]);
  for (let index = 0; index < 2; index++) {
    lifecycle.restore(stored);
    lifecycle.stagePlacements([positioned(custom, true, 'replacement on same origin')]);
    const restored = lifecycle.project([older, custom]);
    expect(restored.captured).toBeUndefined();
    expect(JSON.stringify(restored.messages)).toBe(JSON.stringify(first.messages));
  }
  lifecycle.restore([]);
  expect(lifecycle.project([older, custom]).messages).toEqual([older, custom]);
});

test.each([
  null,
  {},
  [null],
  [{ anchor: 'a', text: 'x' }],
  [{ anchor: 'a', before: 'true', text: 'x' }],
  [{ anchor: 1, before: true, text: 'x' }],
  [{ anchor: 'a', before: true, text: 1 }],
])('malformed placement metadata rejects its entire custom snapshot: %j', (placements) => {
  const data = { anchor: reminderMessageAnchor(user), timestamp: 1, specs: [], placements };
  expect(readReminderSnapshots([{ type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data }])).toEqual([]);
  const lifecycle = createReminderLifecycle();
  lifecycle.stagePlacements(placements);
  expect(lifecycle.project([user])).toEqual({ messages: [user] });
});

test('explicit undefined placements are invalid, while absent and empty placement metadata remain compatible', () => {
  const data = { anchor: reminderMessageAnchor(user), timestamp: 1, specs: [] };
  const entry = { type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data };
  expect(readReminderSnapshots([entry])).toEqual([data]);
  expect(readReminderSnapshots([{ ...entry, data: { ...data, placements: [] } }])).toEqual([
    { ...data, placements: [] },
  ]);
  expect(readReminderSnapshots([{ ...entry, data: { ...data, placements: undefined } }])).toEqual([]);
});

test('refresh and restore discard staged positions while compaction retains surviving persisted roots', () => {
  const lifecycle = createReminderLifecycle();
  const placements = [positioned(older, false, 'stale placement')];
  lifecycle.stagePlacements(placements);
  lifecycle.refresh();
  expect(lifecycle.project([older, user]).messages).toEqual([older, user]);
  lifecycle.restore([]);
  lifecycle.stagePlacements(placements);
  lifecycle.restore([]);
  expect(lifecycle.project([older, user]).captured).toBeUndefined();
  lifecycle.refresh();
  lifecycle.stagePlacements(placements);
  const first = lifecycle.project([older, user]);
  lifecycle.refresh();
  lifecycle.stagePlacements(placements);
  lifecycle.restore(
    readReminderSnapshots([
      { type: 'custom', customType: REMINDER_SNAPSHOT_TYPE, data: first.captured },
      { type: 'compaction' },
    ]),
  );
  expect(lifecycle.project([older, user])).toEqual({ messages: first.messages });
});

test('missing targets are omitted, and missing initiating anchors deactivate all items in their root', () => {
  const lifecycle = createReminderLifecycle();
  lifecycle.stagePlacements([positioned(older, true, 'before'), positioned(older, false, 'after')]);
  const first = lifecycle.project(inject([older, user], 'generic'));
  const stored = [first.captured!];
  lifecycle.restore(stored);
  const withoutTarget = lifecycle.project([user]);
  expect(withoutTarget.messages).toEqual([user, first.messages.at(-1)!]);
  lifecycle.restore(stored);
  expect(lifecycle.project([older]).messages).toEqual([older]);
});

test('a new narrative root can place instructions in older history without changing historical root metadata', () => {
  const lifecycle = createReminderLifecycle();
  lifecycle.stagePlacements([positioned(older, false, 'first position')]);
  const first = lifecycle.project([older, user]);
  const rootBytes = JSON.stringify(first.captured);
  const nextUser = { ...user, timestamp: 10 };
  lifecycle.refresh();
  lifecycle.stagePlacements([positioned(older, true, 'new position in history')]);
  const next = lifecycle.project([older, user, nextUser]);
  expect(next.messages.map((message) => message.content)).toEqual([
    'new position in history',
    older.content,
    'first position',
    user.content,
    nextUser.content,
  ]);
  expect(JSON.stringify(first.captured)).toBe(rootBytes);
  expect(lifecycle.project(next.messages).messages).toEqual(next.messages);
});

test('staged positions cannot capture a fresh root on a tool-tail recovery or retry', () => {
  const lifecycle = createReminderLifecycle();
  const tool: ReminderMessage = { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }], timestamp: 2 };
  for (const rearm of [() => lifecycle.restore([]), () => lifecycle.refresh()]) {
    rearm();
    lifecycle.stagePlacements([positioned(user, true, 'tool-tail instruction')]);
    expect(lifecycle.project(inject([user, tool], 'generic'))).toEqual({ messages: [user, tool] });
    lifecycle.stagePlacements([positioned(user, true, 'late instruction')]);
    expect(lifecycle.project([user]).messages).toEqual([user]);
  }
});

test('previews are observational and do not consume an empty initial capture', () => {
  const lifecycle = createReminderLifecycle();
  lifecycle.refresh({ messageType: 'user' });
  expect(lifecycle.preview([user])).toEqual([user]);
  lifecycle.stageInsertions([{ depth: 0, text: 'new note' }]);
  const guide: ReminderMessage = { role: 'custom', customType: 'guide', content: 'startup', timestamp: 2 };
  const prepared = lifecycle.prepare([user, guide]);
  const first = lifecycle.preview([user, guide], prepared);
  expect(first.map((message) => message.content)).toEqual([user.content, 'new note', guide.content]);
  expect(lifecycle.preview([guide], prepared)).toEqual([guide]);
  expect(lifecycle.preview([user, guide], prepared)).toEqual(first);
  const committed = lifecycle.project([user, guide], prepared);
  expect(committed.captured?.anchor).toBe(reminderMessageAnchor(user));
  expect(committed.messages).toEqual(first);
});

test('pending relative depths bind only to the accepted first-request window', () => {
  const lifecycle = createReminderLifecycle();
  lifecycle.refresh({ messageType: 'user' });
  lifecycle.stageInsertions([{ depth: 99, text: 'note at the available history start' }]);
  const prepared = lifecycle.prepare([older, user]);
  expect(lifecycle.preview([older, user], prepared)[0].content).toBe('note at the available history start');
  const final = lifecycle.project([user], prepared);
  expect(final.messages.map((message) => message.content)).toEqual([
    'note at the available history start',
    user.content,
  ]);
  const tool: ReminderMessage = { role: 'toolResult', content: 'result', timestamp: 3 };
  expect(lifecycle.project([user, tool]).messages).toEqual([...final.messages, tool]);
});

test('capture persistence failure leaves the frozen candidate available for retry', () => {
  const lifecycle = createReminderLifecycle();
  const prepared = lifecycle.prepare(inject([user], 'frozen plan'));
  expect(() =>
    lifecycle.project([user], prepared, () => {
      throw new Error('disk write failed');
    }),
  ).toThrow('disk write failed');
  const committed = lifecycle.project([user], prepared);
  expect(committed.captured?.specs[0].body).toBe('frozen plan');
  committed.captured!.specs[0].body = 'external mutation';
  expect(JSON.stringify(lifecycle.project([user]).messages)).not.toContain('external mutation');
});
