/**
 * Tests for `lib/node/pi/persona/system-prompt.ts` - the pure composer
 * behind the persona extension's `before_agent_start` hook.
 */

import { describe, expect, test } from 'vitest';

import { composeSystemPrompt } from '../../../../../lib/node/pi/persona/system-prompt.ts';

describe('composeSystemPrompt', () => {
  test('no override + empty addendum → null (prompt left untouched)', () => {
    expect(composeSystemPrompt({ incoming: 'base prompt', addendum: '', override: undefined })).toBeNull();
  });

  test('no override + addendum → appends to incoming base with blank-line separator', () => {
    expect(composeSystemPrompt({ incoming: 'base prompt', addendum: 'persona body', override: undefined })).toBe(
      'base prompt\n\npersona body',
    );
  });

  test('trailing whitespace on incoming base is stripped before joining', () => {
    expect(composeSystemPrompt({ incoming: 'base prompt\n\n', addendum: 'persona body', override: undefined })).toBe(
      'base prompt\n\npersona body',
    );
  });

  test('override replaces the incoming base entirely', () => {
    expect(
      composeSystemPrompt({ incoming: 'pi default scaffolding', addendum: '', override: 'You are a journal.' }),
    ).toBe('You are a journal.');
  });

  test('override + addendum → addendum appended after the override base', () => {
    expect(
      composeSystemPrompt({ incoming: 'pi default', addendum: 'persona body', override: 'You are a journal.' }),
    ).toBe('You are a journal.\n\npersona body');
  });

  test('empty override + addendum → no leading blank line', () => {
    expect(composeSystemPrompt({ incoming: 'pi default', addendum: 'persona body', override: '' })).toBe(
      'persona body',
    );
  });

  test('empty override + empty addendum → empty string (override is intentional, not null)', () => {
    expect(composeSystemPrompt({ incoming: 'pi default', addendum: '', override: '' })).toBe('');
  });
});
