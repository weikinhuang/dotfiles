/**
 * Tests for lib/node/pi/avatar/state.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  countWords,
  formatToolTally,
  talkDurationMs,
  toolNameToState,
} from '../../../../../lib/node/pi/avatar/state.ts';

describe('toolNameToState', () => {
  test('read maps to read', () => {
    expect(toolNameToState('read')).toBe('read');
  });

  test('write-family tools map to write', () => {
    expect(toolNameToState('write')).toBe('write');
    expect(toolNameToState('edit')).toBe('write');
    expect(toolNameToState('apply_patch')).toBe('write');
  });

  test('anything else maps to tool', () => {
    expect(toolNameToState('bash')).toBe('tool');
    expect(toolNameToState('grep')).toBe('tool');
    expect(toolNameToState('')).toBe('tool');
  });
});

describe('talkDurationMs', () => {
  test('scales with word count over reading speed', () => {
    expect(talkDurationMs(8, 4)).toBe(2000);
    expect(talkDurationMs(0, 4)).toBe(0);
  });

  test('non-positive or non-finite reading speed yields 0', () => {
    expect(talkDurationMs(10, 0)).toBe(0);
    expect(talkDurationMs(10, -1)).toBe(0);
    expect(talkDurationMs(10, Number.NaN)).toBe(0);
  });
});

describe('countWords', () => {
  test('counts whitespace-delimited words', () => {
    expect(countWords('hello there world')).toBe(3);
  });

  test('collapses runs of whitespace and ignores leading/trailing', () => {
    expect(countWords('  a\t\n b   ')).toBe(2);
  });

  test('empty string is zero words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});

describe('formatToolTally', () => {
  test('empty tally renders a placeholder', () => {
    expect(formatToolTally(new Map())).toBe('no tool calls');
    expect(formatToolTally(new Map([['bash', 0]]))).toBe('no tool calls');
  });

  test('sorts by descending count then name', () => {
    const counts = new Map([
      ['read', 2],
      ['bash', 3],
      ['edit', 2],
    ]);
    expect(formatToolTally(counts)).toBe('bash(3) edit(2) read(2)');
  });

  test('drops non-positive counts', () => {
    const counts = new Map([
      ['bash', 1],
      ['grep', 0],
    ]);
    expect(formatToolTally(counts)).toBe('bash(1)');
  });
});
