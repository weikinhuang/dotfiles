/**
 * Tests for lib/node/pi/btw/user-message.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  BTW_USAGE,
  buildSideQuestionUserContent,
  SIDE_QUESTION_DIRECTIVE,
} from '../../../../../lib/node/pi/btw/user-message.ts';

describe('buildSideQuestionUserContent', () => {
  test('wraps the question with the directive', () => {
    const out = buildSideQuestionUserContent('what did we edit?');

    expect(out).toContain(SIDE_QUESTION_DIRECTIVE);
    expect(out).toContain('what did we edit?');
    // Directive comes first, question after a blank line.
    expect(out?.indexOf(SIDE_QUESTION_DIRECTIVE)).toBe(0);
    expect(out).toBe(`${SIDE_QUESTION_DIRECTIVE}\n\nwhat did we edit?`);
  });

  test('trims surrounding whitespace from the question', () => {
    const out = buildSideQuestionUserContent('   foo?\n  ');

    expect(out).toBe(`${SIDE_QUESTION_DIRECTIVE}\n\nfoo?`);
  });

  test('empty / whitespace-only question returns undefined', () => {
    expect(buildSideQuestionUserContent('')).toBeUndefined();
    expect(buildSideQuestionUserContent('   ')).toBeUndefined();
    expect(buildSideQuestionUserContent('\n\t')).toBeUndefined();
  });

  test('preserves inner whitespace, including blank lines', () => {
    const out = buildSideQuestionUserContent('line one\n\nline two');

    expect(out).toBe(`${SIDE_QUESTION_DIRECTIVE}\n\nline one\n\nline two`);
  });

  test('directive mentions no-tools and no-history so the model knows what mode it is in', () => {
    expect(SIDE_QUESTION_DIRECTIVE.toLowerCase()).toContain('tool');
    expect(SIDE_QUESTION_DIRECTIVE.toLowerCase()).toContain('saved');
  });
});

describe('BTW_USAGE', () => {
  test('mentions the command name and gives an example', () => {
    expect(BTW_USAGE).toContain('/btw');
    expect(BTW_USAGE.toLowerCase()).toContain('usage');
    expect(BTW_USAGE).toContain('Example');
  });

  test('calls out the ephemeral-and-no-tools contract', () => {
    const lower = BTW_USAGE.toLowerCase();

    expect(lower).toContain('history');
    expect(lower).toContain('tools');
  });
});
