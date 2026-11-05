import { expect, test } from 'vitest';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { limitReminderContext } from '../../../../../lib/node/pi/reminder-budget.ts';
import { dropCoveredMessages, retainedTranscriptStart } from '../../../../../lib/node/pi/roleplay/budget-coverage.ts';
import {
  pinnedKeys,
  projectSceneMemory,
  restorePinnedHead,
} from '../../../../../lib/node/pi/roleplay/pinned-window.ts';
import { captureRoleplayRequest } from '../../../../../lib/node/pi/roleplay/request-report.ts';

function user(content: string, timestamp: number): ReminderMessage {
  return { role: 'user', content, timestamp };
}

test('pinned opener remains verbatim before recap, timeline and the retained continuation', () => {
  const opener = user('ORIGINAL_OPENER', 1);
  const tail = user('LATEST_ACTION', 3);
  const output = projectSceneMemory([tail], 'RECAP_BODY', 'TIMELINE_BODY', [opener]);
  expect(output[0]).toBe(opener);
  expect(JSON.stringify(output[1])).toMatch(/RECAP_BODY[\s\S]*TIMELINE_BODY[\s\S]*LATEST_ACTION/);
  expect(JSON.stringify(output).match(/ORIGINAL_OPENER/g)).toHaveLength(1);
  expect(projectSceneMemory(output.slice(0, 1), '', null, [opener])).toEqual([opener]);
});

test('restoring the pinned head replaces a condensed copy without duplicating declarations', () => {
  const system: ReminderMessage = { role: 'system', content: 'SYSTEM' };
  const opener = { ...user('LONG ORIGINAL', 1), cacheReminderEntryId: 'entry:first:0' };
  const shortened = { ...opener, content: 'LONG' };
  expect(restorePinnedHead([system, shortened, user('NOW', 3)], [opener])).toEqual([system, opener, user('NOW', 3)]);
});

test('diagnostics attribute memory after the pinned opener without turning it into the conversation tail', () => {
  const opener = { ...user('OPENER_ONLY', 1), cacheReminderEntryId: 'entry:opener:0' };
  const latest = { ...user('LATEST_ONLY', 2), cacheReminderEntryId: 'entry:latest:0' };
  const input = {
    scene: [opener, latest],
    turnOrdinal: 2,
    requestOrdinal: 1,
    recap: { text: 'RECAP_BODY' },
    timeline: { text: 'TIMELINE_BODY' },
  };
  const report = captureRoleplayRequest({
    ...input,
    messages: projectSceneMemory([latest], 'RECAP_BODY', 'TIMELINE_BODY', [opener]),
  });
  expect(report.metadata.head?.sceneTurn).toBe(1);
  expect(report.metadata.tail?.sceneTurn).toBe(2);
  expect(report.content.sections.recap.source).toBe('request');
  expect(report.content.sections.timeline.source).toBe('request');
  expect(report.content.sections.tail.text).toBe('LATEST_ONLY');
  const seed = captureRoleplayRequest({
    ...input,
    scene: [opener],
    messages: projectSceneMemory([], 'RECAP_BODY', 'TIMELINE_BODY', [opener]),
  });
  expect(seed.metadata.tail?.sceneTurn).toBe(1);
  expect(seed.content.sections.tail.text).toBe('OPENER_ONLY');
});

test('coverage drops the summarized middle but tail boundaries ignore the pinned head', () => {
  const transcript = [user('OPENER', 1), user('MIDDLE', 2), user('NOW', 3)];
  const keys = pinnedKeys([transcript[0]]);
  const kept = dropCoveredMessages(transcript, transcript, 2, keys);
  expect(kept).toEqual([transcript[0], transcript[2]]);
  expect(retainedTranscriptStart(kept, transcript, keys)).toBe(2);
});

test('a soft prompt target reduces the tail while retaining a disjoint pinned opener', () => {
  const messages = [
    user('OPENER '.repeat(20), 1),
    ...Array.from({ length: 10 }, (_, i) => user('x'.repeat(800), i + 2)),
  ];
  const keys = pinnedKeys([messages[0]]);
  const out = limitReminderContext({
    messages,
    preview: (candidate) => candidate,
    windowTokens: 20000,
    promptTokenTarget: 1000,
    charsPerToken: 4,
    protectedKeys: keys,
  });
  expect(out.fits).toBe(true);
  expect(out.messages[0]).toBe(messages[0]);
  expect(out.messages.at(-1)).toBe(messages.at(-1));
  expect(out.messages.length).toBeLessThan(messages.length);
  expect(out.projectedChars / 4).toBeLessThanOrEqual(1000);
});

test('an impossible soft target does not turn a physically fitting protected input into an error', () => {
  const messages = [user('x'.repeat(8000), 1)];
  const out = limitReminderContext({
    messages,
    preview: (candidate) => candidate,
    windowTokens: 20000,
    promptTokenTarget: 1000,
    charsPerToken: 4,
  });
  expect(out.fits).toBe(true);
  expect(out.messages).toEqual(messages);
});
