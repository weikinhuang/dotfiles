/**
 * Tests for lib/node/opencode/notify.ts.
 */

import { expect, test } from 'vitest';

import {
  buildNotifyToolCall,
  createTurnTracker,
  decideTurnNotification,
  OPENCODE_DEFAULT_TITLE_PREFIX,
  resolveOpencodeNotifyConfig,
  summarizeOutcome,
  type TurnDecisionInput,
  type TurnState,
} from '../../../../lib/node/opencode/notify.ts';
import { DEFAULT_COMMAND, DEFAULT_MIN_SECONDS } from '../../../../lib/node/pi/notify/desktop.ts';

// ──────────────────────────────────────────────────────────────────────
// resolveOpencodeNotifyConfig
// ──────────────────────────────────────────────────────────────────────

test('resolveOpencodeNotifyConfig: defaults', () => {
  expect(resolveOpencodeNotifyConfig(undefined, {})).toEqual({
    enabled: true,
    tool: true,
    lifecycle: true,
    minSeconds: DEFAULT_MIN_SECONDS,
    command: DEFAULT_COMMAND,
    titlePrefix: OPENCODE_DEFAULT_TITLE_PREFIX,
    trace: undefined,
  });
});

test('resolveOpencodeNotifyConfig: plugin options apply', () => {
  const config = resolveOpencodeNotifyConfig(
    { lifecycle: false, minSeconds: 5, command: 'my-toast', titlePrefix: 'oc', trace: '/tmp/t.log' },
    {},
  );
  expect(config).toMatchObject({
    lifecycle: false,
    minSeconds: 5,
    command: 'my-toast',
    titlePrefix: 'oc',
    trace: '/tmp/t.log',
  });
});

