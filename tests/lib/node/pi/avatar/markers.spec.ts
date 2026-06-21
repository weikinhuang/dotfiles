/**
 * Tests for lib/node/pi/avatar/markers.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  appendEmotePrompt,
  buildEmotePromptAddendum,
  EMOTE_PROMPT_HEADING,
  parseEmoteMarkers,
  stripEmoteMarkers,
} from '../../../../../lib/node/pi/avatar/markers.ts';

describe('parseEmoteMarkers', () => {
  test('strips a marker and reports the emotion', () => {
    expect(parseEmoteMarkers('Hi [emote:happy] there')).toEqual({ text: 'Hi  there', emotes: ['happy'] });
  });

  test('collects multiple markers in order, lowercased', () => {
    const out = parseEmoteMarkers('[emote:Happy]a[emote:SAD]b');
    expect(out.text).toBe('ab');
    expect(out.emotes).toEqual(['happy', 'sad']);
  });

  test('accepts digits, hyphen and underscore in names', () => {
    expect(parseEmoteMarkers('[emote:super-happy_2]').emotes).toEqual(['super-happy_2']);
  });

  test('leaves a partial marker visible (mid-stream)', () => {
    expect(parseEmoteMarkers('typing [emote:hap')).toEqual({ text: 'typing [emote:hap', emotes: [] });
  });

  test('does not match an empty name', () => {
    expect(parseEmoteMarkers('[emote:]').emotes).toEqual([]);
    expect(parseEmoteMarkers('[emote:]').text).toBe('[emote:]');
  });

  test('passes through plain text and empty input', () => {
    expect(parseEmoteMarkers('no markers')).toEqual({ text: 'no markers', emotes: [] });
    expect(parseEmoteMarkers('')).toEqual({ text: '', emotes: [] });
  });

  test('does not collide with markdown links', () => {
    const md = '[click](https://x.example) and [^1]';
    expect(parseEmoteMarkers(md)).toEqual({ text: md, emotes: [] });
  });

  test('a marker inside an inline code span is left literal and not collected', () => {
    const src = 'set it with `[emote:happy]` inline';
    expect(parseEmoteMarkers(src)).toEqual({ text: src, emotes: [] });
  });

  test('a marker inside a fenced block is left literal; a prose marker still fires', () => {
    const src = '[emote:happy] see\n```\n[emote:sad] in code\n```\ndone';
    const out = parseEmoteMarkers(src);
    expect(out.emotes).toEqual(['happy']);
    expect(out.text).toBe(' see\n```\n[emote:sad] in code\n```\ndone');
  });

  test('a prose marker after an inline-code literal still fires', () => {
    const out = parseEmoteMarkers('show `[emote:sad]` then [emote:happy] now');
    expect(out.emotes).toEqual(['happy']);
    expect(out.text).toBe('show `[emote:sad]` then  now');
  });

  test('a marker in an unterminated inline-code span (mid-stream) stays literal', () => {
    const src = 'still typing `[emote:happy]';
    expect(parseEmoteMarkers(src)).toEqual({ text: src, emotes: [] });
  });
});

describe('stripEmoteMarkers', () => {
  test('removes all complete markers', () => {
    expect(stripEmoteMarkers('a[emote:happy]b[emote:sad]c')).toBe('abc');
  });

  test('leaves partial markers and empty input untouched', () => {
    expect(stripEmoteMarkers('a[emote:ha')).toBe('a[emote:ha');
    expect(stripEmoteMarkers('')).toBe('');
  });

  test('leaves markers inside code regions literal, strips prose markers', () => {
    expect(stripEmoteMarkers('use `[emote:happy]` here')).toBe('use `[emote:happy]` here');
    expect(stripEmoteMarkers('```\n[emote:sad]\n```\n[emote:happy] hi')).toBe('```\n[emote:sad]\n```\n hi');
  });
});

describe('buildEmotePromptAddendum / appendEmotePrompt', () => {
  test('addendum lists the available emotions under the heading', () => {
    const addendum = buildEmotePromptAddendum({ emotions: ['happy', 'sad'] });
    expect(addendum.startsWith(EMOTE_PROMPT_HEADING)).toBe(true);
    expect(addendum).toContain('Available emotions: happy, sad.');
  });

  test('addendum handles an empty emotion set gracefully', () => {
    expect(buildEmotePromptAddendum({ emotions: [] })).toContain('(none available in the active set)');
  });

  test('append adds the addendum once and is idempotent', () => {
    const addendum = buildEmotePromptAddendum({ emotions: ['happy'] });
    const once = appendEmotePrompt('Base prompt.', addendum);
    expect(once).toContain('Base prompt.');
    expect(once).toContain(EMOTE_PROMPT_HEADING);
    expect(appendEmotePrompt(once, addendum)).toBe(once);
  });

  test('append returns the addendum alone for an empty base', () => {
    const addendum = buildEmotePromptAddendum({ emotions: ['happy'] });
    expect(appendEmotePrompt('', addendum)).toBe(addendum);
  });
});
