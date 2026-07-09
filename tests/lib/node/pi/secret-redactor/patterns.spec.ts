/**
 * Tests for lib/node/pi/secret-redactor/patterns.ts.
 *
 * Corpus self-checks + the value guards. Pure module.
 */

import { describe, expect, test } from 'vitest';

import {
  isEnvRef,
  isNetworkLocator,
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
    // Keyword rules redact a positive capture group (the value). Most use
    // group 1; the quoted-value arm captures the quote into group 1 and
    // the value into group 2 via a backreference.
    for (const rule of KEYWORD_RULES) expect(rule.group).toBeGreaterThan(0);
  });

  test('the jwt rule caps each segment length (bounded scan window)', () => {
    const jwt = PREFIXED_RULES.find((r) => r.id === 'jwt');
    expect(jwt).toBeDefined();
    // Bounded quantifiers ({min,max}) rather than unbounded `+`.
    expect(jwt!.re.source).toMatch(/\{1,\d+\}/);
    expect(jwt!.re.source).not.toContain('+');
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

describe('isNetworkLocator', () => {
  test('flags urls, ip addresses, and host:port endpoints', () => {
    expect(isNetworkLocator('http://gpu.lan:19999/v1')).toBe(true);
    expect(isNetworkLocator('https://llm.s.huang.io/v1')).toBe(true);
    expect(isNetworkLocator('10.0.0.5:19999')).toBe(true);
    expect(isNetworkLocator('127.0.0.1')).toBe(true);
    expect(isNetworkLocator('gpu.lan:19999')).toBe(true);
    expect(isNetworkLocator('localhost:8080')).toBe(true);
    expect(isNetworkLocator('n:19999')).toBe(true);
    expect(isNetworkLocator('[::1]:8080')).toBe(true);
  });

  test('does not flag real secrets that merely contain dots or colons', () => {
    expect(isNetworkLocator('hunter2password')).toBe(false);
    expect(isNetworkLocator('sk_live_abcdef123456')).toBe(false);
    expect(isNetworkLocator('aGVsbG8.d29ybGQ.c2ln')).toBe(false); // dotted base64
    expect(isNetworkLocator('pass:word123')).toBe(false); // colon but not host:port
  });
});
