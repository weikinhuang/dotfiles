/**
 * Tests for `lib/node/pi/mode/bash-policy.ts`.
 */

import { expect, test } from 'vitest';

import { evaluateBashPolicy, matchBashPattern } from '../../../../../lib/node/pi/persona/bash-policy.ts';
import { assertKind } from '../helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// matchBashPattern — pattern semantics
// ──────────────────────────────────────────────────────────────────────

test('matchBashPattern: empty patterns → false', () => {
  expect(matchBashPattern('rg foo', [])).toBe(false);
});

test('matchBashPattern: literal `*` matches anything', () => {
  expect(matchBashPattern('rm -rf /', ['*'])).toBe(true);
  expect(matchBashPattern('', ['*'])).toBe(true);
});

test('matchBashPattern: exact head-token match', () => {
  expect(matchBashPattern('ls', ['ls'])).toBe(true);
  expect(matchBashPattern('ls -la', ['ls'])).toBe(true);
  expect(matchBashPattern('lsof', ['ls'])).toBe(false);
});

test('matchBashPattern: `foo *` matches commands whose head is `foo`', () => {
  expect(matchBashPattern('rg pattern', ['rg *'])).toBe(true);
  expect(matchBashPattern('rg', ['rg *'])).toBe(true);
  expect(matchBashPattern('ls', ['rg *'])).toBe(false);
});

test('matchBashPattern: head token whitespace-trimmed before compare', () => {
  expect(matchBashPattern('   rg pattern   ', ['rg *'])).toBe(true);
});

test('matchBashPattern: head token tab-separated', () => {
  expect(matchBashPattern('rg\tpattern', ['rg *'])).toBe(true);
});

test('matchBashPattern: any list entry matches → true', () => {
  expect(matchBashPattern('fd src', ['rg *', 'fd *', 'ls *'])).toBe(true);
});

test('matchBashPattern: ai-fetch-web hyphenated head (catalog precedent)', () => {
  expect(matchBashPattern('ai-fetch-web search "x"', ['ai-fetch-web *'])).toBe(true);
  expect(matchBashPattern('ai fetch web search', ['ai-fetch-web *'])).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// evaluateBashPolicy — decision tree
// ──────────────────────────────────────────────────────────────────────

test('evaluateBashPolicy: empty allow + empty deny → allow (mode has no opinion)', () => {
  expect(evaluateBashPolicy({ command: 'ls', bashAllow: [], bashDeny: [], personaName: 'debug' })).toEqual({
    kind: 'allow',
  });
});

test('evaluateBashPolicy: deny `*` blocks any command (catalog plan/journal/roleplay/review)', () => {
  const result = evaluateBashPolicy({
    command: 'ls -la',
    bashAllow: [],
    bashDeny: ['*'],
    personaName: 'plan',
  });

  assertKind(result, 'block');

  expect(result.reason).toContain('persona "plan"');
  expect(result.reason).toContain('bashDeny');
});

test('evaluateBashPolicy: deny matches → block; allow ignored on overlap', () => {
  // Pathological mode that allows AND denies the same prefix; deny wins.
  const result = evaluateBashPolicy({
    command: 'rm -rf /',
    bashAllow: ['rm *'],
    bashDeny: ['rm *'],
    personaName: 'paranoid',
  });

  expect(result.kind).toBe('block');
});

test('evaluateBashPolicy: non-empty allow, head matches → allow', () => {
  expect(
    evaluateBashPolicy({
      command: 'rg pattern',
      bashAllow: ['ai-fetch-web *', 'rg *'],
      bashDeny: [],
      personaName: 'chat',
    }),
  ).toEqual({ kind: 'allow' });
});

test('evaluateBashPolicy: non-empty allow, head misses → block with allow-list in reason', () => {
  const result = evaluateBashPolicy({
    command: 'curl https://example.com',
    bashAllow: ['ai-fetch-web *', 'rg *'],
    bashDeny: [],
    personaName: 'chat',
  });

  assertKind(result, 'block');

  expect(result.reason).toContain('persona "chat"');
  expect(result.reason).toContain('ai-fetch-web *');
  expect(result.reason).toContain('rg *');
});

test('evaluateBashPolicy: deny + allow, deny matches first', () => {
  const result = evaluateBashPolicy({
    command: 'rm -rf /etc',
    bashAllow: ['rg *'],
    bashDeny: ['rm *'],
    personaName: 'paranoid-research',
  });

  assertKind(result, 'block');

  expect(result.reason).toContain('bashDeny');
});

test('evaluateBashPolicy: deny + allow, neither matches → allow (allow is required-only when non-empty)', () => {
  // bashAllow non-empty but doesn't match the command, deny doesn't match either.
  // Allow-list rule fires: command must be in the allowlist.
  const result = evaluateBashPolicy({
    command: 'ls',
    bashAllow: ['rg *'],
    bashDeny: ['rm *'],
    personaName: 'mixed',
  });

  assertKind(result, 'block');

  expect(result.reason).toContain('allows only');
});
