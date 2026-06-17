/**
 * Tests for lib/node/pi/notify/desktop.ts.
 */

import { expect, test } from 'vitest';

import {
  buildNotification,
  buildToolNotification,
  DEFAULT_COMMAND,
  DEFAULT_MIN_SECONDS,
  DEFAULT_TITLE_PREFIX,
  firstLine,
  resolveNotifyConfig,
  shouldNotify,
  summarizeTurn,
  type TurnSummary,
} from '../../../../../lib/node/pi/notify/desktop.ts';

// ──────────────────────────────────────────────────────────────────────
// resolveNotifyConfig
// ──────────────────────────────────────────────────────────────────────

test('resolveNotifyConfig: defaults when env is empty', () => {
  const config = resolveNotifyConfig({});
  expect(config).toEqual({
    disabled: false,
    toolDisabled: false,
    minSeconds: DEFAULT_MIN_SECONDS,
    command: DEFAULT_COMMAND,
    titlePrefix: DEFAULT_TITLE_PREFIX,
    verbose: false,
    trace: undefined,
  });
});

test('resolveNotifyConfig: honors overrides', () => {
  const config = resolveNotifyConfig({
    PI_NOTIFY_DISABLED: '1',
    PI_NOTIFY_TOOL_DISABLED: '1',
    PI_NOTIFY_MIN_SECONDS: '5',
    PI_NOTIFY_COMMAND: 'my-notifier',
    PI_NOTIFY_TITLE_PREFIX: 'work',
    PI_NOTIFY_VERBOSE: 'true',
    PI_NOTIFY_TRACE: '/tmp/notify.log',
  });
  expect(config).toEqual({
    disabled: true,
    toolDisabled: true,
    minSeconds: 5,
    command: 'my-notifier',
    titlePrefix: 'work',
    verbose: true,
    trace: '/tmp/notify.log',
  });
});

test('resolveNotifyConfig: tool can be disabled independently of lifecycle', () => {
  const config = resolveNotifyConfig({ PI_NOTIFY_TOOL_DISABLED: '1' });
  expect(config.disabled).toBe(false);
  expect(config.toolDisabled).toBe(true);
});

test('resolveNotifyConfig: blank string overrides fall back to defaults', () => {
  const config = resolveNotifyConfig({ PI_NOTIFY_COMMAND: '  ', PI_NOTIFY_TITLE_PREFIX: '', PI_NOTIFY_TRACE: '   ' });
  expect(config.command).toBe(DEFAULT_COMMAND);
  expect(config.titlePrefix).toBe(DEFAULT_TITLE_PREFIX);
  expect(config.trace).toBeUndefined();
});

test('resolveNotifyConfig: invalid min seconds falls back, zero is allowed', () => {
  expect(resolveNotifyConfig({ PI_NOTIFY_MIN_SECONDS: 'abc' }).minSeconds).toBe(DEFAULT_MIN_SECONDS);
  expect(resolveNotifyConfig({ PI_NOTIFY_MIN_SECONDS: '0' }).minSeconds).toBe(0);
});

// ──────────────────────────────────────────────────────────────────────
// summarizeTurn
// ──────────────────────────────────────────────────────────────────────

test('summarizeTurn: empty / no assistant message', () => {
  expect(summarizeTurn([])).toEqual({ text: '', errored: false });
  expect(summarizeTurn([{ role: 'user', content: 'hi' }])).toEqual({ text: '', errored: false });
});

test('summarizeTurn: extracts text from the last assistant message', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'first' }], stopReason: 'stop' },
    { role: 'user', content: 'more' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: 'all done' },
        { type: 'toolCall', name: 'bash' },
      ],
      stopReason: 'stop',
    },
  ];
  const summary = summarizeTurn(messages);
  expect(summary.text).toBe('all done');
  expect(summary.errored).toBe(false);
  expect(summary.stopReason).toBe('stop');
});

test('summarizeTurn: joins multiple text blocks with newlines', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      stopReason: 'stop',
    },
  ];
  expect(summarizeTurn(messages).text).toBe('line one\nline two');
});

test('summarizeTurn: supports plain string content', () => {
  expect(summarizeTurn([{ role: 'assistant', content: 'plain text', stopReason: 'stop' }]).text).toBe('plain text');
});

