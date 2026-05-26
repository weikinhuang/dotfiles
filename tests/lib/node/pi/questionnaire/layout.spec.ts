/**
 * Tests for lib/node/pi/questionnaire/layout.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  padVisibleText,
  selectQuestionnairePreviewLayout,
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
