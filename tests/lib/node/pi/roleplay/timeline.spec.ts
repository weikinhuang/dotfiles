/**
 * Tests for lib/node/pi/roleplay/timeline.ts.
 */

import { expect, test } from 'vitest';

import {
  appendBeatBody,
  buildTimelineExtractionTask,
  capBeatLog,
  DEFAULT_TIMELINE_GUIDANCE,
  dedupeNewBeats,
  formatBeatLine,
  formatBeatLines,
  MAX_BEATS_PER_ROLL,
  MAX_BEAT_CHARS,
  normalizeBeatLine,
  parseBeatLog,
  parseTimelineBeats,
  renderTimelineBlock,
  splitBeatLogHalves,
} from '../../../../../lib/node/pi/roleplay/timeline.ts';

test('buildTimelineExtractionTask embeds the span and the JSON contract', () => {
  const task = buildTimelineExtractionTask('user: we meet Thursday');
  expect(task).toContain('user: we meet Thursday');
  expect(task).toContain('JSON array');
  expect(task).toContain('chronological');
});

test('buildTimelineExtractionTask uses the default guidance when none is given', () => {
  const task = buildTimelineExtractionTask('user: hi');
  expect(task).toContain(DEFAULT_TIMELINE_GUIDANCE);
});

test('buildTimelineExtractionTask substitutes a non-empty guidance override', () => {
  const task = buildTimelineExtractionTask('user: hi', 'ONLY extract combat and travel beats.');
  expect(task).toContain('ONLY extract combat and travel beats.');
  expect(task).not.toContain(DEFAULT_TIMELINE_GUIDANCE);
  // Contract + caps + span stay builder-owned regardless of the override.
  expect(task).toContain('JSON array');
  expect(task).toContain('return exactly []');
  expect(task).toContain(String(MAX_BEATS_PER_ROLL));
  expect(task).toContain(String(MAX_BEAT_CHARS));
  expect(task).toContain('user: hi');
});

test('buildTimelineExtractionTask falls back to default guidance for a blank override', () => {
  expect(buildTimelineExtractionTask('user: hi', '   ')).toContain(DEFAULT_TIMELINE_GUIDANCE);
});

test('parseTimelineBeats parses bare arrays with and without when', () => {
  const beats = parseTimelineBeats('[{"when":"Thursday 6pm","summary":"Mira agrees to visit"},{"summary":"they hug"}]');
  expect(beats).toEqual([{ when: 'Thursday 6pm', summary: 'Mira agrees to visit' }, { summary: 'they hug' }]);
});

test('parseTimelineBeats tolerates fences + prose', () => {
  const beats = parseTimelineBeats('Sure:\n```json\n[{"summary":"door opens"}]\n```');
  expect(beats).toEqual([{ summary: 'door opens' }]);
});

test('parseTimelineBeats drops empty summaries and clamps length + count', () => {
  const long = 'x'.repeat(MAX_BEAT_CHARS + 50);
  const many = Array.from({ length: MAX_BEATS_PER_ROLL + 3 }, (_, i) => ({ summary: `beat ${i}` }));
  const beats = parseTimelineBeats(JSON.stringify([{ summary: '' }, { summary: long }, ...many]));
  expect(beats.length).toBe(MAX_BEATS_PER_ROLL);
  expect(beats[0].summary.length).toBe(MAX_BEAT_CHARS);
});

test('parseTimelineBeats returns [] on the null sentinel / garbage', () => {
  expect(parseTimelineBeats('null')).toEqual([]);
  expect(parseTimelineBeats('[]')).toEqual([]);
  expect(parseTimelineBeats('not json')).toEqual([]);
});

test('formatBeatLine / formatBeatLines render the append-log shape', () => {
  expect(formatBeatLine({ when: 'Thursday 6pm', summary: 'Mira visits' })).toBe('- [Thursday 6pm] Mira visits');
  expect(formatBeatLine({ summary: 'door opens' })).toBe('- door opens');
  expect(formatBeatLines([{ summary: 'a' }, { when: 't', summary: 'b' }])).toBe('- a\n- [t] b');
});

