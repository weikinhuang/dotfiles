/**
 * Tests for lib/node/pi/hooks/matcher.ts. Zero pi dependencies.
 */

import { describe, expect, test, vi } from 'vitest';

import { matchesMatcher } from '../../../../../lib/node/pi/hooks/matcher.ts';

describe('matchesMatcher', () => {
  test('undefined matcher matches every tool (the no-tool-dimension case)', () => {
    expect(matchesMatcher(undefined, 'bash')).toBe(true);
    expect(matchesMatcher(undefined, 'anything')).toBe(true);
  });

  test('star matches every tool', () => {
    expect(matchesMatcher('*', 'bash')).toBe(true);
    expect(matchesMatcher('*', 'edit')).toBe(true);
  });

  test('empty matcher behaves like star', () => {
    expect(matchesMatcher('', 'bash')).toBe(true);
    expect(matchesMatcher('   ', 'bash')).toBe(true);
  });

  test('exact match is whole-string and case-sensitive', () => {
    expect(matchesMatcher('bash', 'bash')).toBe(true);
    expect(matchesMatcher('bash', 'Bash')).toBe(false);
    expect(matchesMatcher('bash', 'bashish')).toBe(false);
    expect(matchesMatcher('bash', 'ba')).toBe(false);
  });

  test('exact match tolerates surrounding whitespace in the matcher', () => {
    expect(matchesMatcher('  bash  ', 'bash')).toBe(true);
  });

  test('comma list matches any entry', () => {
    expect(matchesMatcher('edit,write', 'edit')).toBe(true);
    expect(matchesMatcher('edit,write', 'write')).toBe(true);
    expect(matchesMatcher('edit,write', 'bash')).toBe(false);
  });

  test('comma list tolerates whitespace around entries', () => {
    expect(matchesMatcher('edit , write , bash', 'write')).toBe(true);
    expect(matchesMatcher('edit , write , bash', 'bash')).toBe(true);
    expect(matchesMatcher('edit , write , bash', 'pwd')).toBe(false);
  });

  test('re: form uses a JS regex', () => {
    expect(matchesMatcher('re:^edit|write$', 'edit')).toBe(true);
    expect(matchesMatcher('re:^edit|write$', 'write')).toBe(true);
    expect(matchesMatcher('re:^edit|write$', 'bash')).toBe(false);
  });

  test('re: with anchors enforces whole-string match', () => {
    expect(matchesMatcher('re:^ba', 'bash')).toBe(true);
    expect(matchesMatcher('re:sh$', 'bash')).toBe(true);
    expect(matchesMatcher('re:^bash$', 'bashish')).toBe(false);
  });

  test('re: with invalid regex never matches and warns once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // `[` is an unterminated character class.
      expect(matchesMatcher('re:[', 'bash')).toBe(false);
      // Second call same pattern: still false, no extra warn.
      expect(matchesMatcher('re:[', 'bash')).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('invalid regex matcher');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
