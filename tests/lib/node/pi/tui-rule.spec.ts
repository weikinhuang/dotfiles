/**
 * Tests for lib/node/pi/tui-rule.ts.
 *
 * Pi-free: we stub the `RuleTheme` with a tag-wrapping `fg` so the test
 * can inspect the role/text composition without any pi runtime.
 */

import { expect, test } from 'vitest';

import { formatHeaderRule, type RuleTheme } from '../../../../lib/node/pi/tui-rule.ts';

const tagTheme: RuleTheme = {
  fg(role, text) {
    return `<${role}>${text}</${role}>`;
  },
};

test('formatHeaderRule: chipless shape is `─── Title ───…`', () => {
  const out = formatHeaderRule('Hello', undefined, 30, tagTheme);

  expect(out).toContain('<borderMuted>───</borderMuted>');
  expect(out).toContain('<accent> Hello </accent>');
  // No muted (chip) segment in the chipless shape.
  expect(out).not.toContain('<muted>');
});

test('formatHeaderRule: with chip emits a muted chip segment between borderMuted fills', () => {
  const out = formatHeaderRule('Title', '3/10', 40, tagTheme);

  expect(out).toContain('<accent> Title </accent>');
  expect(out).toContain('<muted> 3/10 </muted>');
  // Lead and trail dashes (3 each) are always present.
  expect(out.match(/<borderMuted>───<\/borderMuted>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
});

test('formatHeaderRule: clamps the fill / middle to non-negative when width is tight', () => {
  // Width too narrow for any fill - chipless: max(0, ...).
  expect(() => formatHeaderRule('XXXXX', undefined, 5, tagTheme)).not.toThrow();
  // Width too narrow for a middle fill - with chip: max(1, ...).
  const out = formatHeaderRule('XXX', 'YYY', 6, tagTheme);
  expect(out).toContain('<accent> XXX </accent>');
  expect(out).toContain('<muted> YYY </muted>');
});
