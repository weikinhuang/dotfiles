/**
 * Tests for `lib/node/pi/mode/parse.ts`.
 *
 * The frontmatter parser is injected; we drive it with stubs so we
 * can exercise specific FM shapes without depending on pi's parser.
 */

import { describe, expect, test } from 'vitest';

import {
  type PersonaWarning,
  parsePersonaFile,
  type ParsePersonaOptions,
} from '../../../../../lib/node/pi/persona/parse.ts';

const KNOWN_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'grep']);

function makeParser(frontmatter: Record<string, unknown>, body = ''): ParsePersonaOptions['parseFrontmatter'] {
  return () => ({ frontmatter, body });
}

function run(
  fm: Record<string, unknown>,
  body = '',
  path = '/repo/config/pi/modes/sample.md',
): { result: ReturnType<typeof parsePersonaFile>; warnings: PersonaWarning[] } {
  const warnings: PersonaWarning[] = [];
  const result = parsePersonaFile({
    path,
    source: 'project',
    raw: '---\n---\n',
    knownToolNames: KNOWN_TOOLS,
    parseFrontmatter: makeParser(fm, body),
    warnings,
  });
  return { result, warnings };
}

describe('parsePersonaFile', () => {
  test('standalone mode with tools + body parses cleanly', () => {
    const body = '# heading\n\nbody markdown.';
    const { result, warnings } = run({ name: 'plan', description: 'planning', tools: ['read', 'write'] }, body);

    expect(warnings).toEqual([]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('plan');
    expect(result?.tools).toEqual(['read', 'write']);
    expect(result?.body).toBe(body);
    expect(result?.agent).toBeUndefined();
  });

  test('mode with `agent:` ref and no `tools` parses cleanly (deferred to inheritance)', () => {
    const { result, warnings } = run({ name: 'plan-mode', agent: 'plan' });

    expect(warnings).toEqual([]);
    expect(result).not.toBeNull();
    expect(result?.agent).toBe('plan');
    expect(result?.tools).toBeUndefined();
  });

  test('empty frontmatter → null silently (no warning)', () => {
    const { result, warnings } = run({});

    expect(result).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  test('unknown FM key is tolerated silently', () => {
    const { result, warnings } = run({ name: 'm', foo: 'bar' });

    expect(warnings).toEqual([]);
    expect(result?.name).toBe('m');
  });

  test('bad `tools` shape (number) → warning, mode returned without tools', () => {
    const { result, warnings } = run({ name: 'm', tools: 42 });

    expect(result).not.toBeNull();
    expect(result?.tools).toBeUndefined();
    expect(warnings.some((w) => w.reason.includes('tools'))).toBe(true);
  });

  test('bad `tools` shape (object) → warning, mode returned without tools', () => {
    const { result, warnings } = run({ name: 'm', tools: { read: true } });

    expect(result).not.toBeNull();
    expect(result?.tools).toBeUndefined();
    expect(warnings.some((w) => w.reason.includes('tools'))).toBe(true);
  });

  test('unknown tool dropped with warning, valid names survive', () => {
    const { result, warnings } = run({ name: 'm', tools: ['read', 'totally-fake', 'write'] });

    expect(result?.tools).toEqual(['read', 'write']);
    expect(warnings.some((w) => w.reason.includes('totally-fake'))).toBe(true);
  });

  test('name defaults to filename stem when missing from FM', () => {
    const { result, warnings } = run({ description: 'd' }, '', '/repo/config/pi/modes/explore.md');

    expect(warnings).toEqual([]);
    expect(result?.name).toBe('explore');
  });

  test('body markdown preserved verbatim', () => {
    const body = '# Title\n\n- bullet 1\n- bullet 2\n\n```ts\nconst x = 1;\n```\n';
    const { result } = run({ name: 'm' }, body);

    expect(result?.body).toBe(body);
  });

  test('requestOptions absent → undefined, no warnings', () => {
    const { result, warnings } = run({ name: 'm' });

    expect(warnings).toEqual([]);
    expect(result?.requestOptions).toBeUndefined();
  });

  test('roleplay absent → false, cast undefined, no warnings', () => {
    const { result, warnings } = run({ name: 'm' });

    expect(warnings).toEqual([]);
    expect(result?.roleplay).toBe(false);
    expect(result?.cast).toBeUndefined();
  });

  test('roleplay true + cast → parsed through', () => {
    const { result, warnings } = run({ name: 'm', roleplay: true, cast: 'penguin-logistics' });

    expect(warnings).toEqual([]);
    expect(result?.roleplay).toBe(true);
    expect(result?.cast).toBe('penguin-logistics');
  });

  test('non-boolean roleplay → warning, defaults to false', () => {
    const { result, warnings } = run({ name: 'm', roleplay: 'yes' });

    expect(result?.roleplay).toBe(false);
    expect(warnings.some((w) => w.reason.includes('`roleplay` must be a boolean'))).toBe(true);
  });

  test('authorNote + authorNoteDepth parsed through', () => {
    const { result, warnings } = run({ name: 'm', roleplay: true, authorNote: 'stay in voice', authorNoteDepth: 2 });

    expect(warnings).toEqual([]);
    expect(result?.authorNote).toBe('stay in voice');
    expect(result?.authorNoteDepth).toBe(2);
  });

  test('authorNote absent → undefined; bad authorNoteDepth → warning', () => {
    const absent = run({ name: 'm' });
    expect(absent.result?.authorNote).toBeUndefined();
    expect(absent.result?.authorNoteDepth).toBeUndefined();

    const bad = run({ name: 'm', authorNoteDepth: -3 });
    expect(bad.result?.authorNoteDepth).toBeUndefined();
    expect(bad.warnings.some((w) => w.reason.includes('`authorNoteDepth` must be a non-negative number'))).toBe(true);
  });

  test('characters / pov / openers parsed through', () => {
    const { result, warnings } = run({
      name: 'm',
      roleplay: true,
      characters: ['Exusiai', 'Texas'],
      pov: 'Doctor',
      openers: ['Hello there.', 'Welcome back.'],
    });
    expect(warnings).toEqual([]);
    expect(result?.characters).toEqual(['Exusiai', 'Texas']);
    expect(result?.pov).toBe('Doctor');
    expect(result?.openers).toEqual(['Hello there.', 'Welcome back.']);
  });

  test('characters absent → undefined; non-array → warning; non-string entries dropped', () => {
    const absent = run({ name: 'm' });
    expect(absent.result?.characters).toBeUndefined();
    expect(absent.result?.openers).toBeUndefined();

    const bad = run({ name: 'm', characters: 'Exusiai' });
    expect(bad.result?.characters).toBeUndefined();
    expect(bad.warnings.some((w) => w.reason.includes('`characters` must be an array of strings'))).toBe(true);

    const mixed = run({ name: 'm', openers: ['ok', 42] });
    expect(mixed.result?.openers).toEqual(['ok']);
    expect(mixed.warnings.some((w) => w.reason.includes('`openers` entry'))).toBe(true);
  });

  test('requestOptions object → forwarded verbatim', () => {
    const { result, warnings } = run({
      name: 'm',
      requestOptions: {
        apis: ['openai-completions'],
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: true },
      },
    });

    expect(warnings).toEqual([]);
    expect(result?.requestOptions).toEqual({
      apis: ['openai-completions'],
      temperature: 0.7,
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  test('requestOptions non-object → warning, persona still returned', () => {
    const { result, warnings } = run({ name: 'm', requestOptions: 'temperature=0.7' });

    expect(result).not.toBeNull();
    expect(result?.requestOptions).toBeUndefined();
    expect(warnings.some((w) => w.reason.includes('requestOptions'))).toBe(true);
  });

  test('model: valid provider/id and `inherit` pass through', () => {
    expect(run({ name: 'm', model: 'anthropic/claude-opus' }).result?.model).toBe('anthropic/claude-opus');
    expect(run({ name: 'm', model: 'inherit' }).result?.model).toBe('inherit');
  });

  test('model: validated via the shared parser - a bare `/` is no longer enough', () => {
    // The old `includes("/")` check accepted these; the shared spec parser
    // rejects a missing provider or model id.
    for (const bad of ['provider/', '/model', 'noslash']) {
      const { result, warnings } = run({ name: 'm', model: bad });
      expect(result).not.toBeNull();
      expect(result?.model).toBeUndefined();
      expect(warnings.some((w) => w.reason.includes('invalid model'))).toBe(true);
    }
  });

  test('systemPromptOverride absent → undefined, no warnings', () => {
    const { result, warnings } = run({ name: 'm' });

    expect(warnings).toEqual([]);
    expect(result?.systemPromptOverride).toBeUndefined();
  });

  test('systemPromptOverride string → trimmed and preserved', () => {
    const { result, warnings } = run({ name: 'm', systemPromptOverride: '  You are a journal.  ' });

    expect(warnings).toEqual([]);
    expect(result?.systemPromptOverride).toBe('You are a journal.');
  });

  test('whitespace-only systemPromptOverride → undefined (treated as unset)', () => {
    const { result } = run({ name: 'm', systemPromptOverride: '   \n  ' });

    expect(result?.systemPromptOverride).toBeUndefined();
  });

  test('non-string systemPromptOverride → undefined (no throw)', () => {
    const { result } = run({ name: 'm', systemPromptOverride: 42 });

    expect(result).not.toBeNull();
    expect(result?.systemPromptOverride).toBeUndefined();
  });
});
