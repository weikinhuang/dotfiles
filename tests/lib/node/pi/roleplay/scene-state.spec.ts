import { expect, test } from 'vitest';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import {
  canSeedScene,
  CAST_CHANGE_TYPE,
  createSceneBoundary,
  NEW_SCENE_TYPE,
  recordedCast,
  restoreCastOverride,
  sceneMessages,
} from '../../../../../lib/node/pi/roleplay/scene-state.ts';

function message(role: string, content: string, id: string): ReminderMessage {
  return { role, content, cacheReminderEntryId: `entry:${id}:0` };
}
function boundary(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { type: 'custom', customType: type, data };
}
const head = message('system', 'system', 'system');
const a = message('user', 'old scene', 'a');
const reply = message('assistant', 'old reply', 'reply');
const b = message('user', 'new scene', 'b');
const entries: Record<string, unknown>[] = [
  { type: 'message', id: 'a', message: a },
  { type: 'message', id: 'reply', message: reply },
  { type: 'message', id: 'b', message: b },
];

test('scene-state: initiating input preceding the cast marker remains in context', () => {
  const data = createSceneBoundary('b', entries, [a, reply], { messageType: 'user' }, null);
  expect(data.fromEntryId).toBe('b');
  expect(sceneMessages([head, a, reply, b], [...entries, boundary(CAST_CHANGE_TYPE, { ...data })])).toEqual([head, b]);
});
test('scene-state: command boundary excludes all previously persisted messages', () => {
  const data = createSceneBoundary('a', entries.slice(0, 2), [a, reply]);
  expect(data.afterEntryId).toBe('reply');
  expect(
    sceneMessages([head, a, reply, b], [...entries.slice(0, 2), boundary(NEW_SCENE_TYPE, { ...data }), entries[2]]),
  ).toEqual([head, b]);
});
test('scene-state: in-memory callers fall back to complete-turn boundaries', () => {
  const data = createSceneBoundary('a', [], [a]);
  expect(sceneMessages([head, a, reply, b], [boundary(NEW_SCENE_TYPE, { ...data })])).toEqual([head, b]);
  expect(sceneMessages([head, a, reply], [boundary(NEW_SCENE_TYPE, { ...data })])).toEqual([head]);
});
test('scene-state: scheduled inputs can initiate a new cast', () => {
  const scheduled = { type: 'custom_message', id: 'tick', customType: 'scheduled-prompt' };
  const data = createSceneBoundary('b', [scheduled], [a], { messageType: 'custom', customType: 'scheduled-prompt' });
  const tick = { ...message('custom', 'continue', 'tick'), customType: 'scheduled-prompt' };
  expect(sceneMessages([head, a, tick], [entries[0], scheduled, boundary(CAST_CHANGE_TYPE, { ...data })])).toEqual([
    head,
    tick,
  ]);
});
test('scene-state: legacy newscene markers still reject pre-marker persisted history', () => {
  const marker = boundary(NEW_SCENE_TYPE, { ts: 'legacy' });
  expect(sceneMessages([head, a, b], [entries[0], marker, entries[2]])).toEqual([head, b]);
});
test('scene-state: removed anchors do not re-admit older persisted messages', () => {
  const marker = boundary(NEW_SCENE_TYPE, { afterEntryId: 'reply' });
  expect(sceneMessages([head, a, b], [...entries.slice(0, 2), marker, entries[2]])).toEqual([head, b]);
});
test('scene-state: reset markers block carry-over seeds, cast switches permit them', () => {
  expect(canSeedScene([])).toBe(true);
  expect(canSeedScene([boundary(NEW_SCENE_TYPE, {})])).toBe(false);
  expect(canSeedScene([boundary(NEW_SCENE_TYPE, {}), boundary(CAST_CHANGE_TYPE, { cast: 'b' })])).toBe(true);
});
test('scene-state: recorded cast and explicit overrides are branch-scoped', () => {
  expect(
    recordedCast([
      boundary('roleplay-context-recap', { cast: 'a' }),
      boundary(CAST_CHANGE_TYPE, { cast: 'b', override: 'b' }),
    ]),
  ).toBe('b');
  expect(
    restoreCastOverride([
      boundary(CAST_CHANGE_TYPE, { cast: 'b', override: 'b' }),
      boundary(NEW_SCENE_TYPE, { cast: 'b' }),
    ]),
  ).toBe('b');
  expect(
    restoreCastOverride([
      boundary(CAST_CHANGE_TYPE, { override: 'b' }),
      boundary(CAST_CHANGE_TYPE, { override: null }),
    ]),
  ).toBeNull();
  expect(recordedCast([])).toBeNull();
});
test('scene-state: without a boundary messages remain untouched', () => {
  expect(sceneMessages([head, a, reply, b], entries)).toEqual([head, a, reply, b]);
});
