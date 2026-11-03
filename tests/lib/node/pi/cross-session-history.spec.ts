/**
 * Tests for lib/node/pi/cross-session-history.ts.
 *
 * Pure module - no pi runtime needed; round-trips through a tmp dir for
 * the file-walking codepaths and uses the string-only `extractUserPromptsFromText`
 * helper for the JSONL parsing branches.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';

import {
  dedupKeepMostRecent,
  DEFAULT_MAX_PROMPT_LENGTH,
  extractUserPromptsFromFile,
  extractUserPromptsFromText,
  listSessionFilesNewestFirst,
  loadCrossSessionHistory,
  loadCrossSessionHistoryItems,
  userPromptFromEntry,
} from '../../../../lib/node/pi/cross-session-history.ts';

vi.mock('node:fs', { spy: true });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-xsh-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// userPromptFromEntry
// ──────────────────────────────────────────────────────────────────────

describe('userPromptFromEntry', () => {
  test('extracts string-content user message', () => {
    expect(userPromptFromEntry({ type: 'message', message: { role: 'user', content: 'hello' } })).toBe('hello');
  });

  test('extracts text blocks from array-content user message', () => {
    expect(
      userPromptFromEntry({
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'first line' },
            { type: 'text', text: 'second line' },
          ],
        },
      }),
    ).toBe('first line\nsecond line');
  });

  test('skips image blocks but keeps surrounding text', () => {
    expect(
      userPromptFromEntry({
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'image', data: '...', mimeType: 'image/png' },
            { type: 'text', text: 'caption' },
          ],
        },
      }),
    ).toBe('caption');
  });

  test('trims trailing whitespace', () => {
    expect(userPromptFromEntry({ type: 'message', message: { role: 'user', content: 'hi   \n\n' } })).toBe('hi');
  });

  test('returns undefined for assistant messages', () => {
    expect(
      userPromptFromEntry({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      }),
    ).toBeUndefined();
  });

  test('returns undefined for tool results, custom messages, and headers', () => {
    expect(userPromptFromEntry({ type: 'session', version: 3 })).toBeUndefined();
    expect(userPromptFromEntry({ type: 'model_change', provider: 'openai' })).toBeUndefined();
    expect(
      userPromptFromEntry({
        type: 'message',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'output' }] },
      }),
    ).toBeUndefined();
    expect(userPromptFromEntry({ type: 'custom', customType: 'x', data: {} })).toBeUndefined();
    expect(
      userPromptFromEntry({ type: 'custom_message', customType: 'x', content: 'reminder', display: true }),
    ).toBeUndefined();
  });

  test('returns undefined for malformed entries', () => {
    expect(userPromptFromEntry(null)).toBeUndefined();
    expect(userPromptFromEntry('string')).toBeUndefined();
    expect(userPromptFromEntry({ type: 'message' })).toBeUndefined();
    expect(userPromptFromEntry({ type: 'message', message: { role: 'user' } })).toBeUndefined();
    expect(userPromptFromEntry({ type: 'message', message: { role: 'user', content: [] } })).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// extractUserPromptsFromText
// ──────────────────────────────────────────────────────────────────────

describe('extractUserPromptsFromText', () => {
  test('returns prompts in document (chronological) order', () => {
    const jsonl = [
      JSON.stringify({ type: 'session', version: 3 }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'first' } }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'second' } }),
    ].join('\n');
    expect(extractUserPromptsFromText(jsonl, DEFAULT_MAX_PROMPT_LENGTH)).toEqual(['first', 'second']);
  });

  test('skips blank lines and JSON parse errors', () => {
    const jsonl = [
      '',
      'not-json',
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'kept' } }),
      '',
    ].join('\n');
    expect(extractUserPromptsFromText(jsonl, DEFAULT_MAX_PROMPT_LENGTH)).toEqual(['kept']);
  });

  test('drops prompts above the length cap and empty prompts', () => {
    const jsonl = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'short' } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(10) } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '   ' } }),
    ].join('\n');
    expect(extractUserPromptsFromText(jsonl, 5)).toEqual(['short']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// listSessionFilesNewestFirst
// ──────────────────────────────────────────────────────────────────────

describe('listSessionFilesNewestFirst', () => {
  test('returns [] for missing directory', () => {
    expect(listSessionFilesNewestFirst(join(dir, 'does-not-exist'))).toEqual([]);
  });

  test('only returns *.jsonl files, sorted newest mtime first', () => {
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    const c = join(dir, 'note.txt');
    writeFileSync(a, '{}');
    writeFileSync(b, '{}');
    writeFileSync(c, 'not a session');
    writeFileSync(join(dir, 'latest.cache-trace.jsonl'), '{"kind":"request"}\n');
    // Force b's mtime newer than a.
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(a, past, past);
    utimesSync(b, now, now);

    expect(listSessionFilesNewestFirst(dir)).toEqual([b, a]);
  });

  test('skips the excluded file', () => {
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    writeFileSync(a, '{}');
    writeFileSync(b, '{}');
    expect(listSessionFilesNewestFirst(dir, b)).toEqual([a]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadCrossSessionHistory
// ──────────────────────────────────────────────────────────────────────

describe('loadCrossSessionHistory', () => {
  function writeSession(name: string, prompts: string[], mtimeOffsetMs = 0): string {
    const file = join(dir, name);
    const lines = [
      JSON.stringify({ type: 'session', version: 3 }),
      ...prompts.map((p) =>
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: p }] },
        }),
      ),
    ];
    writeFileSync(file, lines.join('\n') + '\n');
    if (mtimeOffsetMs !== 0) {
      const t = new Date(Date.now() + mtimeOffsetMs);
      utimesSync(file, t, t);
    }
    return file;
  }

  test('returns chronological history across multiple session files', () => {
    // Older session first, newer session second.
    writeSession('old.jsonl', ['old-1', 'old-2'], -120_000);
    writeSession('new.jsonl', ['new-1', 'new-2'], -10_000);

    expect(loadCrossSessionHistory({ sessionDir: dir })).toEqual(['old-1', 'old-2', 'new-1', 'new-2']);
  });

  test('excludes the active session file', () => {
    writeSession('old.jsonl', ['old-1'], -120_000);
    const current = writeSession('current.jsonl', ['current-1'], -10_000);

    expect(loadCrossSessionHistory({ sessionDir: dir, excludeFile: current })).toEqual(['old-1']);
  });

  test('caps to maxPrompts, keeping the most recent', () => {
    writeSession('old.jsonl', ['old-1', 'old-2'], -120_000);
    writeSession('new.jsonl', ['new-1', 'new-2', 'new-3'], -10_000);

    // Cap of 3 keeps the 3 most recent (cross-file: oldest 2 prompts trimmed).
    expect(loadCrossSessionHistory({ sessionDir: dir, maxPrompts: 3 })).toEqual(['new-1', 'new-2', 'new-3']);
  });

  test('caps maxFiles to skip ancient sessions', () => {
    writeSession('ancient.jsonl', ['ancient-1'], -180_000);
    writeSession('old.jsonl', ['old-1'], -120_000);
    writeSession('new.jsonl', ['new-1'], -10_000);

    expect(loadCrossSessionHistory({ sessionDir: dir, maxFiles: 2 })).toEqual(['old-1', 'new-1']);
  });

  test('returns [] for missing directory', () => {
    expect(loadCrossSessionHistory({ sessionDir: join(dir, 'missing') })).toEqual([]);
  });

  test('returns [] when maxPrompts/maxFiles is 0', () => {
    writeSession('a.jsonl', ['a']);
    expect(loadCrossSessionHistory({ sessionDir: dir, maxPrompts: 0 })).toEqual([]);
    expect(loadCrossSessionHistory({ sessionDir: dir, maxFiles: 0 })).toEqual([]);
  });

  test('skips files larger than maxFileBytes', () => {
    writeSession('big.jsonl', ['a-line'], -10_000);
    writeSession('small.jsonl', ['small'], -5_000);
    // Set the size cap absurdly low so the (already small) big.jsonl gets skipped.
    expect(loadCrossSessionHistory({ sessionDir: dir, maxFileBytes: 50 })).toEqual([]);
  });

  test('loads prompts from sessions larger than 5MB, skipping oversized output lines', () => {
    const file = writeSession('large.jsonl', ['before output']);
    const output = JSON.stringify({
      type: 'message',
      message: { role: 'toolResult', content: 'x'.repeat(6 * 1024 * 1024) },
    });
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'before output' } }),
        output,
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'after output' } }),
      ].join('\n'),
    );
    expect(loadCrossSessionHistory({ sessionDir: dir })).toEqual(['before output', 'after output']);
  });

  test('reads UTF-8 prompts across scan-chunk boundaries and ignores an interrupted last line', () => {
    const first = JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello 🌏 世界' } });
    const second = JSON.stringify({ type: 'message', message: { role: 'user', content: 'latest' } });
    // Position the final byte of the emoji on a 64KiB boundary measured from EOF.
    const suffixBytes = Buffer.byteLength(first.slice(first.indexOf('🌏') + '🌏'.length) + '\n' + second + '\n');
    const padding = 'x'.repeat(64 * 1024 - suffixBytes - 1);
    writeFileSync(join(dir, 'split.jsonl'), first + '\n' + second + '\n' + padding);
    expect(loadCrossSessionHistory({ sessionDir: dir })).toEqual(['hello 🌏 世界', 'latest']);
  });

  test('keeps bounded recent prompts when scanning a large session', () => {
    writeFileSync(
      join(dir, 'many.jsonl'),
      Array.from({ length: 3000 }, (_, i) =>
        JSON.stringify({ type: 'message', message: { role: 'user', content: `${i}: ${'x'.repeat(2000)}` } }),
      ).join('\n') + '\n',
    );
    expect(loadCrossSessionHistory({ sessionDir: dir, maxPrompts: 2 })).toEqual([
      `2998: ${'x'.repeat(2000)}`,
      `2999: ${'x'.repeat(2000)}`,
    ]);
  });

  test('restores active-session prompts after replacing the editor on resume or reload', () => {
    writeSession('old.jsonl', ['prior session'], -120_000);
    const current = writeSession('current.jsonl', ['active first', 'active last'], -10_000);
    const currentEntries = ['active first', 'active last'].map((content) => ({
      type: 'message',
      message: { role: 'user', content },
    }));
    expect(loadCrossSessionHistory({ sessionDir: dir, excludeFile: current, currentEntries })).toEqual([
      'prior session',
      'active first',
      'active last',
    ]);
    expect(loadCrossSessionHistory({ sessionDir: dir, excludeFile: current, currentEntries, maxPrompts: 1 })).toEqual([
      'active last',
    ]);
  });

  test('restores in-memory active prompts without a persisted file and filters non-prompts', () => {
    const currentEntries = [
      { type: 'message', message: { role: 'user', content: 'submitted before abort' } },
      { type: 'message', message: { role: 'assistant', content: 'reply' } },
      { type: 'message', message: { role: 'user', content: ' ' } },
      { type: 'message', message: { role: 'user', content: 'x'.repeat(DEFAULT_MAX_PROMPT_LENGTH + 1) } },
    ];
    expect(loadCrossSessionHistory({ sessionDir: join(dir, 'missing'), currentEntries })).toEqual([
      'submitted before abort',
    ]);
    expect(loadCrossSessionHistory({ sessionDir: dir, currentEntries, maxFiles: 0 })).toEqual([
      'submitted before abort',
    ]);
  });

  test('drops malformed JSONL files without throwing', () => {
    writeFileSync(join(dir, 'broken.jsonl'), 'not-json\nstill-not-json\n');
    writeSession('good.jsonl', ['good-1'], 0);
    expect(loadCrossSessionHistory({ sessionDir: dir })).toEqual(['good-1']);
  });
});

describe('loadCrossSessionHistoryItems', () => {
  function user(content: unknown, timestamp?: unknown): unknown {
    return { type: 'message', timestamp, message: { role: 'user', content } };
  }

  function session(entries: unknown[], name = 'old.jsonl'): string {
    const file = join(dir, name);
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    return file;
  }

  test('keeps old and active opener flags, timestamps and absolute source paths', () => {
    const old = session([user('old opener', '2026-01-01'), user('old later', 123)]);
    const active = session([user('disk copy must be excluded')], 'active.jsonl');
    const currentEntries = [{ type: 'session' }, user('active opener', '2026-02-01'), user('active later')];
    const opts = { sessionDir: dir, excludeFile: active, currentEntries };
    expect(loadCrossSessionHistoryItems(opts)).toEqual([
      { prompt: 'old opener', isOpener: true, timestamp: '2026-01-01', sessionFile: old },
      { prompt: 'old later', isOpener: false, timestamp: undefined, sessionFile: old },
      { prompt: 'active opener', isOpener: true, timestamp: '2026-02-01', sessionFile: active },
      { prompt: 'active later', isOpener: false, timestamp: undefined, sessionFile: active },
    ]);
    expect(loadCrossSessionHistory(opts)).toEqual(loadCrossSessionHistoryItems(opts).map((item) => item.prompt));
    expect(loadCrossSessionHistoryItems({ ...opts, maxPrompts: 1 })).toEqual([
      { prompt: 'active later', isOpener: false, sessionFile: active, timestamp: undefined },
    ]);
  });

  test('does not use repeated prompt text as occurrence identity', () => {
    session([user('continue'), user('continue'), user('continue')]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir }).map((item) => item.isOpener)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test('finds the opener independently when the reverse cap stops far before it', () => {
    session([
      user('opener 🌏'),
      ...Array.from({ length: 100 }, () => ({ type: 'custom', data: 'x'.repeat(2000) })),
      user('latest'),
    ]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, maxPrompts: 1 })).toMatchObject([
      { prompt: 'latest', isOpener: false },
    ]);
  });

  test.each([
    ['long', 'x'.repeat(DEFAULT_MAX_PROMPT_LENGTH + 1)],
    ['image-only', [{ type: 'image', data: 'image', mimeType: 'image/png' }]],
    ['empty', '   '],
  ])('does not promote a later disk or active prompt after a %s first user', (_name, content) => {
    const entries = [user(content), user('later')];
    session(entries);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir })).toMatchObject([{ prompt: 'later', isOpener: false }]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, currentEntries: entries, maxFiles: 0 })).toMatchObject([
      { prompt: 'later', isOpener: false },
    ]);
  });

  test('uses the configured length cap without redefining the first user', () => {
    session([user('long opener'), user('ok')]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, maxPromptLength: 2 })).toMatchObject([
      { prompt: 'ok', isOpener: false },
    ]);
  });

  test.each(['user', 'toolResult'])('keeps unknown opener status after an oversized %s prefix', (role) => {
    const file = session([
      { type: 'message', message: { role, content: 'x'.repeat(6 * 1024 * 1024) } },
      user('retained', 'timestamp'),
    ]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir })).toEqual([
      { prompt: 'retained', isOpener: undefined, timestamp: 'timestamp', sessionFile: file },
    ]);
    expect(extractUserPromptsFromFile(file, { maxPromptLength: 4000 })).toEqual(['retained']);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, maxFileBytes: 1024 })).toEqual([]);
  });

  test('bounds the forward probe to 5MiB and all reads to 64KiB', () => {
    session([
      ...Array.from({ length: 100 }, () => ({ type: 'custom', data: 'x'.repeat(64 * 1024) })),
      user('late opener'),
    ]);
    const read = vi.spyOn(fs, 'readSync');
    try {
      expect(loadCrossSessionHistoryItems({ sessionDir: dir, maxPrompts: 1 })[0]?.isOpener).toBeUndefined();
      // readSync's last overload uses an options object; runtime calls here
      // deliberately use its positional overload instead.
      const calls: readonly (readonly unknown[])[] = read.mock.calls;
      expect(calls.every((call) => typeof call[3] === 'number' && call[3] <= 64 * 1024)).toBe(true);
      // 80 forward chunks, then one reverse chunk containing the last prompt.
      expect(calls).toHaveLength(81);
      expect(calls[79]?.[4]).toBe(5 * 1024 * 1024 - 64 * 1024);
    } finally {
      read.mockRestore();
    }
  });

  test('keeps unknown status after an unparseable prefix instead of promoting a later user', () => {
    const file = join(dir, 'broken-prefix.jsonl');
    writeFileSync(file, 'not-json\n' + JSON.stringify(user('later')));
    expect(loadCrossSessionHistoryItems({ sessionDir: dir })[0]?.isOpener).toBeUndefined();
  });

  test('handles UTF-8 byte offsets, a multi-chunk prefix, and an unterminated opener', () => {
    session([{ type: 'custom', data: '🌏'.repeat(20_000) }, user('continue'), user('continue')]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir }).map((item) => item.isOpener)).toEqual([true, false]);
    writeFileSync(join(dir, 'old.jsonl'), JSON.stringify(user('no newline')));
    expect(loadCrossSessionHistoryItems({ sessionDir: dir })[0]?.isOpener).toBe(true);
  });

  test('preserves pool/file caps, bucket isolation and cache trace exclusion', () => {
    const old = session([user('old')]);
    const recent = session([user('new opener'), user('new later')], 'new.jsonl');
    utimesSync(old, new Date(0), new Date(0));
    utimesSync(recent, new Date(10_000), new Date(10_000));
    session([user('sidecar')], 'latest.cache-trace.jsonl');
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, maxPrompts: 1 })).toMatchObject([
      { prompt: 'new later', isOpener: false },
    ]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, maxFiles: 1 }).map((item) => item.prompt)).toEqual([
      'new opener',
      'new later',
    ]);
    expect(loadCrossSessionHistoryItems({ sessionDir: join(dir, 'other-project') })).toEqual([]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, maxPrompts: 0 })).toEqual([]);
    expect(loadCrossSessionHistoryItems({ sessionDir: dir, currentEntries: [user('in memory')], maxFiles: 0 })).toEqual(
      [{ prompt: 'in memory', isOpener: true, timestamp: undefined, sessionFile: undefined }],
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// dedupKeepMostRecent
// ──────────────────────────────────────────────────────────────────────

describe('dedupKeepMostRecent', () => {
  test('reverses chronological list and drops duplicates, keeping most-recent', () => {
    expect(dedupKeepMostRecent(['a', 'b', 'a', 'c'])).toEqual(['c', 'a', 'b']);
  });

  test('preserves single-occurrence order (most-recent first)', () => {
    expect(dedupKeepMostRecent(['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
  });

  test('handles empty input', () => {
    expect(dedupKeepMostRecent([])).toEqual([]);
  });

  test('all duplicates collapse to one entry', () => {
    expect(dedupKeepMostRecent(['x', 'x', 'x'])).toEqual(['x']);
  });
});
