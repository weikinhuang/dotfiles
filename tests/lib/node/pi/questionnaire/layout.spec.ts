/**
 * Tests for lib/node/pi/questionnaire/layout.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  padVisibleText,
  selectQuestionnairePreviewLayout,
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
