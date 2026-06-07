import { describe, expect, it } from 'vitest';

import { substituteMacros } from '../../../../../lib/node/pi/roleplay/macros.ts';

/** Deterministic rng: cycles through the given draws, repeating the last. */
function seqRng(...draws: number[]): () => number {
  let i = 0;
  return () => {
    const v = draws[Math.min(i, draws.length - 1)];
    i += 1;
    return v;
  };
}

const FIXED = new Date(2026, 5, 7, 9, 4, 0); // 2026-06-07 09:04, a Sunday

describe('substituteMacros', () => {
  it('returns text untouched when there are no macros', () => {
    expect(substituteMacros('plain prose, no braces')).toBe('plain prose, no braces');
    expect(substituteMacros('')).toBe('');
  });

  it('resolves {{user}} and {{char}} from context', () => {
    expect(substituteMacros('{{char}} waves at {{user}}.', { user: 'Doctor', char: 'Exusiai' })).toBe(
      'Exusiai waves at Doctor.',
    );
  });

  it('macro names are case-insensitive', () => {
    expect(substituteMacros('{{User}} and {{CHAR}}', { user: 'Doctor', char: 'Exusiai' })).toBe('Doctor and Exusiai');
  });

  it('leaves {{user}}/{{char}} literal when the value is missing or empty', () => {
    expect(substituteMacros('{{char}} sees {{user}}.', { char: 'Exusiai' })).toBe('Exusiai sees {{user}}.');
    expect(substituteMacros('{{user}}', { user: '' })).toBe('{{user}}');
  });

  it('leaves unknown macros untouched', () => {
    expect(substituteMacros('keep {{mystery}} and {{also_unknown:x}}')).toBe('keep {{mystery}} and {{also_unknown:x}}');
  });

  it('resolves {{time}} / {{date}} / {{weekday}} from ctx.now', () => {
    expect(substituteMacros('{{time}}', { now: FIXED })).toBe('09:04');
    expect(substituteMacros('{{date}}', { now: FIXED })).toBe('2026-06-07');
    expect(substituteMacros('{{weekday}}', { now: FIXED })).toBe('Sunday');
  });

  it('{{newline}} becomes a literal newline', () => {
    expect(substituteMacros('a{{newline}}b')).toBe('a\nb');
  });

  it('{{random:a,b,c}} picks by rng and trims options', () => {
    expect(substituteMacros('{{random:red, green , blue}}', { rng: seqRng(0) })).toBe('red');
    expect(substituteMacros('{{random:red, green , blue}}', { rng: seqRng(0.5) })).toBe('green');
    expect(substituteMacros('{{random:red, green , blue}}', { rng: seqRng(0.99) })).toBe('blue');
  });

  it('{{random}} with no options is left literal', () => {
    expect(substituteMacros('{{random:}}', { rng: seqRng(0) })).toBe('{{random:}}');
  });

  it('{{roll:NdM}} sums N dice; {{roll:M}} rolls one', () => {
    // rng 0 -> die value 1 for each face count.
    expect(substituteMacros('{{roll:2d6}}', { rng: seqRng(0, 0) })).toBe('2');
    // rng 0.99 on a d20 -> 20; single 0.99 on d6 -> 6. 20 + ... only one die here.
    expect(substituteMacros('{{roll:d20}}', { rng: seqRng(0.99) })).toBe('20');
    expect(substituteMacros('{{roll:20}}', { rng: seqRng(0) })).toBe('1');
    expect(substituteMacros('{{roll:3d4}}', { rng: seqRng(0, 0.5, 0.99) })).toBe(String(1 + 3 + 4));
  });

  it('malformed {{roll}} is left literal', () => {
    expect(substituteMacros('{{roll:abc}}')).toBe('{{roll:abc}}');
    expect(substituteMacros('{{roll:0d6}}')).toBe('{{roll:0d6}}');
  });

  it('resolves multiple macros in one pass and does not recurse into output', () => {
    expect(
      substituteMacros('{{char}}: "{{random:hi,yo}}" to {{user}} on {{weekday}}', {
        user: 'Doctor',
        char: 'Exusiai',
        now: FIXED,
        rng: seqRng(0),
      }),
    ).toBe('Exusiai: "hi" to Doctor on Sunday');
  });
});
