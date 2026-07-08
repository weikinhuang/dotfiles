/**
 * Tests for lib/node/pi/color-tags/theme-tokens.ts.
 */

import { describe, expect, test } from 'vitest';

import { CLOSE_FG, ESC } from '../../../../../lib/node/pi/color-tags/resolve-color.ts';
import {
  buildColorResolver,
  THEME_COLOR_SET,
  THEME_COLOR_TOKENS,
} from '../../../../../lib/node/pi/color-tags/theme-tokens.ts';

describe('THEME_COLOR_TOKENS', () => {
  test('lists the active (uncommented) theme tokens', () => {
    expect(THEME_COLOR_TOKENS).toEqual([
      'accent',
      'border',
      'borderAccent',
      'borderMuted',
      'success',
      'error',
      'warning',
      'muted',
      'dim',
      'text',
    ]);
  });

  test('THEME_COLOR_SET mirrors the token list', () => {
    for (const token of THEME_COLOR_TOKENS) {
      expect(THEME_COLOR_SET.has(token)).toBe(true);
    }
    expect(THEME_COLOR_SET.size).toBe(THEME_COLOR_TOKENS.length);
  });
});

describe('buildColorResolver', () => {
  const themeAnsi = (token: string): string => `${ESC}[THEME:${token}m`;

  test('routes theme tokens to the theme foreground accessor', () => {
    const resolver = buildColorResolver(themeAnsi);
    expect(resolver('accent')).toEqual({ open: `${ESC}[THEME:accentm`, close: CLOSE_FG });
  });

  test('trims whitespace before the theme lookup', () => {
    const resolver = buildColorResolver(themeAnsi);
    expect(resolver('  success  ')).toEqual({ open: `${ESC}[THEME:successm`, close: CLOSE_FG });
  });

  test('an empty / whitespace name resolves to undefined', () => {
    const resolver = buildColorResolver(themeAnsi);
    expect(resolver('')).toBeUndefined();
    expect(resolver('   ')).toBeUndefined();
  });

  test('non-theme names fall through to the pure resolver', () => {
    const resolver = buildColorResolver(themeAnsi);
    expect(resolver('red')).toEqual({ open: `${ESC}[31m`, close: CLOSE_FG });
    expect(resolver('#ffaa00')).toEqual({ open: `${ESC}[38;2;255;170;0m`, close: CLOSE_FG });
  });

  test('an unknown name resolves to undefined and never calls the theme accessor', () => {
    let called = false;
    const resolver = buildColorResolver((token) => {
      called = true;
      return `${ESC}[THEME:${token}m`;
    });
    expect(resolver('not-a-color')).toBeUndefined();
    expect(called).toBe(false);
  });
});
