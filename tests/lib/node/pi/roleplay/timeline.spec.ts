/**
 * Tests for lib/node/pi/roleplay/timeline.ts.
 */

import { expect, test } from 'vitest';

import {
  buildTimelineExtractionTask,
  formatBeatLine,
  formatBeatLines,
  MAX_BEATS_PER_ROLL,
  MAX_BEAT_CHARS,
  parseBeatLog,
  parseTimelineBeats,
  renderTimelineBlock,
} from '../../../../../lib/node/pi/roleplay/timeline.ts';

test('buildTimelineExtractionTask embeds the span and the JSON contract', () => {
  const task = buildTimelineExtractionTask('user: we meet Thursday');
  expect(task).toContain('user: we meet Thursday');
  expect(task).toContain('JSON array');
  expect(task).toContain('chronological');
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
