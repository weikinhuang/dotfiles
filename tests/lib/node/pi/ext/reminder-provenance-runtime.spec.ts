import { AgentSession, SessionManager, convertToLlm, type ContextEvent } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';

import { applyContextReminder, type ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import {
  ensureReminderIdentities,
  persistedReminderOrigin,
  reminderMessageAnchor,
  reminderProjectionIds,
} from '../../../../../lib/node/pi/reminder-identity.ts';
import {
  createReminderLifecycle,
  readReminderSnapshots,
  REMINDER_SNAPSHOT_TYPE,
} from '../../../../../lib/node/pi/reminder-lifecycle.ts';

test('real SDK run preparation puts auxiliary messages after the trigger without stealing its snapshot boundary', async () => {
  const queued = {
    role: 'custom',
    customType: 'queued-guide',
    content: 'queued guidance',
    display: false,
    timestamp: 20,
  };
  const options = { selectedTools: [] };
  const receiver = {
    _findLastAssistantMessage: () => undefined,
    _baseSystemPromptOptions: options,
    _extensionRunner: {
      emitBeforeAgentStart: async () => ({
        systemPromptOptions: options,
        messages: [{ customType: 'handler-guide', content: 'handler guidance', display: false }],
      }),
    },
    getActiveToolNames: () => [],
    _normalizePromptImages: async () => ({ hints: ['NORMALIZED_HINT'], images: [] }),
    _pendingNextTurnMessages: [queued],
    _preparePromptAndToolLoadout: () => undefined,
  };
  const prepare = (
    AgentSession.prototype as unknown as {
      _prepareRun: (this: unknown, trigger: unknown) => Promise<ContextEvent['messages']>;
    }
  )._prepareRun;
  const prepared = await prepare.call(receiver, { messageType: 'user', prompt: 'reef' });
  expect(prepared.map((message) => message.role)).toEqual(['user', 'custom', 'custom']);
  const primary = prepared[0];
  if (primary.role !== 'user') throw new Error('SDK preparation did not start with a user input');
  expect(JSON.stringify(primary.content)).toContain('NORMALIZED_HINT');
  const manager = SessionManager.inMemory(process.cwd());
  const frontier = reminderProjectionIds(manager.buildSessionProjection());
  for (const message of prepared) {
    if (message.role === 'custom')
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    else if (message.role === 'user') manager.appendMessage(message);
  }
  const projection = manager.buildSessionProjection();
  const tagged = ensureReminderIdentities(prepared as unknown as ReminderMessage[], projection);
  const lifecycle = createReminderLifecycle();
  lifecycle.refresh({ messageType: 'user' });
  lifecycle.bindOrigin(persistedReminderOrigin(projection, frontier, { messageType: 'user' }));
  lifecycle.stageInsertions([{ depth: 0, text: 'depth lore' }]);
  const result = lifecycle.project(applyContextReminder(tagged, { id: 'roleplay-lore', body: 'keyword lore' }));
  expect(result.captured?.anchor).toBe(reminderMessageAnchor(tagged[0]));
  expect(result.messages.map((message) => message.content)).toEqual([
    tagged[0].content,
    [{ type: 'text', text: '<system-reminder id="roleplay-lore">\nkeyword lore\n</system-reminder>' }],
    'depth lore',
    queued.content,
    [{ type: 'text', text: 'handler guidance' }],
  ]);
});

test('real persisted custom entry IDs survive timestamp reconstruction, reopening, and compaction', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const live: ReminderMessage = {
    role: 'custom',
    customType: 'scheduled-prompt',
    content: 'scene',
    display: true,
    timestamp: 1,
  };
  const inputId = manager.appendCustomMessageEntry('scheduled-prompt', 'scene', true);
  const projection = manager.buildSessionProjection();
  const tagged = ensureReminderIdentities([live], projection);
  const lifecycle = createReminderLifecycle();
  lifecycle.refresh({ messageType: 'custom', customType: 'scheduled-prompt', timestamp: 1 });
  lifecycle.bindOrigin(
    persistedReminderOrigin(projection, new Set(), { messageType: 'custom', customType: 'scheduled-prompt' }),
  );
  lifecycle.stageInsertions([{ depth: 0, text: 'frozen note' }]);
  const first = lifecycle.project(tagged);
  expect(first.captured?.anchor).toBe(`entry:${inputId}:0`);
  manager.appendCustomEntry(REMINDER_SNAPSHOT_TYPE, first.captured);
  const header = manager.getHeader();
  expect(header).toBeDefined();
  const reopened = SessionManager.inMemory(process.cwd(), undefined, [header!, ...manager.getBranch()]);
  const resumedProjection = reopened.buildSessionProjection();
  const resumed = ensureReminderIdentities(
    resumedProjection.messages as unknown as ReminderMessage[],
    resumedProjection,
  );
  expect(resumed[0].timestamp).not.toBe(live.timestamp);
  lifecycle.restore(readReminderSnapshots(reopened.getBranch()));
  const wire = (messages: ReminderMessage[]): { role: string; content: unknown }[] =>
    convertToLlm(messages as unknown as Parameters<typeof convertToLlm>[0]).map((message) => ({
      role: message.role,
      content: message.content,
    }));
  expect(wire(lifecycle.project(resumed).messages)).toEqual(wire(first.messages));
  reopened.appendCompaction('older context', inputId, 100);
  const compactedProjection = reopened.buildSessionProjection();
  const compacted = ensureReminderIdentities(
    compactedProjection.messages as unknown as ReminderMessage[],
    compactedProjection,
  );
  lifecycle.restore(readReminderSnapshots(reopened.getBranch()));
  const after = lifecycle.project(compacted);
  expect(after.captured).toBeUndefined();
  expect(
    after.messages.filter((message) => message.cacheReminderSnapshot === true).map((message) => message.content),
  ).toEqual(['frozen note']);
});
