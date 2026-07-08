/**
 * Tests for lib/node/pi/color-tags/strip-ansi.ts.
 */

import { describe, expect, test } from 'vitest';

import { CLOSE_FG, ESC } from '../../../../../lib/node/pi/color-tags/resolve-color.ts';
import { stripAnsi } from '../../../../../lib/node/pi/color-tags/strip-ansi.ts';

describe('stripAnsi', () => {
  test('removes a simple SGR color sequence', () => {
    expect(stripAnsi(`${ESC}[31mred${CLOSE_FG}`)).toBe('red');
  });

  test('removes extended 256 / truecolor sequences', () => {
    expect(stripAnsi(`${ESC}[38;5;200mx${ESC}[39m`)).toBe('x');
    expect(stripAnsi(`${ESC}[38;2;10;20;30my${ESC}[39m`)).toBe('y');
  });

  test('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });

  test('leaves non-SGR CSI sequences (e.g. cursor moves) alone', () => {
    // `\x1b[2J` (clear) and `\x1b[H` (home) do not end in `m`.
    expect(stripAnsi(`${ESC}[2J${ESC}[H`)).toBe(`${ESC}[2J${ESC}[H`);
  });

  test('strips every SGR occurrence in a longer string', () => {
    const input = `a${ESC}[31mb${ESC}[39mc${ESC}[1md${ESC}[0m`;
    expect(stripAnsi(input)).toBe('abcd');
  });
});
