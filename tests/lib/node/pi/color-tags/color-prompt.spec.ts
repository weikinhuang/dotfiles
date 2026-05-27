/**
 * Tests for lib/node/pi/color-tags/color-prompt.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  appendColorPrompt,
  buildColorPromptAddendum,
  COLOR_PROMPT_HEADING,
} from '../../../../../lib/node/pi/color-tags/color-prompt.ts';

describe('buildColorPromptAddendum', () => {
  test('starts with the documented heading', () => {
    const out = buildColorPromptAddendum({ themeTokens: ['accent', 'success'] });
    expect(out.startsWith(`${COLOR_PROMPT_HEADING}\n`)).toBe(true);
  });

  test('teaches the bracket syntax with three example shapes', () => {
    const out = buildColorPromptAddendum({ themeTokens: ['success'] });
    expect(out).toContain('[c:red]error[/c]');
    expect(out).toContain('[c:#ffaa00]warning[/c]');
    expect(out).toContain('[c:success]ok[/c]');
  });

  test('mentions the close-tag requirement and no-nesting rule', () => {
    const out = buildColorPromptAddendum({ themeTokens: [] });
    expect(out).toContain('[/c]');
    expect(out).toMatch(/(?:do not nest|do not\s+nest|do NOT nest)/i);
  });

  test('explicitly tells the model NOT to convert tags to escape sequences itself', () => {
    // This guardrail is what stopped Claude opus-4-7 from auto-
    // emitting raw \x1b[…m bytes (the failure mode that killed the
    // earlier guillemet form).
    const out = buildColorPromptAddendum({ themeTokens: [] });
    expect(out).toMatch(/do not convert/i);
    expect(out).toMatch(/character-for-character|emit.*plain text|runtime/i);
  });

  test('lists the named-16 vocabulary', () => {
    const out = buildColorPromptAddendum({ themeTokens: [] });
    expect(out).toContain('red');
    expect(out).toContain('bright-cyan');
    expect(out).toContain('gray');
  });

  test('lists the supplied theme tokens', () => {
    const out = buildColorPromptAddendum({
      themeTokens: ['accent', 'success', 'mdHeading', 'bashMode'],
    });
    expect(out).toContain('accent');
    expect(out).toContain('success');
    expect(out).toContain('mdHeading');
    expect(out).toContain('bashMode');
  });

  test('renders an empty theme-token list gracefully', () => {
    const out = buildColorPromptAddendum({ themeTokens: [] });
    expect(out).toContain('Theme tokens');
  });

  test('reminds the model to use color sparingly and inline only', () => {
    const out = buildColorPromptAddendum({ themeTokens: [] });
    expect(out).toMatch(/sparingly/i);
    expect(out).toMatch(/inline/i);
  });
});

describe('appendColorPrompt', () => {
  test('appends with a blank-line separator on a non-empty base', () => {
    const out = appendColorPrompt('Base prompt.', 'ADDENDUM');
    expect(out).toBe('Base prompt.\n\nADDENDUM');
  });

  test('returns the addendum alone when base is empty', () => {
    expect(appendColorPrompt('', 'ADDENDUM')).toBe('ADDENDUM');
    expect(appendColorPrompt('   \n  ', 'ADDENDUM')).toBe('ADDENDUM');
  });

  test('idempotent: skips when the heading is already present', () => {
    const base = `Base prompt.\n\n${COLOR_PROMPT_HEADING}\n\nold body`;
    expect(appendColorPrompt(base, 'ADDENDUM')).toBe(base);
  });

  test('strips trailing whitespace before joining', () => {
    expect(appendColorPrompt('Base prompt.\n\n', 'ADDENDUM')).toBe('Base prompt.\n\nADDENDUM');
  });
});
