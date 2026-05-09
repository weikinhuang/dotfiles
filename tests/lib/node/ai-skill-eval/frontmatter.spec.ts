// Tests for lib/node/ai-skill-eval/frontmatter.ts.

import { describe, expect, test } from 'vitest';

import { joinFrontmatterScalar } from '../../../../lib/node/ai-skill-eval/frontmatter.ts';

describe('joinFrontmatterScalar', () => {
  test('joins plain fragments with a single space', () => {
    expect(joinFrontmatterScalar(['hello', 'world'])).toBe('hello world');
  });

  test('strips surrounding double quotes and unescapes \\" / \\\\', () => {
    expect(joinFrontmatterScalar(['"a \\"quoted\\" path\\\\here"'])).toBe('a "quoted" path\\here');
  });

  test("strips surrounding single quotes and unescapes ''", () => {
    expect(joinFrontmatterScalar(["'it''s fine'"])).toBe("it's fine");
  });

  test('strips the `>-` folded block scalar indicator (regression for validate false-positive)', () => {
    expect(joinFrontmatterScalar(['>-', 'WHAT: something', 'WHEN: anything', 'DO-NOT: nothing'])).toBe(
      'WHAT: something WHEN: anything DO-NOT: nothing',
    );
  });

  test('strips a bare `|` literal block indicator', () => {
    expect(joinFrontmatterScalar(['|', 'line-a', 'line-b'])).toBe('line-a line-b');
  });

  test('strips `|-` / `>+` / `|2` style indicators with chomping or indent tags', () => {
    expect(joinFrontmatterScalar(['|-', 'body'])).toBe('body');
    expect(joinFrontmatterScalar(['>+', 'body'])).toBe('body');
    expect(joinFrontmatterScalar(['|2', 'body'])).toBe('body');
    expect(joinFrontmatterScalar(['>-2', 'body'])).toBe('body');
  });

  test('empty fragments yield the empty string', () => {
    expect(joinFrontmatterScalar([])).toBe('');
  });
});
