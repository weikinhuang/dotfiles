/**
 * Tests for lib/node/opencode/statusline.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  buildSegments,
  cacheRatio,
  cellWidth,
  countToolCalls,
  DEFAULT_SEGMENTS,
  fitSegments,
  lastStepUsage,
  type MessageLike,
  nativeFooterWidth,
  nativeNumber,
  nativeUsageText,
  parseSegmentList,
  resolveStatuslineConfig,
  SEGMENT_IDS,
  type Segment,
  segmentsWidth,
  shortSessionId,
  statuslineBudget,
  type TokenUsage,
} from '../../../../lib/node/opencode/statusline.ts';

function usage(input: number, read: number, output = 0, write = 0): TokenUsage {
  return { input, output, reasoning: 0, cache: { read, write } };
}

function assistant(id: string, tokens?: TokenUsage, tools = 0): MessageLike {
  return {
    id,
    type: 'assistant',
    tokens,
    content: [{ type: 'text' }, ...Array.from({ length: tools }, () => ({ type: 'tool' }))],
  };
}

describe('parseSegmentList', () => {
  test('explicit list keeps display order and drops unknown ids', () => {
    expect(parseSegmentList('user, cache git bogus')).toEqual(['git', 'cache', 'user']);
  });

  test('+/- entries edit the defaults', () => {
    expect(parseSegmentList('+tokens,-user')).toEqual(['git', 'worktree', 'cache', 'tokens', 'write', 'tools', 'id']);
  });

  test('all / none shorthands and arrays', () => {
    expect(parseSegmentList('all')).toEqual([...SEGMENT_IDS]);
    expect(parseSegmentList('none')).toEqual([]);
    expect(parseSegmentList(['id', 'git'])).toEqual(['git', 'id']);
  });

  test('blank or non-string is unset', () => {
    expect(parseSegmentList('  ')).toBeUndefined();
    expect(parseSegmentList(3)).toBeUndefined();
  });
});

describe('resolveStatuslineConfig', () => {
  test('defaults', () => {
    expect(resolveStatuslineConfig(undefined, {})).toEqual({
      enabled: true,
      segments: [...DEFAULT_SEGMENTS],
      gitPrompt: true,
      gitBranch: false,
      gitIntervalSeconds: 0,
    });
  });

  test('env overrides options', () => {
    const config = resolveStatuslineConfig(
      { segments: 'git', gitBranch: false },
      {
        OPENCODE_STATUSLINE_SEGMENTS: '-id',
        OPENCODE_STATUSLINE_GIT_BRANCH: '1',
        OPENCODE_STATUSLINE_GIT_PROMPT: 'off',
        OPENCODE_STATUSLINE_GIT_INTERVAL: '30',
        OPENCODE_STATUSLINE_ENABLED: 'no',
      },
    );
    expect(config).toEqual({
      enabled: false,
      segments: ['git', 'worktree', 'cache', 'write', 'tools', 'user'],
      gitPrompt: false,
      gitBranch: true,
      gitIntervalSeconds: 30,
    });
  });
});

describe('usage extraction', () => {
  test('lastStepUsage skips zero-usage steps and stops at a completed compaction', () => {
    const messages: MessageLike[] = [
      assistant('a1', usage(10, 0, 5)),
      { id: 'c1', type: 'compaction', status: 'completed' },
      assistant('a2', usage(3, 90, 4)),
      assistant('a3', usage(0, 0, 0)),
      { id: 'u1', type: 'user' },
    ];
    expect(lastStepUsage(messages)).toEqual(usage(3, 90, 4));
    expect(lastStepUsage(messages.slice(0, 2))).toBeUndefined();
  });

  test('lastStepUsage honors the revert boundary', () => {
    const messages = [assistant('a1', usage(1, 1)), assistant('a2', usage(2, 2))];
    expect(lastStepUsage(messages, 'a2')).toEqual(usage(1, 1));
    expect(lastStepUsage(messages, 'missing')).toBeUndefined();
  });

  test('countToolCalls counts tool parts of assistant steps only', () => {
    expect(
      countToolCalls([assistant('a', undefined, 2), { id: 'u', type: 'user' }, assistant('b', undefined, 1)]),
    ).toBe(3);
  });

  test('cacheRatio uses input + cache.read', () => {
    expect(cacheRatio(usage(10, 90))).toBe(90);
    expect(cacheRatio(usage(0, 0))).toBeNull();
    expect(cacheRatio(undefined)).toBeNull();
  });

  test('shortSessionId keeps the random tail', () => {
    expect(shortSessionId('ses_0123456789abAbCdEfGh12345')).toBe('fGh12345');
    expect(shortSessionId(undefined)).toBe('');
  });
});

describe('buildSegments', () => {
  test('renders every segment in display order', () => {
    const segments = buildSegments(
      {
        git: '(*+%=)',
        worktree: 'feature-x',
        sessionID: 'ses_0123456789abAbCdEfGh12345',
        last: usage(1000, 9000, 180),
        session: usage(4000, 12000, 700, 1200),
        toolCalls: 6,
        user: 'me#box',
      },
      SEGMENT_IDS,
    );
    expect(segments.map((s) => s.text)).toEqual([
      '(*+%=)',
      '⎇ feature-x',
      'R 90%/75%',
      '↑1k/↻ 9k/↓180',
      'W 1k',
      '⚒ 6',
      '§fGh12345',
      'me#box',
    ]);
    expect(segments.find((s) => s.id === 'cache')?.tone).toBe('good');
  });

  test('collapses equal ratios, hides empty values and disabled ids', () => {
    const segments = buildSegments(
      { git: '', worktree: null, last: usage(90, 10), session: usage(90, 10), toolCalls: 0, user: 'me#box' },
      ['git', 'worktree', 'cache', 'write', 'tools', 'id'],
    );
    expect(segments).toEqual([{ id: 'cache', text: 'R 10%', tone: 'warn' }]);
  });

  test('session-only ratio before the first step lands', () => {
    expect(buildSegments({ session: usage(1, 3) }, ['cache'])[0]?.text).toBe('R -/75%');
  });
});

describe('width fitting', () => {
  const seg = (id: Segment['id'], text: string): Segment => ({ id, text, tone: 'muted' });
  const all = [
    seg('git', '(*)'),
    seg('cache', 'R 90%'),
    seg('tools', '⚒ 6'),
    seg('id', '§abcdefgh'),
    seg('user', 'u#h'),
  ];

  test('cellWidth counts narrow glyphs as one and CJK as two', () => {
    expect(cellWidth('⎇ ⚒ § ↻')).toBe(7);
    expect(cellWidth('分支')).toBe(4);
    expect(cellWidth('\x1b')).toBe(0);
  });

  test('segmentsWidth includes separators', () => {
    expect(segmentsWidth([])).toBe(0);
    expect(segmentsWidth(all.slice(0, 2))).toBe(3 + 3 + 5);
  });

  test('fitSegments drops lowest priority first and keeps order', () => {
    expect(fitSegments(all, 100)).toEqual(all);
    expect(fitSegments(all, 20).map((s) => s.id)).toEqual(['git', 'cache', 'tools']);
    expect(fitSegments(all, 3).map((s) => s.id)).toEqual(['git']);
    expect(fitSegments(all, 2)).toEqual([]);
  });
});

describe('native footer mirror', () => {
  test('nativeNumber matches Locale.number', () => {
    expect(nativeNumber(999)).toBe('999');
    expect(nativeNumber(12_345)).toBe('12.3K');
    expect(nativeNumber(999_950)).toBe('1.0M');
  });

  test('nativeUsageText', () => {
    expect(nativeUsageText({ last: usage(10_000, 2_345), contextLimit: 200_000, cost: 0.042 })).toBe(
      '12.3K (6%) · $0.04',
    );
    expect(nativeUsageText({ last: usage(5, 0), cost: 0 })).toBe('5');
    expect(nativeUsageText({ cost: 0 })).toBe('');
  });

  test('nativeFooterWidth follows promptFooterLayout', () => {
    // usage (18) + shortcut (15) fit at 120 columns.
    expect(nativeFooterWidth({ width: 120, usage: '12.3K (6%) · $0.04', shortcut: 'ctrl+p' })).toBe(18 + 2 + 15);
    // At 50 columns only the usage fits (available = 42 - 21 = 21).
    expect(nativeFooterWidth({ width: 50, usage: '12.3K (6%) · $0.04', shortcut: 'ctrl+p' })).toBe(18);
    expect(nativeFooterWidth({ width: 30, usage: '12.3K (6%) · $0.04', shortcut: 'ctrl+p' })).toBe(0);
    // No usage: agent + command shortcuts from 44 columns.
    expect(nativeFooterWidth({ width: 80, usage: '', shortcut: 'ctrl+p', agentShortcut: 'tab' })).toBe(10 + 2 + 15);
    expect(nativeFooterWidth({ width: 40, usage: '', shortcut: 'ctrl+p', agentShortcut: 'tab' })).toBe(0);
  });

  test('statuslineBudget reserves the native footer, location, and gaps', () => {
    expect(statuslineBudget({ rowWidth: 112, nativeWidth: 35, locationWidth: 10 })).toBe(112 - 35 - 10 - 4);
    expect(statuslineBudget({ rowWidth: 112, nativeWidth: 0, locationWidth: 60 })).toBe(112 - 24 - 2);
    expect(statuslineBudget({ rowWidth: 30, nativeWidth: 20, locationWidth: 20 })).toBe(0);
  });
});
