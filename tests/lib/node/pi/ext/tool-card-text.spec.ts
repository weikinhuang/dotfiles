import { Text, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';

import { ToolCardText, toolCardSection } from '../../../../../lib/node/pi/ext/tool-card-text.ts';

function clean(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd());
}

describe('expanded tool-card text', () => {
  test('short multi-line commands retain their full text and indentation', () => {
    const command = 'for file in *.ts; do\n  printf "%s\\n" "$file"\ndone';
    expect(new ToolCardText(command).render(100)).toEqual(new Text(command, 0, 0).render(100));
  });

  test('bounds actual wrapped rows, not just logical newlines', () => {
    const text = Array.from({ length: 20 }, (_, i) => `argument-${i}`).join(' ');
    const lines = clean(new ToolCardText(text, 3).render(24));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('argument-0');
    expect(lines[3]).toMatch(/^… \(\d+ more lines\)$/);
    expect(lines.join('\n')).not.toContain('argument-19');
  });

  test('activity tails retain the latest wrapped lines', () => {
    const activity = Array.from({ length: 12 }, (_, i) => `event-${i}`).join('\n');
    expect(clean(new ToolCardText(activity, 3, true).render(60))).toEqual([
      '… (9 more lines)',
      'event-9',
      'event-10',
      'event-11',
    ]);
  });

  test.each([1, 8, 20])('respects terminal width %s with ANSI and wide characters', (width) => {
    const lines = new ToolCardText('\u001b[31m你好 🌟\u001b[0m\nnext\nlast', 1).render(width);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  test('sections contain only text and resize without stale cached truncation', () => {
    const section = toolCardSection('command:', 'first argument second argument third argument', 2);
    const narrow = clean(section.render(10));
    expect(narrow[0]).toBe('command:');
    expect(narrow.at(-1)).toContain('…');
    expect(clean(section.render(100))).toEqual(['command:', 'first argument second argument third argument']);
    expect(section.children.every((child) => child instanceof Text)).toBe(true);
  });
});
