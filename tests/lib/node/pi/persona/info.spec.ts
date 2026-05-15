/**
 * Tests for `lib/node/pi/persona/info.ts` \u2014 pure formatters for the
 * persona CLI flags `--persona-info`, `--list-personas`,
 * `--validate-personas`.
 */

import { describe, expect, test } from 'vitest';

import {
  formatPersonaInfoLines,
  formatPersonaListLines,
  formatPersonaValidate,
  type PersonaInfoInput,
  type PersonaListItem,
} from '../../../../../lib/node/pi/persona/info.ts';

// \u2500\u2500 formatPersonaInfoLines \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

describe('formatPersonaInfoLines', () => {
  const baseInput = (overrides: Partial<PersonaInfoInput> = {}): PersonaInfoInput => ({
    name: 'chat',
    source: 'shipped',
    inheritedFrom: null,
    tools: ['read', 'bash'],
    resolvedWriteRoots: [],
    bashAllow: ['rg *'],
    bashDeny: [],
    model: null,
    thinkingLevel: null,
    requestOptions: undefined,
    bodyLength: 1234,
    promptLength: 1500,
    ...overrides,
  });

  test('renders all 12 lines in the expected order', () => {
    const lines = formatPersonaInfoLines(baseInput());

    expect(lines).toEqual([
      'persona "chat"',
      '  source:        shipped',
      '  inheritedFrom: (standalone)',
      '  tools:         read, bash',
      '  writeRoots:    (none — writes disallowed)',
      '  bashAllow:     rg *',
      '  bashDeny:      (empty)',
      '  model:         (inherit)',
      '  thinkingLevel: (inherit)',
      '  requestOptions: (none)',
      '  body length:   1234 chars',
      '  prompt length: 1500 chars',
    ]);
  });

  test('inheritedFrom non-null is rendered raw (no decoration)', () => {
    const lines = formatPersonaInfoLines(baseInput({ inheritedFrom: 'plan' }));

    expect(lines.find((l) => l.startsWith('  inheritedFrom:'))).toBe('  inheritedFrom: plan');
  });

  test('tools undefined → (inherit / none)', () => {
    const lines = formatPersonaInfoLines(baseInput({ tools: undefined }));

    expect(lines.find((l) => l.startsWith('  tools:'))).toBe('  tools:         (inherit / none)');
  });

  test('tools empty array → (inherit / none)', () => {
    const lines = formatPersonaInfoLines(baseInput({ tools: [] }));

    expect(lines.find((l) => l.startsWith('  tools:'))).toBe('  tools:         (inherit / none)');
  });

  test('non-empty resolvedWriteRoots are joined with ", "', () => {
    const lines = formatPersonaInfoLines(baseInput({ resolvedWriteRoots: ['/repo/plans/', '/home/u/journal/'] }));

    expect(lines.find((l) => l.startsWith('  writeRoots:'))).toBe('  writeRoots:    /repo/plans/, /home/u/journal/');
  });

  test('bashAllow / bashDeny empty → (empty)', () => {
    const lines = formatPersonaInfoLines(baseInput({ bashAllow: [], bashDeny: [] }));

    expect(lines.find((l) => l.startsWith('  bashAllow:'))).toBe('  bashAllow:     (empty)');
    expect(lines.find((l) => l.startsWith('  bashDeny:'))).toBe('  bashDeny:      (empty)');
  });

  test('model + thinkingLevel non-null render raw', () => {
    const lines = formatPersonaInfoLines(baseInput({ model: 'anthropic/claude-opus-4', thinkingLevel: 'high' }));

    expect(lines.find((l) => l.startsWith('  model:'))).toBe('  model:         anthropic/claude-opus-4');
    expect(lines.find((l) => l.startsWith('  thinkingLevel:'))).toBe('  thinkingLevel: high');
  });

  test('requestOptions non-empty rendered as JSON one-liner', () => {
    const lines = formatPersonaInfoLines(baseInput({ requestOptions: { temperature: 0.42, top_p: 0.77 } }));

    expect(lines.find((l) => l.startsWith('  requestOptions:'))).toBe(
      '  requestOptions: {"temperature":0.42,"top_p":0.77}',
    );
  });

  test('requestOptions empty object → (none)', () => {
    const lines = formatPersonaInfoLines(baseInput({ requestOptions: {} }));

    expect(lines.find((l) => l.startsWith('  requestOptions:'))).toBe('  requestOptions: (none)');
  });
});

// \u2500\u2500 formatPersonaListLines \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

describe('formatPersonaListLines', () => {
  test('empty input → single fallback line', () => {
    expect(formatPersonaListLines([])).toEqual(['(no personas loaded)']);
  });

  test('one persona, none active', () => {
    const items: PersonaListItem[] = [{ name: 'chat', source: 'shipped', description: 'Long-form Q&A' }];

    expect(formatPersonaListLines(items)).toEqual(['  chat  [shipped] Long-form Q&A']);
  });

  test('active marker renders as `* `', () => {
    const items: PersonaListItem[] = [{ name: 'chat', source: 'shipped', description: 'Long-form Q&A', active: true }];

    expect(formatPersonaListLines(items)).toEqual(['* chat  [shipped] Long-form Q&A']);
  });

  test('name column padded to widest entry so source tags align', () => {
    const items: PersonaListItem[] = [
      { name: 'chat', source: 'shipped', description: 'one' },
      { name: 'exusiai-buddy', source: 'user', description: 'two' },
    ];
    const lines = formatPersonaListLines(items);

    expect(lines).toEqual(['  chat           [shipped] one', '  exusiai-buddy  [user] two']);
  });

  test('missing description → no trailing space-em-dash', () => {
    const items: PersonaListItem[] = [{ name: 'chat', source: 'shipped' }];

    expect(formatPersonaListLines(items)).toEqual(['  chat  [shipped]']);
  });
});

// \u2500\u2500 formatPersonaValidate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

describe('formatPersonaValidate', () => {
  test('no warnings → exit 0 + OK summary', () => {
    expect(formatPersonaValidate({ warnings: [], totalLoaded: 5 })).toEqual({
      exitCode: 0,
      lines: ['OK: 5 persona(s) validated'],
    });
  });

  test('zero loaded + zero warnings → still exit 0 (vacuous OK)', () => {
    expect(formatPersonaValidate({ warnings: [], totalLoaded: 0 })).toEqual({
      exitCode: 0,
      lines: ['OK: 0 persona(s) validated'],
    });
  });

  test('warnings → exit 1 + per-line `<path>: <reason>` + summary', () => {
    const out = formatPersonaValidate({
      warnings: [
        { path: '/p/chat.md', reason: 'unknown tool: ai-fetch-web' },
        { path: '/p/exusiai.md', reason: 'agent "missing" not found' },
      ],
      totalLoaded: 4,
    });

    expect(out.exitCode).toBe(1);
    expect(out.lines).toEqual([
      '/p/chat.md: unknown tool: ai-fetch-web',
      '/p/exusiai.md: agent "missing" not found',
      '2 warning(s); 4 persona(s) loaded',
    ]);
  });
});
