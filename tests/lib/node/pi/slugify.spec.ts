/**
 * Tests for lib/node/pi/slugify.ts - the shared ASCII slug builder.
 * Pure module.
 */

import { describe, expect, test } from 'vitest';

import { slugifyAscii } from '../../../../lib/node/pi/slugify.ts';

describe('slugifyAscii', () => {
  test('lowercases, collapses non-alphanumerics, trims dashes', () => {
    expect(slugifyAscii('Exusiai & Texas')).toBe('exusiai-texas');
    expect(slugifyAscii('  Hello,  World!  ')).toBe('hello-world');
    expect(slugifyAscii('a__b--c')).toBe('a-b-c');
  });

  test('returns the string fallback when nothing usable remains', () => {
    expect(slugifyAscii('   ', { fallback: 'memory' })).toBe('memory');
    expect(slugifyAscii('!!!', { fallback: 'entry' })).toBe('entry');
    // No fallback configured -> empty string.
    expect(slugifyAscii('###')).toBe('');
  });

  test('calls a function fallback lazily only when empty', () => {
    let calls = 0;
    const fb = (): string => {
      calls++;
      return 'r-fallback';
    };
    expect(slugifyAscii('has-content', { fallback: fb })).toBe('has-content');
    expect(calls).toBe(0);
    expect(slugifyAscii('***', { fallback: fb })).toBe('r-fallback');
    expect(calls).toBe(1);
  });

  test('stripDiacritics folds accents to ASCII (opt-in)', () => {
    expect(slugifyAscii('café crème', { stripDiacritics: true })).toBe('cafe-creme');
    // Off by default: accented chars are non-[a-z0-9] and become a dash.
    expect(slugifyAscii('café')).toBe('caf');
  });

  test('maxLength truncates and re-trims a stranded trailing dash', () => {
    expect(slugifyAscii('foo-bar-baz', { maxLength: 7 })).toBe('foo-bar');
    // Cut lands right after a dash -> the trailing dash is trimmed.
    expect(slugifyAscii('ab cd ef', { maxLength: 6 })).toBe('ab-cd');
  });
});