test('resolveOpencodeNotifyConfig: OPENCODE_NOTIFY_* env overrides options', () => {
  const config = resolveOpencodeNotifyConfig(
    { lifecycle: false, minSeconds: 5 },
    { OPENCODE_NOTIFY_LIFECYCLE: '1', OPENCODE_NOTIFY_MIN_SECONDS: '0', OPENCODE_NOTIFY_ENABLED: 'off' },
  );
  expect(config.lifecycle).toBe(true);
  expect(config.minSeconds).toBe(0);
  expect(config.enabled).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// createTurnTracker
// ──────────────────────────────────────────────────────────────────────

test('createTurnTracker: captures start time, last non-empty text, and tool flag', () => {
  const tracker = createTurnTracker();
  tracker.start('s', 1000);
  tracker.text('s', 'first');
  tracker.text('s', '   ');
  tracker.text('s', 'second');
  tracker.markToolFired('s');
  expect(tracker.finish('s')).toEqual({
    duplicate: false,
    state: { startedAt: 1000, toolFired: true, lastText: 'second', ended: true },
  });
});

test('createTurnTracker: repeated terminal events for one turn are duplicates', () => {
  const tracker = createTurnTracker();
  tracker.start('s', 1);
  expect(tracker.finish('s').duplicate).toBe(false);
  expect(tracker.finish('s').duplicate).toBe(true);
  tracker.start('s', 2);
  expect(tracker.finish('s').duplicate).toBe(false);
});

test('createTurnTracker: a turn seen only at its end has no start time', () => {
  const tracker = createTurnTracker();
  const result = tracker.finish('late');
  expect(result).toEqual({
    duplicate: false,
    state: { startedAt: undefined, toolFired: false, lastText: '', ended: true },
  });
});

test('createTurnTracker: activity after a finished turn opens a fresh state', () => {
  const tracker = createTurnTracker();
  tracker.start('s', 1);
  tracker.markToolFired('s');
  tracker.finish('s');
  tracker.text('s', 'next');
  const result = tracker.finish('s');
  expect(result).toEqual({
    duplicate: false,
    state: { startedAt: undefined, toolFired: false, lastText: 'next', ended: true },
  });
});

test('createTurnTracker: forget drops the session', () => {
  const tracker = createTurnTracker();
  tracker.start('s', 1);
  expect(tracker.size()).toBe(1);
  tracker.forget('s');
  expect(tracker.size()).toBe(0);
});

// ──────────────────────────────────────────────────────────────────────
// summarizeOutcome / decideTurnNotification
// ──────────────────────────────────────────────────────────────────────

test('summarizeOutcome: maps failures and interrupts onto the shared summary', () => {
  expect(summarizeOutcome({ kind: 'succeeded' }, 'done')).toEqual({ text: 'done', errored: false });
  expect(summarizeOutcome({ kind: 'failed', message: 'rate limited' }, '')).toEqual({
    text: '',
    errored: true,
    stopReason: 'error',
    errorMessage: 'rate limited',
  });
  expect(summarizeOutcome({ kind: 'failed', message: '' }, 'x').errorMessage).toBeUndefined();
  expect(summarizeOutcome({ kind: 'interrupted', reason: 'user' }, 'x')).toEqual({
    text: 'x',
    errored: true,
    stopReason: 'aborted',
  });
});

function state(over: Partial<TurnState> = {}): TurnState {
  return { startedAt: 0, toolFired: false, lastText: 'All tests pass.', ended: true, ...over };
}

function decide(over: Partial<TurnDecisionInput> = {}): ReturnType<typeof decideTurnNotification> {
  return decideTurnNotification({
    state: state(),
    outcome: { kind: 'succeeded' },
    isRoot: true,
    now: 45_000,
    minSeconds: 30,
    cwd: '/work/dotfiles',
    titlePrefix: 'opencode',
    ...over,
  });
}

test('decideTurnNotification: long successful root turn notifies with the reply snippet', () => {
  expect(decide()).toEqual({
    notify: true,
    elapsedMs: 45_000,
    title: 'opencode · dotfiles',
    body: 'All tests pass.',
  });
});

test('decideTurnNotification: short successful turn is skipped', () => {
  expect(decide({ now: 5_000 })).toEqual({ notify: false, elapsedMs: 5_000, reason: 'short-turn' });
});

test('decideTurnNotification: errors and user aborts notify regardless of duration', () => {
  expect(decide({ now: 10, outcome: { kind: 'failed', message: 'quota' } })).toMatchObject({
    notify: true,
    body: 'Turn failed: quota',
  });
  expect(decide({ now: 10, outcome: { kind: 'interrupted', reason: 'user' } })).toMatchObject({
    notify: true,
    body: 'Turn aborted: All tests pass.',
  });
});

test('decideTurnNotification: shutdown and superseded interrupts stay silent', () => {
  expect(decide({ outcome: { kind: 'interrupted', reason: 'shutdown' } })).toMatchObject({
    notify: false,
    reason: 'interrupted-shutdown',
  });
  expect(decide({ outcome: { kind: 'interrupted', reason: 'superseded' } })).toMatchObject({
    notify: false,
    reason: 'interrupted-superseded',
  });
});

test('decideTurnNotification: child sessions never notify, even on error', () => {
  expect(decide({ isRoot: false, outcome: { kind: 'failed', message: 'x' } })).toMatchObject({
    notify: false,
    reason: 'child-session',
  });
});

test('decideTurnNotification: tool already fired suppresses the lifecycle ping', () => {
  expect(decide({ state: state({ toolFired: true }) })).toMatchObject({ notify: false, reason: 'tool-fired' });
});

test('decideTurnNotification: unknown start time counts as zero elapsed', () => {
  expect(decide({ state: state({ startedAt: undefined }) })).toMatchObject({
    notify: false,
    elapsedMs: 0,
    reason: 'short-turn',
  });
  expect(decide({ state: state({ startedAt: undefined }), minSeconds: 0 })).toMatchObject({ notify: true });
});

// ──────────────────────────────────────────────────────────────────────
// buildNotifyToolCall
// ──────────────────────────────────────────────────────────────────────

test('buildNotifyToolCall: builds content from message and optional title', () => {
  expect(buildNotifyToolCall({ message: '  Need a decision  ' }, '/work/dotfiles', 'opencode')).toEqual({
    ok: true,
    content: { title: 'opencode · dotfiles', body: 'Need a decision' },
  });
  expect(buildNotifyToolCall({ message: 'Done', title: 'Deploy' }, '/work/dotfiles', 'oc')).toEqual({
    ok: true,
    content: { title: 'oc · Deploy', body: 'Done' },
  });
});

test('buildNotifyToolCall: rejects empty or malformed input', () => {
  expect(buildNotifyToolCall({ message: '   ' }, '/w', 'oc')).toEqual({
    ok: false,
    error: 'message must not be empty',
  });
  expect(buildNotifyToolCall(null, '/w', 'oc').ok).toBe(false);
  expect(buildNotifyToolCall({ message: 42 }, '/w', 'oc').ok).toBe(false);
});
