import { expect, test } from 'vitest';
import type { ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { reminderMessageAnchor } from '../../../../../lib/node/pi/reminder-identity.ts';
import { DEFAULT_CONFIG, MIN_PROMPT_TOKEN_TARGET } from '../../../../../lib/node/pi/roleplay/config.ts';
import {
  ROLEPLAY_POLICY_ENTRY,
  effectiveRoleplayPolicy,
  planTokenTarget,
  preserveSceneOpener,
  readRoleplayPolicyOverrides,
  sceneOpenerKeys,
  sceneOpenerRange,
} from '../../../../../lib/node/pi/roleplay/retention-policy.ts';

function policy(data: unknown): Record<string, unknown> {
  return { type: 'custom', customType: ROLEPLAY_POLICY_ENTRY, data };
}

function message(role: string, id: string, extra: Partial<ReminderMessage> = {}): ReminderMessage {
  return { role, content: id, cacheReminderEntryId: id, ...extra };
}

function toolCall(id: string): ReminderMessage {
  return message('assistant', `call-${id}`, {
    content: [{ type: 'toolCall', id, name: 'read', arguments: {} }],
    stopReason: 'toolUse',
  });
}

const opener = message('user', 'opener');
const reply = message('assistant', 'reply', { stopReason: 'stop' });
const next = message('user', 'next');

test('branch policies restore newest valid fields for only the active scene and cast', () => {
  const branch = [
    policy({ cast: 'a', target: 8000, pin: true, includeReply: true }),
    policy({ cast: 'b', target: 9000, pin: true }),
    policy({ cast: 'a', target: 0, pin: false }),
    policy({ cast: 'a', target: Number.NaN, pin: 'yes', includeReply: false }),
  ];
  expect(readRoleplayPolicyOverrides(branch, 'a')).toEqual({ target: 0, pin: false, includeReply: false });
  expect(readRoleplayPolicyOverrides(branch, 'b')).toEqual({ target: 9000, pin: true });
  expect(readRoleplayPolicyOverrides(branch, 'c')).toEqual({});
  expect(readRoleplayPolicyOverrides([policy({ target: 5000 })], 'a')).toEqual({});
  expect(readRoleplayPolicyOverrides([policy({ target: 1 })])).toEqual({ target: MIN_PROMPT_TOKEN_TARGET });
  expect(readRoleplayPolicyOverrides([policy({ target: -1 })])).toEqual({ target: 0 });
});

test('newscene and cast-change boundaries shadow old policies, including when switching back', () => {
  for (const customType of ['roleplay-newscene', 'roleplay-cast-change']) {
    const old = policy({ cast: 'a', target: 8000, pin: true });
    const boundary = { type: 'custom', customType, data: { cast: 'b' } };
    expect(readRoleplayPolicyOverrides([old, boundary], 'a')).toEqual({});
    expect(readRoleplayPolicyOverrides([old, boundary, policy({ cast: 'a', includeReply: true })], 'a')).toEqual({
      includeReply: true,
    });
  }
  expect(
    readRoleplayPolicyOverrides([
      policy(null),
      policy([]),
      policy('invalid'),
      { type: 'message', customType: ROLEPLAY_POLICY_ENTRY, data: { target: 1 } },
    ]),
  ).toEqual({});
});

test('effective settings compose defaults, files, and explicit branch off values without mutation', () => {
  expect(effectiveRoleplayPolicy(DEFAULT_CONFIG)).toEqual({ target: 0, pin: false, includeReply: false });
  const config = Object.freeze({
    ...DEFAULT_CONFIG,
    promptTokenTarget: 10000,
    pinSceneOpener: true,
    pinSceneOpenerReply: true,
  });
  expect(effectiveRoleplayPolicy(config)).toEqual({ target: 10000, pin: true, includeReply: true });
  expect(effectiveRoleplayPolicy(config, { target: 0, pin: false })).toEqual({
    target: 0,
    pin: false,
    includeReply: false,
  });
  expect(effectiveRoleplayPolicy(config, { includeReply: false })).toEqual({
    target: 10000,
    pin: true,
    includeReply: false,
  });
  expect(config.promptTokenTarget).toBe(10000);
});

test('opener selection skips system, custom, startup and snapshot messages', () => {
  const prefix = [
    message('system', 'system'),
    message('custom', 'guide', { customType: 'startup-guide' }),
    message('user', 'startup', { startup: true }),
    message('user', 'projected-guide', { customType: 'startup-guide' }),
    message('user', 'snapshot', { cacheReminderSnapshot: true }),
    message('assistant', 'non-opening-assistant'),
  ];
  expect(sceneOpenerRange(prefix)).toBeNull();
  expect(sceneOpenerRange([...prefix, opener, reply, next])).toEqual({
    from: prefix.length,
    to: prefix.length + 1,
    anchor: 'opener',
  });
  expect(sceneOpenerRange([...prefix, opener, reply, next], true)).toEqual({
    from: prefix.length,
    to: prefix.length + 2,
    anchor: 'opener',
  });
  expect(sceneOpenerRange([])).toBeNull();
  expect(sceneOpenerRange([opener], true)?.to).toBe(1);
  expect(sceneOpenerRange([opener, next, reply], true)?.to).toBe(1);
  const plain = { role: 'user', content: 'untagged synthetic opening' };
  expect(sceneOpenerRange([plain])?.anchor).toBe(reminderMessageAnchor(plain));
});

test('reply selection includes complete parallel and sequential tool chains, stopping before next user', () => {
  const parallel = message('assistant', 'parallel', {
    content: [
      { type: 'toolCall', id: 'one' },
      { type: 'toolCall', id: 'two' },
    ],
  });
  const messages = [
    opener,
    parallel,
    message('toolResult', 'result-two', { toolCallId: 'two' }),
    message('toolResult', 'result-one', { toolCallId: 'one' }),
    toolCall('three'),
    message('toolResult', 'result-three', { toolCallId: 'three' }),
    reply,
    next,
    toolCall('later'),
  ];
  expect(sceneOpenerRange(messages, true)).toEqual({ from: 0, to: 7, anchor: 'opener' });
  expect(sceneOpenerRange([opener, reply], true)?.to).toBe(2);
});

test('unfinished, aborted and malformed tool exchanges never extend opener pinning', () => {
  const chains: ReminderMessage[][] = [
    [toolCall('one')],
    [toolCall('one'), message('toolResult', 'one-result', { toolCallId: 'one' })],
    [toolCall('one'), message('toolResult', 'foreign-result', { toolCallId: 'other' }), reply],
    [toolCall('one'), reply],
    [message('assistant', 'malformed', { content: [{ type: 'toolCall' }] }), reply],
    [message('assistant', 'aborted', { stopReason: 'aborted' })],
    [message('assistant', 'error', { stopReason: 'error' })],
    [reply, toolCall('unfinished'), next],
    [reply, toolCall('unfinished'), reply],
  ];
  for (const chain of chains) expect(sceneOpenerRange([opener, ...chain], true)?.to).toBe(1);
});

test('pinned keys and restoration preserve original opener bytes through drop and condensation', () => {
  const system = message('system', 'system');
  const original = Object.freeze([system, opener, reply, next]);
  expect(sceneOpenerKeys(original).has('opener')).toBe(true);
  expect(sceneOpenerKeys(original).has('reply')).toBe(false);
  expect(sceneOpenerKeys(original, true).has('reply')).toBe(true);
  expect(sceneOpenerKeys([]).size).toBe(0);
  expect(preserveSceneOpener(original, [system, next])).toEqual([system, opener, next]);
  expect(preserveSceneOpener(original, [system, next], true)).toEqual(original);
  const condensed = [{ ...opener, content: 'trimmed' }, { ...reply, content: 'trimmed reply' }, next];
  expect(preserveSceneOpener(original, condensed, true)).toEqual([opener, reply, next]);
  expect(condensed[0].content).toBe('trimmed');
  const none = [system, reply];
  expect(preserveSceneOpener(none, none)).toBe(none);
});

test('soft full-prompt token plan has explicit off, positive floor and bounded hysteresis', () => {
  for (const target of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(planTokenTarget(target)).toBeNull();
  expect(planTokenTarget(10000)).toEqual({ targetInputTokens: 10000, targetAfterHysteresis: 9000 });
  expect(planTokenTarget(1, 0)).toEqual({
    targetInputTokens: MIN_PROMPT_TOKEN_TARGET,
    targetAfterHysteresis: MIN_PROMPT_TOKEN_TARGET,
  });
  expect(planTokenTarget(8000.9, 0.25)).toEqual({ targetInputTokens: 8000, targetAfterHysteresis: 6000 });
  expect(planTokenTarget(10000, -1)?.targetAfterHysteresis).toBe(10000);
  expect(planTokenTarget(10000, 2)?.targetAfterHysteresis).toBe(5000);
  expect(planTokenTarget(10000, Number.NaN)?.targetAfterHysteresis).toBe(9000);
});