test('summarizeTurn: marks error and aborted stop reasons', () => {
  const errored = summarizeTurn([{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' }]);
  expect(errored).toEqual({ text: '', errored: true, stopReason: 'error', errorMessage: 'boom' });

  const aborted = summarizeTurn([{ role: 'assistant', content: [], stopReason: 'aborted' }]);
  expect(aborted.errored).toBe(true);
  expect(aborted.stopReason).toBe('aborted');
});

test('summarizeTurn: ignores non-object entries', () => {
  expect(summarizeTurn([null, undefined, 'str', 42]).errored).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// shouldNotify
// ──────────────────────────────────────────────────────────────────────

test('shouldNotify: errored turns always notify regardless of duration', () => {
  expect(shouldNotify({ elapsedMs: 0, minSeconds: 30, errored: true })).toBe(true);
});

test('shouldNotify: success notifies only past the threshold', () => {
  expect(shouldNotify({ elapsedMs: 29_999, minSeconds: 30, errored: false })).toBe(false);
  expect(shouldNotify({ elapsedMs: 30_000, minSeconds: 30, errored: false })).toBe(true);
  expect(shouldNotify({ elapsedMs: 45_000, minSeconds: 30, errored: false })).toBe(true);
});

test('shouldNotify: zero threshold notifies on every successful turn', () => {
  expect(shouldNotify({ elapsedMs: 0, minSeconds: 0, errored: false })).toBe(true);
});

// ──────────────────────────────────────────────────────────────────────
// firstLine
// ──────────────────────────────────────────────────────────────────────

test('firstLine: collapses whitespace and newlines', () => {
  expect(firstLine('  hello\n  world  \t there ')).toBe('hello world there');
});

test('firstLine: truncates with an ellipsis past maxLen', () => {
  expect(firstLine('abcdefghij', 5)).toBe('abcd…');
  expect(firstLine('abcde', 5)).toBe('abcde');
});

// ──────────────────────────────────────────────────────────────────────
// buildNotification
// ──────────────────────────────────────────────────────────────────────

const ok: TurnSummary = { text: 'tests pass', errored: false, stopReason: 'stop' };

test('buildNotification: title is prefix + project basename', () => {
  expect(buildNotification({ summary: ok, cwd: '/home/me/source/dotfiles', titlePrefix: 'pi' }).title).toBe(
    'pi · dotfiles',
  );
});

test('buildNotification: success body is the reply snippet', () => {
  expect(buildNotification({ summary: ok, cwd: '/x/proj', titlePrefix: 'pi' }).body).toBe('tests pass');
});

test('buildNotification: success body falls back when reply is empty', () => {
  const empty: TurnSummary = { text: '', errored: false };
  expect(buildNotification({ summary: empty, cwd: '/x/proj', titlePrefix: 'pi' }).body).toBe(
    'Turn complete - awaiting your input',
  );
});

test('buildNotification: error body uses the failure label and detail', () => {
  const failed: TurnSummary = { text: '', errored: true, stopReason: 'error', errorMessage: 'rate limited' };
  expect(buildNotification({ summary: failed, cwd: '/x/proj', titlePrefix: 'pi' }).body).toBe(
    'Turn failed: rate limited',
  );
});

test('buildNotification: aborted body uses the abort label', () => {
  const aborted: TurnSummary = { text: '', errored: true, stopReason: 'aborted' };
  expect(buildNotification({ summary: aborted, cwd: '/x/proj', titlePrefix: 'pi' }).body).toBe('Turn aborted');
});

// ──────────────────────────────────────────────────────────────────────
// buildToolNotification
// ──────────────────────────────────────────────────────────────────────

test('buildToolNotification: defaults heading to the project basename', () => {
  expect(buildToolNotification({ message: 'need a decision', cwd: '/home/me/dotfiles', titlePrefix: 'pi' })).toEqual({
    title: 'pi · dotfiles',
    body: 'need a decision',
  });
});

test('buildToolNotification: uses the supplied title as the heading', () => {
  expect(buildToolNotification({ message: 'build done', title: 'CI', cwd: '/x/proj', titlePrefix: 'pi' }).title).toBe(
    'pi · CI',
  );
});

test('buildToolNotification: blank title falls back to the project', () => {
  expect(buildToolNotification({ message: 'hi', title: '   ', cwd: '/x/proj', titlePrefix: 'pi' }).title).toBe(
    'pi · proj',
  );
});

test('buildToolNotification: collapses and truncates the body', () => {
  const long = 'x'.repeat(200);
  const { body } = buildToolNotification({ message: `  a\n  b  ${long}`, cwd: '/x/proj', titlePrefix: 'pi' });
  expect(body.startsWith('a b ')).toBe(true);
  expect(body.endsWith('…')).toBe(true);
  expect(body.length).toBeLessThanOrEqual(140);
});