test('parseBeatLog keeps non-empty lines verbatim', () => {
  expect(parseBeatLog('- a\n\n  - [t] b  \n')).toEqual(['- a', '  - [t] b']);
});

test('renderTimelineBlock keeps the most-recent K lines chronologically', () => {
  const body = '- a\n- b\n- c\n- d';
  expect(renderTimelineBlock(body, { maxLines: 2 })).toBe('- c\n- d');
  expect(renderTimelineBlock(body)).toBe(body);
  expect(renderTimelineBlock('   ')).toBeNull();
});

test('renderTimelineBlock trims oldest lines to fit the char cap', () => {
  const body = '- alpha\n- bravo\n- charlie';
  // Cap that only fits the last line or two.
  const out = renderTimelineBlock(body, { maxChars: 10 });
  expect(out).toBe('- charlie');
});

test('renderTimelineBlock clamps a lone over-long line on a word boundary (no mid-word cut)', () => {
  const body = '- the courier delivers an urgent sealed letter to the outpost commander';
  const out = renderTimelineBlock(body, { maxChars: 20 });
  expect(out).not.toBeNull();
  expect(out!.length).toBeLessThanOrEqual(20);
  // No trailing partial word: the cap must fall on a space, not inside a word.
  expect(out).toBe('- the courier');
});

test('normalizeBeatLine trims, collapses whitespace, and lowercases', () => {
  expect(normalizeBeatLine('  - [T]   Mira  VISITS  ')).toBe('- [t] mira visits');
});

test('dedupeNewBeats drops candidates already present in the existing body', () => {
  const existing = '- a\n- [t] b';
  // "- A" normalizes to the existing "- a" (case/whitespace-insensitive).
  const candidate = '-   A\n- c\n- [t] b\n- c';
  expect(dedupeNewBeats(candidate, existing)).toBe('- c');
});

test('dedupeNewBeats keeps all candidates when the existing body is empty', () => {
  expect(dedupeNewBeats('- a\n- b', '')).toBe('- a\n- b');
});

test('dedupeNewBeats collapses byte-identical repeats within one batch', () => {
  expect(dedupeNewBeats('- a\n- a\n- b', '')).toBe('- a\n- b');
});

test('appendBeatBody separates with a newline only when existing is non-blank', () => {
  expect(appendBeatBody('', '- a')).toBe('- a');
  expect(appendBeatBody('   ', '- a')).toBe('- a');
  expect(appendBeatBody('- a', '- b')).toBe('- a\n- b');
  expect(appendBeatBody('- a\n', '- b')).toBe('- a\n- b');
});

test('capBeatLog keeps the newest whole lines within the cap', () => {
  const body = ['- one', '- two', '- three', '- four'].join('\n');
  expect(capBeatLog(body, 1000)).toBe(body);
  // '- three\n- four' is 14 chars; adding '- two\n' would exceed 16.
  expect(capBeatLog(body, 16)).toBe('- three\n- four');
  expect(capBeatLog(body, 14)).toBe('- three\n- four');
  expect(capBeatLog(body, 13)).toBe('- four');
});

test('capBeatLog always keeps the newest line even if it alone overflows', () => {
  expect(capBeatLog('- a\n- a much longer final beat', 5)).toBe('- a much longer final beat');
  expect(capBeatLog('', 5)).toBe('');
});

test('splitBeatLogHalves archives the older half and keeps the extra line newer', () => {
  expect(splitBeatLogHalves('- 1\n- 2\n\n- 3\n- 4\n- 5')).toStrictEqual({
    older: '- 1\n- 2',
    newer: '- 3\n- 4\n- 5',
  });
  expect(splitBeatLogHalves('- only')).toStrictEqual({ older: '', newer: '- only' });
});
