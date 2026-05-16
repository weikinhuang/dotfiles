/**
 * Tests for lib/node/pi/persona/bash-vouch.ts - pure helper that
 * decides whether the active persona's bashAllow vouches for a bash
 * sub-command at the bash-permissions layer.
 */

import { describe, expect, test } from 'vitest';

import { type ActivePersonaSnapshot } from '../../../../../lib/node/pi/persona/active.ts';
import { personaVouchBash } from '../../../../../lib/node/pi/persona/bash-vouch.ts';

const snapshot = (overrides: Partial<ActivePersonaSnapshot> = {}): ActivePersonaSnapshot => ({
  name: overrides.name ?? 'exusiai',
  resolvedWriteRoots: overrides.resolvedWriteRoots ?? [],
  bashAllow: overrides.bashAllow ?? [],
  bashDeny: overrides.bashDeny ?? [],
});

describe('personaVouchBash', () => {
  test('no active persona → no vouch', () => {
    expect(personaVouchBash({ command: 'ai-fetch-web search foo', active: undefined })).toEqual({
      vouched: false,
    });
  });

  test('empty bashAllow → no vouch (persona has no opinion)', () => {
    const active = snapshot();

    expect(personaVouchBash({ command: 'ai-fetch-web search foo', active })).toEqual({ vouched: false });
  });

  test('exact-token bashAllow matches first token', () => {
    const active = snapshot({ bashAllow: ['ai-fetch-web *'] });

    expect(personaVouchBash({ command: 'ai-fetch-web search foo', active })).toEqual({
      vouched: true,
      personaName: 'exusiai',
      matchedPattern: 'ai-fetch-web *',
    });
  });

  test('plain bashAllow entry matches exact head-token', () => {
    const active = snapshot({ bashAllow: ['rg'] });

    expect(personaVouchBash({ command: 'rg --files', active })).toEqual({
      vouched: true,
      personaName: 'exusiai',
      matchedPattern: 'rg',
    });
  });

  test('mismatched head-token → no vouch', () => {
    const active = snapshot({ bashAllow: ['ai-fetch-web *'] });

    expect(personaVouchBash({ command: 'curl https://example.com', active })).toEqual({ vouched: false });
  });

  test('wildcard `*` vouches for anything', () => {
    const active = snapshot({ bashAllow: ['*'] });

    expect(personaVouchBash({ command: 'whatever --flag', active })).toEqual({
      vouched: true,
      personaName: 'exusiai',
      matchedPattern: '*',
    });
  });

  test('bashDeny does NOT short-circuit a matching bashAllow (allow wins)', () => {
    // Mirrors evaluateBashPolicy: allow > deny on overlap. A persona
    // shipping `bashAllow: ['*'], bashDeny: ['curl *']` is asserting
    // "I trust everything" - the broader allow wins.
    const active = snapshot({ bashAllow: ['*'], bashDeny: ['curl *'] });
    const result = personaVouchBash({ command: 'curl https://example.com', active });

    expect(result.vouched).toBe(true);
    expect(result.matchedPattern).toBe('*');
  });

  test('bashDeny matters only when bashAllow does not match', () => {
    // Vouch fires only when bashAllow matches. With bashAllow that
    // doesn't cover the command, the function returns no-vouch
    // regardless of bashDeny - bash-permissions then handles the
    // command on its own (and persona's own enforcement layer blocks
    // it via the deny).
    const active = snapshot({ bashAllow: ['rg *'], bashDeny: ['curl *'] });

    expect(personaVouchBash({ command: 'curl https://example.com', active }).vouched).toBe(false);
    expect(personaVouchBash({ command: 'rg pattern', active }).vouched).toBe(true);
  });

  test('returns the first matched allow pattern (for diagnostics)', () => {
    const active = snapshot({ bashAllow: ['ai-fetch-web search', 'ai-fetch-web *'] });
    const result = personaVouchBash({ command: 'ai-fetch-web search foo', active });

    expect(result.vouched).toBe(true);
    // Specificity not enforced - first listed match wins. Both are valid;
    // assert the actual behaviour so the diagnostic is predictable.
    expect(result.matchedPattern).toBe('ai-fetch-web *');
  });
});
