/**
 * Tests for lib/node/pi/avatar/emotes.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  classifyStateDirs,
  globToRegex,
  isActivityState,
  pickRandom,
  pickWeighted,
  resolveEmoteSet,
} from '../../../../../lib/node/pi/avatar/emotes.ts';
import type { EmoteMapping } from '../../../../../lib/node/pi/avatar/types.ts';

describe('globToRegex', () => {
  test('matches with * and ? wildcards, case-insensitively', () => {
    expect(globToRegex('*claude*').test('anthropic/claude-opus-4.8')).toBe(true);
    expect(globToRegex('gpt-?').test('GPT-5')).toBe(true);
    expect(globToRegex('*haiku*').test('claude-opus')).toBe(false);
  });

  test('escapes regex metacharacters in the literal pattern', () => {
    expect(globToRegex('a.b').test('a.b')).toBe(true);
    expect(globToRegex('a.b').test('axb')).toBe(false);
  });
});

describe('resolveEmoteSet', () => {
  const mappings: EmoteMapping[] = [
    { model: '*', 'emote-set': 'default' },
    { model: '*claude*', 'emote-set': 'robot' },
  ];

  test('last match wins', () => {
    expect(resolveEmoteSet('anthropic/claude-opus', mappings)).toEqual({
      set: 'robot',
      overlays: [],
      ambiguous: false,
    });
  });

  test('falls back to default catch-all', () => {
    expect(resolveEmoteSet('openai/gpt-5', mappings)).toEqual({ set: 'default', overlays: [], ambiguous: false });
  });

  test('empty mappings resolve to default', () => {
    expect(resolveEmoteSet('any', [])).toEqual({ set: 'default', overlays: [], ambiguous: false });
  });

  test('flags ambiguity when two specific patterns match', () => {
    const ambiguous: EmoteMapping[] = [
      { model: '*opus*', 'emote-set': 'a' },
      { model: '*claude*', 'emote-set': 'b' },
    ];
    expect(resolveEmoteSet('claude-opus', ambiguous)).toEqual({ set: 'b', overlays: [], ambiguous: true });
  });

  test('carries overlays from the winning mapping', () => {
    const withOverlays: EmoteMapping[] = [
      { model: '*', 'emote-set': 'default' },
      { model: '*claude*', 'emote-set': 'exusiai', overlays: ['mature'] },
    ];
    expect(resolveEmoteSet('anthropic/claude-opus', withOverlays)).toEqual({
      set: 'exusiai',
      overlays: ['mature'],
      ambiguous: false,
    });
  });

  test('overlays apply on top of the default base set', () => {
    const onDefault: EmoteMapping[] = [{ model: '*', 'emote-set': 'default', overlays: ['mature'] }];
    expect(resolveEmoteSet('openai/gpt-5', onDefault)).toEqual({
      set: 'default',
      overlays: ['mature'],
      ambiguous: false,
    });
  });

  test('a later match without overlays clears earlier overlays', () => {
    const layered: EmoteMapping[] = [
      { model: '*', 'emote-set': 'default', overlays: ['mature'] },
      { model: '*gpt*', 'emote-set': 'robot' },
    ];
    expect(resolveEmoteSet('openai/gpt-5', layered)).toEqual({ set: 'robot', overlays: [], ambiguous: false });
  });
});

describe('isActivityState / classifyStateDirs', () => {
  test('recognizes activity states', () => {
    expect(isActivityState('think')).toBe(true);
    expect(isActivityState('happy')).toBe(false);
  });

  test('splits subdirs into activities and sorted emotions', () => {
    const out = classifyStateDirs(['talk', 'sad', 'idle', 'happy', 'tool']);
    expect(out.activities).toEqual(['talk', 'idle', 'tool']);
    expect(out.emotions).toEqual(['happy', 'sad']);
  });
});

describe('pickRandom', () => {
  test('returns null for an empty list', () => {
    expect(pickRandom([])).toBeNull();
  });

  test('uses the injected rng to index deterministically', () => {
    expect(pickRandom(['a', 'b', 'c'], () => 0)).toBe('a');
    expect(pickRandom(['a', 'b', 'c'], () => 0.99)).toBe('c');
  });
});

describe('pickWeighted', () => {
  test('returns null when empty or all non-positive', () => {
    expect(pickWeighted({})).toBeNull();
    expect(pickWeighted({ a: 0, b: -1 })).toBeNull();
  });

  test('selects proportional to weight via injected rng', () => {
    const weights = { a: 1, b: 3 };
    // total = 4; rng=0 -> first bucket (a), rng just under 1 -> b.
    expect(pickWeighted(weights, () => 0)).toBe('a');
    expect(pickWeighted(weights, () => 0.99)).toBe('b');
  });

  test('skips zero-weight entries', () => {
    expect(pickWeighted({ a: 0, b: 5 }, () => 0)).toBe('b');
  });
});
