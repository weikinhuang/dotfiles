import { describe, expect, test } from 'vitest';

import {
  literalPrefix,
  parseShellPermissions,
  ShellPermissionsError,
  validateShellPermissions,
} from '../../../../lib/node/agents-config/shell-permissions.ts';

function problemsOf(value: unknown): string[] {
  try {
    validateShellPermissions(value);
  } catch (err) {
    if (err instanceof ShellPermissionsError) return err.problems;
    throw err;
  }
  return [];
}

describe('parseShellPermissions', () => {
  test('parses JSONC with comments and trailing commas', () => {
    const list = parseShellPermissions(`// header
{
  "entries": [
    { "pattern": "git status *", "tier": "shared" }, // trailing comment
    { "pattern": "cp *", "tier": "extras", "note": "writes files", },
    { "pattern": "yq *", "tier": "shared", "except": ["yq -i *"], "copilot": "broader", "codex": "broader" },
  ],
}`);
    expect(list.entries).toEqual([
      { pattern: 'git status *', tier: 'shared' },
      { pattern: 'cp *', tier: 'extras', note: 'writes files' },
      { pattern: 'yq *', tier: 'shared', except: ['yq -i *'], copilot: 'broader', codex: 'broader' },
    ]);
  });
});

describe('validateShellPermissions', () => {
  test('rejects a non-object top level', () => {
    expect(problemsOf([])).toEqual(['top level must be an object with an "entries" array']);
  });

  test('collects every problem with the entry index and pattern', () => {
    const problems = problemsOf({
      entries: [
        { pattern: 'ls *', tier: 'everyone' },
        { pattern: ' ls', tier: 'shared' },
        { pattern: 'a  b', tier: 'shared' },
        { pattern: 'x *', tier: 'shared', except: [] },
        { pattern: 'y *', tier: 'shared', except: ['y *'] },
        { pattern: 'z *', tier: 'shared', note: 'two\nlines' },
        { pattern: 'w *', tier: 'shared', copilot: false, codex: 'readonly' },
        { pattern: 'v *', tier: 'shared', extra: 1 },
        'nope',
      ],
      other: true,
    });
    expect(problems).toEqual([
      'top level: unknown key "other"',
      'entry 0 (ls *): "tier" must be one of shared, extras',
      'entry 1 ( ls): "pattern" must be a non-empty string without leading, trailing, or doubled whitespace',
      'entry 2 (a  b): "pattern" must be a non-empty string without leading, trailing, or doubled whitespace',
      'entry 3 (x *): "except" must be a non-empty array of glob strings',
      'entry 4 (y *): "except" repeats the pattern itself',
      'entry 5 (z *): "note" must be a non-empty single-line string',
      'entry 6 (w *): "copilot" must be one of readonly, broader',
      'entry 6 (w *): "codex" must be one of broader',
      'entry 7 (v *): unknown key "extra"',
      'entry 8: expected an object',
    ]);
  });

  test('rejects duplicate patterns', () => {
    expect(
      problemsOf({
        entries: [
          { pattern: 'ls *', tier: 'shared' },
          { pattern: 'ls *', tier: 'extras' },
        ],
      }),
    ).toEqual(['entry 1 (ls *): duplicate pattern']);
  });

  test('error message lists the problems', () => {
    expect(() => validateShellPermissions({ entries: [{ pattern: 'ls *' }] })).toThrow(
      /invalid shell permission list:\n {2}entry 0 \(ls \*\): "tier" must be one of/,
    );
  });
});

describe('literalPrefix', () => {
  test.each([
    ['git status *', { words: ['git', 'status'], trailingStar: true }],
    ['pwd', { words: ['pwd'], trailingStar: false }],
    ['npm --version', { words: ['npm', '--version'], trailingStar: false }],
    ['docker stats --no-stream *', { words: ['docker', 'stats', '--no-stream'], trailingStar: true }],
  ])('%s', (pattern, expected) => {
    expect(literalPrefix(pattern)).toEqual(expected);
  });

  test.each(['git log*', 'yq * -i *', 'kubectl get *,secret*', '*', 'ls ?'])('no literal prefix: %s', (pattern) => {
    expect(literalPrefix(pattern)).toBeUndefined();
  });
});
