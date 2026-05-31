/**
 * Tests for lib/node/pi/avatar/state.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  bashCommandToState,
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

  test('investigation tools map to debug', () => {
    expect(toolNameToState('grep')).toBe('debug');
    expect(toolNameToState('glob')).toBe('debug');
    expect(toolNameToState('codebase_search')).toBe('debug');
  });

  test('network tools map to fetch', () => {
    expect(toolNameToState('fetch')).toBe('fetch');
    expect(toolNameToState('web_search')).toBe('fetch');
  });

  test('planning tools map to plan', () => {
    expect(toolNameToState('todo_write')).toBe('plan');
    expect(toolNameToState('update_plan')).toBe('plan');
  });

  test('anything else maps to tool', () => {
    expect(toolNameToState('bash')).toBe('tool');
    expect(toolNameToState('')).toBe('tool');
  });
});

describe('bashCommandToState', () => {
  test('detects the ai-fetch-web helper as fetch', () => {
    expect(bashCommandToState('ai-fetch-web --json fetch https://example.com')).toBe('fetch');
    expect(bashCommandToState('/usr/local/bin/ai-fetch-web search "q"')).toBe('fetch');
    expect(bashCommandToState('curl https://example.com | ai-fetch-web')).toBe('fetch');
  });

  test('detects search/find/list/inspect commands as debug', () => {
    expect(bashCommandToState('rg --no-heading foo src')).toBe('debug');
    expect(bashCommandToState('ls -la')).toBe('debug');
    expect(bashCommandToState('cat file | grep needle')).toBe('debug');
    expect(bashCommandToState('sudo find / -name core')).toBe('debug');
    expect(bashCommandToState('AVATAR_X=1 fd pattern')).toBe('debug');
  });

  test('matches read-only git subcommands but not mutating ones', () => {
    expect(bashCommandToState('git status -sb')).toBe('debug');
    expect(bashCommandToState('git log --oneline -5')).toBe('debug');
    expect(bashCommandToState('git commit -m "x"')).toBeNull();
  });

  test('returns null for substrings and unrelated commands', () => {
    expect(bashCommandToState('echo myai-fetch-website')).toBeNull();
    expect(bashCommandToState('npm run build')).toBeNull();
    expect(bashCommandToState('')).toBeNull();
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
