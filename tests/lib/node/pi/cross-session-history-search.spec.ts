import { describe, expect, test } from 'vitest';

import {
  dedupHistoryEntries,
  isContinuationPrompt,
  searchHistoryEntries,
} from '../../../../lib/node/pi/cross-session-history-search.ts';
import type { PromptHistoryEntry } from '../../../../lib/node/pi/cross-session-history.ts';

function entry(prompt: string, isOpener: boolean | undefined = false): PromptHistoryEntry {
  return { prompt, isOpener };
}

describe('history search', () => {
  test('matches later lines and exposes the matching line and highlight indices', () => {
    const prompt = 'fix the regression\nlook in database.ts\nkeep the API stable';
    const result = searchHistoryEntries([entry(prompt)], 'database');
    expect(result.items[0]?.entry.prompt).toBe(prompt);
    expect(result.items[0]?.snippet).toEqual({
      text: 'look in database.ts',
      indices: [8, 9, 10, 11, 12, 13, 14, 15],
      lineNumber: 2,
    });
  });

  test('prefers a strong later-line match over a scattered earlier-line match', () => {
    const prompt = 'ORIGINAL_SESSION_TASK build a safe history browser\nDEEP_MATCH_needle only appears on line two';
    const result = searchHistoryEntries([entry(prompt)], 'DEEP_MATCH');
    expect(result.items[0]?.snippet.lineNumber).toBe(2);
    expect(result.items[0]?.snippet.text).toBe('DEEP_MATCH_needle only appears on line two');
  });

  test('matches across line boundaries without modifying the accepted prompt', () => {
    const prompt = 'alpha\nbeta';
    const result = searchHistoryEntries([entry(prompt)], 'ab');
    expect(result.items[0]?.indices).toEqual([0, 6]);
    expect(result.items[0]?.entry.prompt).toBe(prompt);
    expect(result.items[0]?.snippet.text).toBe('alpha');
  });

  test('empty queries retain recency and exact-score ties stay stable', () => {
    const items = [entry('bbb exact'), entry('ddd exact')];
    expect(searchHistoryEntries(items, '').items.map((item) => item.entry.prompt)).toEqual(['bbb exact', 'ddd exact']);
    expect(searchHistoryEntries(items, 'exact').items.map((item) => item.entry.prompt)).toEqual([
      'bbb exact',
      'ddd exact',
    ]);
  });

  test('handles leading blank lines and empty matches', () => {
    expect(searchHistoryEntries([entry('\nsecond')], '').items[0]?.snippet).toEqual({
      text: '',
      indices: [],
      lineNumber: 1,
    });
    expect(searchHistoryEntries([entry('first')], 'unfindable').items).toEqual([]);
  });
});

describe('continuation filtering', () => {
  test.each(['continue', ' Please continue. ', 'PLEASE\nCONTINUE!', 'go on', 'keep going…', 'proceed', 'carry on'])(
    '%s is context-only',
    (prompt) => {
      expect(isContinuationPrompt(prompt)).toBe(true);
    },
  );

  test.each([
    'yes',
    'ok',
    'stop',
    'please continue with the tests',
    'continue debugging',
    'how does continue work?',
    'continue\nfix parsing',
  ])('%s stays substantive', (prompt) => {
    expect(isContinuationPrompt(prompt)).toBe(false);
  });

  test('hides only known non-opener continuations, with a reversible toggle', () => {
    const entries = [entry('please continue'), entry('continue', true), { prompt: 'go on' }, entry('yes')];
    const filtered = searchHistoryEntries(entries, '');
    expect(filtered.items.map((item) => item.entry.prompt)).toEqual(['continue', 'go on', 'yes']);
    expect(filtered.hiddenCount).toBe(1);
    expect(searchHistoryEntries(entries, '', true).items.map((item) => item.entry.prompt)).toEqual([
      'please continue',
      'continue',
      'go on',
      'yes',
    ]);
    expect(entries).toHaveLength(4);
  });
});

describe('metadata deduplication', () => {
  test('keeps newest metadata and preserves an older opener indication', () => {
    const entries = [
      { ...entry('same', true), sessionFile: 'old.jsonl', timestamp: '2026-01-01' },
      entry('other'),
      { ...entry('same'), sessionFile: 'new.jsonl', timestamp: '2026-02-01' },
    ];
    expect(dedupHistoryEntries(entries)).toEqual([
      { ...entry('same', true), sessionFile: 'new.jsonl', timestamp: '2026-02-01' },
      entry('other'),
    ]);
    expect(entries[2]?.isOpener).toBe(false);
  });

  test('unknown occurrence prevents hiding a potentially opening continuation', () => {
    const deduped = dedupHistoryEntries([{ prompt: 'continue' }, entry('continue')]);
    expect(deduped[0]?.isOpener).toBeUndefined();
    expect(searchHistoryEntries(deduped, '').items).toHaveLength(1);
  });
});
