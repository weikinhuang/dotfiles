/**
 * Tests for lib/node/pi/questionnaire/layout.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  padVisibleText,
  selectQuestionnairePreviewLayout,
  windowTabSegments,
  wrapWithPrefix,
  zipQuestionnaireColumns,
} from '../../../../../lib/node/pi/questionnaire/layout.ts';

test('selectQuestionnairePreviewLayout: returns none without preview content', () => {
  expect(selectQuestionnairePreviewLayout({ width: 120 })).toEqual({ mode: 'none' });
  expect(selectQuestionnairePreviewLayout({ width: 120, preview: '' })).toEqual({ mode: 'none' });
});

test('selectQuestionnairePreviewLayout: splits wide previews into left and right panes', () => {
  expect(selectQuestionnairePreviewLayout({ width: 120, preview: 'preview' })).toEqual({
    mode: 'split',
    leftWidth: 48,
    rightWidth: 70,
    gutter: 2,
  });
});

test('selectQuestionnairePreviewLayout: stacks narrow previews with capped dimensions', () => {
  expect(
    selectQuestionnairePreviewLayout({ width: 70, preview: Array.from({ length: 20 }, () => 'x').join('\n') }),
  ).toEqual({
    mode: 'stacked',
    previewHeight: 12,
    previewWidth: 70,
  });
});

test('padVisibleText: pads based on injected visible width', () => {
  const visibleWidth = (s: string): number => s.replace(/\[[a-z]+\]/g, '').length;

  expect(padVisibleText('[red]ok', 5, visibleWidth)).toBe('[red]ok   ');
});

test('zipQuestionnaireColumns: pads left rows and preserves taller columns', () => {
  expect(
    zipQuestionnaireColumns({
      left: ['A', 'Longer'],
      right: ['one', 'two', 'three'],
      leftWidth: 4,
      gutter: 2,
    }),
  ).toEqual(['A     one', 'Longer  two', '      three']);
});

// A trivial word-wrap that splits on spaces; good enough to exercise prefixing.
function fakeWrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > width && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  lines.push(cur);
  return lines;
}

test('wrapWithPrefix: prepends first prefix and space-indents continuation lines', () => {
  expect(
    wrapWithPrefix({
      content: 'one two three four five',
      width: 12,
      firstPrefix: '1. ',
      wrap: fakeWrap,
    }),
  ).toEqual(['1. one two', '   three', '   four five']);
});

test('wrapWithPrefix: honors an explicit continuation prefix and reserves its width', () => {
  const visibleWidth = (s: string): number => s.replace(/\[[a-z]+\]/g, '').length;

  expect(
    wrapWithPrefix({
      content: 'alpha beta gamma',
      width: 10,
      firstPrefix: '[red]> ',
      contPrefix: '  ',
      wrap: fakeWrap,
      visibleWidth,
    }),
  ).toEqual(['[red]> alpha', '  beta', '  gamma']);
});

test('wrapWithPrefix: single short line keeps only the first prefix', () => {
  expect(
    wrapWithPrefix({
      content: 'short',
      width: 40,
      firstPrefix: ' ',
      wrap: fakeWrap,
    }),
  ).toEqual([' short']);
});

test('windowTabSegments: shows every tab when they all fit', () => {
  expect(windowTabSegments({ widths: [5, 5, 5], active: 0, avail: 20 })).toEqual({
    start: 0,
    end: 3,
    hiddenLeft: 0,
    hiddenRight: 0,
  });
});

test('windowTabSegments: keeps the active tab visible and reports hidden sides', () => {
  // 6 tabs of width 5 (total 30) into avail 15 -> 3 tabs fit.
  const win = windowTabSegments({ widths: [5, 5, 5, 5, 5, 5], active: 4, avail: 15 });
  expect(win.start).toBeLessThanOrEqual(4);
  expect(win.end).toBeGreaterThan(4);
  expect(win.end - win.start).toBe(3);
  expect(win.hiddenLeft).toBe(win.start);
  expect(win.hiddenRight).toBe(6 - win.end);
});

test('windowTabSegments: grows right-then-left from the active tab', () => {
  // active=0, avail fits 3 tabs -> window anchors at the left edge.
  expect(windowTabSegments({ widths: [4, 4, 4, 4], active: 0, avail: 12 })).toEqual({
    start: 0,
    end: 3,
    hiddenLeft: 0,
    hiddenRight: 1,
  });
});

test('windowTabSegments: shows the active tab alone when it is wider than avail', () => {
  expect(windowTabSegments({ widths: [3, 20, 3], active: 1, avail: 10 })).toEqual({
    start: 1,
    end: 2,
    hiddenLeft: 1,
    hiddenRight: 1,
  });
});

test('windowTabSegments: empty tab list yields an empty window', () => {
  expect(windowTabSegments({ widths: [], active: 0, avail: 40 })).toEqual({
    start: 0,
    end: 0,
    hiddenLeft: 0,
    hiddenRight: 0,
  });
});
