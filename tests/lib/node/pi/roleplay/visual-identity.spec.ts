import { describe, expect, test } from 'vitest';
import {
  buildVisualContext,
  extractVisualIdentities,
  MAX_VISUAL_CONTEXT_CHARS,
  MAX_VISUAL_IDENTITY_CHARS,
  type VisualIdentity,
} from '../../../../../lib/node/pi/roleplay/visual-identity.ts';

function block(character: string, body: string): string {
  return `<visual-identity character="${character}">\n${body}\n</visual-identity>`;
}
function identity(character: string, body: string, priority = 0): VisualIdentity {
  return { character, body, priority, source: `source ${priority}` };
}

describe('visual identity extraction', () => {
  test('extracts only blocks from a huge persona, preserving prose and Unicode', () => {
    const result = extractVisualIdentities(
      `SECRET LORE\n${'unrelated persona '.repeat(20000)}\n${block('Mira', 'Silver hair. Green eyes.')}\n${block("Kal'tsit", '耳 and silver hair.')}`,
      'persona',
    );
    expect(result.identities.map((entry) => [entry.character, entry.body])).toEqual([
      ['Mira', 'Silver hair. Green eyes.'],
      ["Kal'tsit", '耳 and silver hair.'],
    ]);
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(result.identities)).not.toContain('SECRET LORE');
  });
  test('accepts CRLF and surrounding delimiter whitespace', () => {
    expect(
      extractVisualIdentities(
        '  <visual-identity character=" Mira ">\r\n green eyes \r\n  </visual-identity>\r\n',
        'sheet',
      ).identities[0]?.body,
    ).toBe('green eyes');
  });
  test.each([
    '<visual-identity character="Mira">\nunclosed',
    '<visual-identity>\nmissing name\n</visual-identity>',
    '<visual-identity character="">\nempty name\n</visual-identity>',
    '<visual-identity character="Mira" extra="x">\ninvalid attributes\n</visual-identity>',
    block('Mira', block('Other', 'nested')),
    '<visual-identity character="Mira">inline</visual-identity>',
    block('Mira', ''),
    block('Mira', 'x'.repeat(MAX_VISUAL_IDENTITY_CHARS + 1)),
    '</visual-identity>',
  ])('rejects malformed/oversized blocks without forwarding the source: %s', (text) => {
    const result = extractVisualIdentities(text, 'source');
    expect(result.identities).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  test('a malformed block does not swallow a later valid block', () => {
    expect(
      extractVisualIdentities(`${block('', 'bad')}\n${block('Mira', 'green eyes')}`, 'source').identities.map(
        (entry) => entry.character,
      ),
    ).toEqual(['Mira']);
  });
});

describe('visual continuity context', () => {
  const characters = [
    { name: 'Mira', aliases: ['M', 'mira-id'] },
    { name: 'Texas', aliases: [] },
  ];
  const defaults = {
    request: 'Draw Mira by the window',
    recentScene: 'Texas is off-screen.',
    characters,
    fallbackCharacters: ['Texas'],
  };
  test('explicit subjects and aliases exclude other character identities', () => {
    const result = buildVisualContext({
      ...defaults,
      request: 'Draw M',
      identities: [identity('Mira', 'silver hair'), identity('Texas', 'black hair')],
    });
    expect(result.context).toContain('silver hair');
    expect(result.context).not.toContain('black hair');
  });
  test('lore outranks sheets and personas; identical duplicates are silent', () => {
    const result = buildVisualContext({
      ...defaults,
      identities: [
        identity('Mira', 'persona hair'),
        identity('Mira', 'sheet hair', 1),
        identity('Mira', 'lore form', 2),
        identity('M', 'lore form', 2),
      ],
    });
    expect(result.context).toContain('lore form');
    expect(result.context).not.toContain('persona hair');
    expect(result.context).not.toContain('sheet hair');
    expect(result.warnings).toHaveLength(2);
  });
  test('equal-priority conflicts retain the first source deterministically', () => {
    const result = buildVisualContext({
      ...defaults,
      identities: [identity('Mira', 'first', 1), identity('Mira', 'second', 1)],
    });
    expect(result.context).toContain('first');
    expect(result.context).not.toContain('second');
  });
  test('pronouns use scene/declared characters as background, not a cast depiction list', () => {
    const result = buildVisualContext({
      ...defaults,
      request: 'Draw her smiling',
      recentScene: 'Mira puts on a borrowed coat.',
      fallbackCharacters: [],
      identities: [identity('Mira', 'silver hair; usual red jacket')],
    });
    expect(result.context).toContain('silver hair');
    expect(result.context).toContain('borrowed coat');
    expect(result.context).toContain('overrides usual clothing');
    expect(result.context).toContain('Do not depict everyone');
  });
  test('missing blocks diagnose rather than invent appearance', () => {
    const result = buildVisualContext({ ...defaults, identities: [] });
    expect(result.warnings).toEqual([expect.stringContaining('no visual-identity block for "Mira"')]);
  });
  test('whole identities have priority over dialogue, with a strict total budget', () => {
    const names = ['Mira', 'Texas', 'Other', 'Fourth'];
    const result = buildVisualContext({
      ...defaults,
      request: names.join(' and '),
      characters: names.map((name) => ({ name, aliases: [] })),
      identities: names.map((name) => identity(name, 'x'.repeat(1900))),
      recentScene: 'y'.repeat(20000),
    });
    expect(result.context.length).toBeLessThanOrEqual(MAX_VISUAL_CONTEXT_CHARS);
    expect(result.warnings.some((warning) => warning.includes('budget'))).toBe(true);
    expect(result.context).toContain('x'.repeat(1900));
  });
});
