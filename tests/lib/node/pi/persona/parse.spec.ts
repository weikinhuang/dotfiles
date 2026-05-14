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

  test('empty frontmatter → null + warning', () => {
    const { result, warnings } = run({});

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/missing or empty frontmatter/);
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
});
