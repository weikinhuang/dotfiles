/**
 * Tests for lib/node/pi/color-tags/resolve-color.ts.
 */

import { describe, expect, test } from 'vitest';

import { CLOSE_FG, ESC, NAMED_COLOR_NAMES, resolveColor } from '../../../../../lib/node/pi/color-tags/resolve-color.ts';

describe('resolveColor: named-16', () => {
  test('basic eight resolve to SGR 30-37', () => {
    expect(resolveColor('black')).toEqual({ open: `${ESC}[30m`, close: CLOSE_FG });
    expect(resolveColor('red')).toEqual({ open: `${ESC}[31m`, close: CLOSE_FG });
    expect(resolveColor('green')).toEqual({ open: `${ESC}[32m`, close: CLOSE_FG });
    expect(resolveColor('yellow')).toEqual({ open: `${ESC}[33m`, close: CLOSE_FG });
    expect(resolveColor('blue')).toEqual({ open: `${ESC}[34m`, close: CLOSE_FG });
    expect(resolveColor('magenta')).toEqual({ open: `${ESC}[35m`, close: CLOSE_FG });
    expect(resolveColor('cyan')).toEqual({ open: `${ESC}[36m`, close: CLOSE_FG });
    expect(resolveColor('white')).toEqual({ open: `${ESC}[37m`, close: CLOSE_FG });
  });

  test('bright variants resolve to SGR 90-97', () => {
    expect(resolveColor('bright-black')).toEqual({ open: `${ESC}[90m`, close: CLOSE_FG });
    expect(resolveColor('bright-red')).toEqual({ open: `${ESC}[91m`, close: CLOSE_FG });
    expect(resolveColor('bright-white')).toEqual({ open: `${ESC}[97m`, close: CLOSE_FG });
  });

  test('gray and grey both alias bright-black', () => {
    expect(resolveColor('gray')).toEqual({ open: `${ESC}[90m`, close: CLOSE_FG });
    expect(resolveColor('grey')).toEqual({ open: `${ESC}[90m`, close: CLOSE_FG });
  });

  test('named lookup is case-insensitive', () => {
    expect(resolveColor('RED')).toEqual({ open: `${ESC}[31m`, close: CLOSE_FG });
    expect(resolveColor('Bright-Cyan')).toEqual({ open: `${ESC}[96m`, close: CLOSE_FG });
  });

  test('whitespace around the name is ignored', () => {
    expect(resolveColor('  red  ')).toEqual({ open: `${ESC}[31m`, close: CLOSE_FG });
  });
});

describe('resolveColor: 256-index', () => {
  test('x256- prefix resolves to SGR 38;5;N', () => {
    expect(resolveColor('x256-0')).toEqual({ open: `${ESC}[38;5;0m`, close: CLOSE_FG });
    expect(resolveColor('x256-208')).toEqual({ open: `${ESC}[38;5;208m`, close: CLOSE_FG });
    expect(resolveColor('x256-255')).toEqual({ open: `${ESC}[38;5;255m`, close: CLOSE_FG });
  });

  test('256- alias also works', () => {
    expect(resolveColor('256-208')).toEqual({ open: `${ESC}[38;5;208m`, close: CLOSE_FG });
  });

  test('out-of-range index returns undefined', () => {
    expect(resolveColor('x256-256')).toBeUndefined();
    expect(resolveColor('x256-999')).toBeUndefined();
  });

  test('non-digit or empty index returns undefined', () => {
    expect(resolveColor('x256-')).toBeUndefined();
    expect(resolveColor('x256-foo')).toBeUndefined();
  });
});

describe('resolveColor: 24-bit hex', () => {
  test('#RRGGBB resolves to SGR 38;2;R;G;B', () => {
    expect(resolveColor('#ff0000')).toEqual({ open: `${ESC}[38;2;255;0;0m`, close: CLOSE_FG });
    expect(resolveColor('#00ff00')).toEqual({ open: `${ESC}[38;2;0;255;0m`, close: CLOSE_FG });
    expect(resolveColor('#1234ab')).toEqual({ open: `${ESC}[38;2;18;52;171m`, close: CLOSE_FG });
  });

  test('#RGB shorthand expands each nibble', () => {
    expect(resolveColor('#f00')).toEqual({ open: `${ESC}[38;2;255;0;0m`, close: CLOSE_FG });
    expect(resolveColor('#abc')).toEqual({ open: `${ESC}[38;2;170;187;204m`, close: CLOSE_FG });
  });

  test('mixed-case hex digits accepted', () => {
    expect(resolveColor('#FFAA00')).toEqual({ open: `${ESC}[38;2;255;170;0m`, close: CLOSE_FG });
  });

  test('malformed hex returns undefined', () => {
    expect(resolveColor('#')).toBeUndefined();
    expect(resolveColor('#xx')).toBeUndefined();
    expect(resolveColor('#12345')).toBeUndefined();
    expect(resolveColor('#1234567')).toBeUndefined();
    expect(resolveColor('#zzz')).toBeUndefined();
  });
});

describe('resolveColor: unknown / invalid', () => {
  test('empty input returns undefined', () => {
    expect(resolveColor('')).toBeUndefined();
    expect(resolveColor('   ')).toBeUndefined();
  });

  test('unrelated names return undefined (no theme tokens here)', () => {
    expect(resolveColor('accent')).toBeUndefined();
    expect(resolveColor('success')).toBeUndefined();
    expect(resolveColor('mdHeading')).toBeUndefined();
  });

  test('close sequence is always default-foreground, never full reset', () => {
    expect(CLOSE_FG).toBe(`${ESC}[39m`);
    const r = resolveColor('red');
    expect(r?.close).toBe(`${ESC}[39m`);
    expect(r?.close).not.toBe(`${ESC}[0m`);
  });
});

describe('NAMED_COLOR_NAMES', () => {
  test('exposes the named-16 vocabulary plus aliases', () => {
    expect(NAMED_COLOR_NAMES).toContain('red');
    expect(NAMED_COLOR_NAMES).toContain('bright-magenta');
    expect(NAMED_COLOR_NAMES).toContain('gray');
    expect(NAMED_COLOR_NAMES).toContain('grey');
  });
});
