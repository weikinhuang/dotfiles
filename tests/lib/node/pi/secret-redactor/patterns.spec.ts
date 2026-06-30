/**
 * Tests for lib/node/pi/secret-redactor/patterns.ts.
 *
 * Corpus self-checks + the value guards. Pure module.
 */

import { describe, expect, test } from 'vitest';

import {
  isEnvRef,
  isPlaceholderValue,
  KEYWORD_RULES,
  PREFIXED_RULES,
} from '../../../../../lib/node/pi/secret-redactor/patterns.ts';

describe('rule corpus integrity', () => {
  test('every rule regex carries the g and d flags', () => {
    for (const rule of [...PREFIXED_RULES, ...KEYWORD_RULES]) {
      expect(rule.re.flags).toContain('g');
      expect(rule.re.flags).toContain('d');
    }
  });

  test('prefixed rules redact the whole match, keyword rules a capture group', () => {
    for (const rule of PREFIXED_RULES) expect(rule.group).toBe(0);
    for (const rule of KEYWORD_RULES) expect(rule.group).toBe(1);
  });

  test('rule ids are unique', () => {
    const ids = [...PREFIXED_RULES, ...KEYWORD_RULES].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isEnvRef', () => {
  test('flags shell and code env references', () => {
    expect(isEnvRef('$TOKEN')).toBe(true);
    expect(isEnvRef('${TOKEN}')).toBe(true);
    expect(isEnvRef('process.env.SECRET')).toBe(true);
    expect(isEnvRef('os.environ["X"]')).toBe(true);
  });

  test('does not flag a literal value', () => {
    expect(isEnvRef('sk_live_abcdef')).toBe(false);
  });
});

describe('isPlaceholderValue', () => {
  test('flags obvious placeholders', () => {
    expect(isPlaceholderValue('<your-key>')).toBe(true);
    expect(isPlaceholderValue('xxxxxxxx')).toBe(true);
    expect(isPlaceholderValue('changeme')).toBe(true);
    expect(isPlaceholderValue('abc...xyz')).toBe(true);
    expect(isPlaceholderValue('REDACTED')).toBe(true);
  });

  test('does not flag a real-looking value', () => {
    expect(isPlaceholderValue('hunter2password')).toBe(false);
  });
});
