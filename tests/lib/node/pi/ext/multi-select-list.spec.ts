/**
 * Tests for lib/node/pi/ext/multi-select-list.ts.
 *
 * The component imports `@earendil-works/pi-tui` for `truncateToWidth`, which
 * loads fine under vitest. The theme is faked with a tagging `fg` so the
 * assertions can see which color token each row used without ANSI noise.
 */

import { expect, test } from 'vitest';

import { MultiSelectList, type MultiSelectThemeLike } from '../../../../../lib/node/pi/ext/multi-select-list.ts';

// Tagging theme: `fg('accent', 'x')` => '<accent>x</accent>'.
const theme: MultiSelectThemeLike = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

function list(): MultiSelectList {
  return new MultiSelectList(
    [{ label: 'Alpha' }, { label: 'Beta', description: 'second option' }, { label: 'Gamma' }],
    { minSelect: 1, maxSelect: 2 },
  );
}

test('working set: toggles, sorts, and reports selection', () => {
  const ms = list();
  expect(ms.selectedIndices()).toEqual([]);
  expect(ms.meetsMinSelect()).toBe(false);

  expect(ms.toggle(2)).toBe('added');
  expect(ms.toggle(0)).toBe('added');
  expect(ms.selectedIndices()).toEqual([0, 2]);
  expect(ms.isSelected(2)).toBe(true);
  expect(ms.meetsMinSelect()).toBe(true);

  // maxSelect = 2 blocks a third add but leaves the set unchanged.
  expect(ms.toggle(1)).toBe('blocked');
  expect(ms.selectedIndices()).toEqual([0, 2]);

  expect(ms.toggle(0)).toBe('removed');
  expect(ms.selectedIndices()).toEqual([2]);
});

test('initialSelected: seeds the working set, ignoring out-of-range indices', () => {
  const ms = new MultiSelectList([{ label: 'A' }, { label: 'B' }], { initialSelected: [1, 5, -1] });
  expect(ms.selectedIndices()).toEqual([1]);
});

test('cursor: moveUp/moveDown clamp and digit jump targets rows', () => {
  const ms = list();
  expect(ms.cursor).toBe(0);
  ms.moveUp();
  expect(ms.cursor).toBe(0);
  ms.moveDown();
  ms.moveDown();
  ms.moveDown();
  expect(ms.cursor).toBe(2); // clamped to last row

  expect(ms.jumpToDigit(2)).toBe(true);
  expect(ms.cursor).toBe(1);
  expect(ms.jumpToDigit(9)).toBe(true);
  expect(ms.cursor).toBe(2); // clamps past the end
  expect(ms.jumpToDigit(0)).toBe(false);
  expect(ms.cursor).toBe(2); // unchanged on out-of-range digit
});

test('renderRow: highlighted checkbox row carries cursor prefix + checkbox state', () => {
  const ms = list();
  ms.toggle(0);
  const rows = ms.renderRow(0, { width: 80, highlighted: true, theme });
  expect(rows).toEqual(['<accent>❯ </accent><accent>1. [x] Alpha</accent>']);
});

test('renderRow: unhighlighted row uses blank prefix, text color, and renders description', () => {
  const ms = list();
  const rows = ms.renderRow(1, { width: 80, highlighted: false, theme });
  expect(rows).toEqual(['  <text>2. [ ] Beta</text>', '     <muted>second option</muted>']);
});

test('render: emits every checkbox row, highlighting the given index', () => {
  const ms = list();
  ms.toggle(1);
  const lines = ms.render({ width: 80, highlight: 2, theme });
  expect(lines).toEqual([
    '  <text>1. [ ] Alpha</text>',
    '  <text>2. [x] Beta</text>',
    '     <muted>second option</muted>',
    '<accent>❯ </accent><accent>3. [ ] Gamma</accent>',
  ]);
});

test('render: defaults highlight to the component cursor', () => {
  const ms = new MultiSelectList([{ label: 'A' }, { label: 'B' }]);
  ms.moveDown();
  const lines = ms.render({ width: 80, theme });
  expect(lines).toEqual(['  <text>1. [ ] A</text>', '<accent>❯ </accent><accent>2. [ ] B</accent>']);
});
