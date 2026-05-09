// SPDX-License-Identifier: MIT
import { describe, expect, test } from 'vitest';

import {
  blindHistoryEntry,
  buildImproverPrompt,
  buildShortenPrompt,
  MAX_DESCRIPTION_CHARS,
  parseNewDescription,
  type ImproverHistoryEntry,
  type ImproverTriggerResult,
} from '../../../../lib/node/ai-skill-eval/improver.ts';

function result(
  query: string,
  shouldTrigger: boolean,
  triggers: number,
  runs: number,
  pass: boolean,
): ImproverTriggerResult {
  return { query, should_trigger: shouldTrigger, triggers, runs, pass };
}

describe('buildImproverPrompt', () => {
  const base = {
    skillName: 'alpha',
    skillContent: 'SKILL body text',
    currentDescription: 'old description',
    trainResults: [result('use alpha plz', true, 0, 3, false), result('unrelated pls', false, 2, 3, false)],
    trainSummary: { passed: 0, total: 4 },
    testSummary: { passed: 1, total: 2 },
    blindedHistory: [] as ImproverHistoryEntry[],
  };

  test('includes both failure categories in the scores summary', () => {
    const p = buildImproverPrompt(base);

    expect(p).toContain('FAILED TO TRIGGER');
    expect(p).toContain('"use alpha plz"');
    expect(p).toContain('(triggered 0/3 times)');
    expect(p).toContain('FALSE TRIGGERS');
    expect(p).toContain('"unrelated pls"');
    expect(p).toContain('(triggered 2/3 times)');
  });

  test('includes the train + test score header', () => {
    const p = buildImproverPrompt(base);

    expect(p).toContain('Train: 0/4, Test: 1/2');
  });

  test('omits the Test: suffix when no test set exists', () => {
    const p = buildImproverPrompt({ ...base, testSummary: null });

    expect(p).toContain('Train: 0/4');
    expect(p).not.toContain('Test:');
  });

  test('embeds the SKILL content verbatim inside <skill_content>', () => {
    const p = buildImproverPrompt(base);

    expect(p).toContain('<skill_content>\nSKILL body text\n</skill_content>');
  });

  test('renders blinded history attempts when provided', () => {
    const history: ImproverHistoryEntry[] = [
      {
        iteration: 1,
        description: 'first try',
        train_passed: 1,
        train_total: 4,
        train_results: [result('q one', true, 0, 3, false)],
      },
    ];
    const p = buildImproverPrompt({ ...base, blindedHistory: history });

    expect(p).toContain('PREVIOUS ATTEMPTS');
    expect(p).toContain('<attempt train=1/4>');
    expect(p).toContain('Description: "first try"');
    expect(p).toContain('[FAIL] "q one"');
  });

  test('mentions the 1024-char hard limit', () => {
    const p = buildImproverPrompt(base);

    expect(p).toContain('1024-character hard limit');
  });

  test('asks for the answer inside <new_description> tags', () => {
    const p = buildImproverPrompt(base);

    expect(p).toContain('<new_description>');
  });
});

describe('blindHistoryEntry', () => {
  test('strips any key starting with "test_"', () => {
    const input = {
      iteration: 2,
      description: 'x',
      train_passed: 3,
      test_passed: 5,
      test_total: 10,
      test_results: [{ query: 'q', should_trigger: true, triggers: 3, runs: 3, pass: true }],
    };
    const out = blindHistoryEntry(input);

    expect(out).toHaveProperty('train_passed', 3);
    expect(out).not.toHaveProperty('test_passed');
    expect(out).not.toHaveProperty('test_total');
    expect(out).not.toHaveProperty('test_results');
  });

  test('does not mutate the source entry', () => {
    const input = { description: 'y', test_passed: 1 };
    blindHistoryEntry(input);

    expect(input).toHaveProperty('test_passed', 1);
  });
});

describe('parseNewDescription', () => {
  test('extracts content between <new_description> tags', () => {
    expect(parseNewDescription('garble <new_description>Hello there.</new_description> tail')).toBe('Hello there.');
  });

  test('strips one layer of surrounding double quotes', () => {
    expect(parseNewDescription('<new_description>"quoted value"</new_description>')).toBe('quoted value');
  });

  test('strips one layer of surrounding single quotes', () => {
    expect(parseNewDescription("<new_description>'quoted'</new_description>")).toBe('quoted');
  });

  test('falls back to the full trimmed text when tags are absent', () => {
    expect(parseNewDescription('  just a bare response  ')).toBe('just a bare response');
  });

  test('preserves multi-line content inside tags', () => {
    const input = '<new_description>line 1\nline 2</new_description>';

    expect(parseNewDescription(input)).toBe('line 1\nline 2');
  });
});

describe('buildShortenPrompt', () => {
  test('quotes the over-long description and states the length', () => {
    const over = 'x'.repeat(MAX_DESCRIPTION_CHARS + 10);
    const p = buildShortenPrompt('ORIG_PROMPT', over);

    expect(p).toContain('ORIG_PROMPT');
    expect(p).toContain(`${over.length} characters`);
    expect(p).toContain('1024-character hard limit');
    expect(p).toContain('<new_description>');
  });
});

describe('MAX_DESCRIPTION_CHARS', () => {
  test('matches the frontmatter validator limit', () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(1024);
  });
});
