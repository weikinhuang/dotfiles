// Tests for lib/node/ai-skill-eval/prompt.ts.

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_RUNS_PER_QUERY,
  buildEvalPrompt,
  resolveRunsPerQuery,
} from '../../../../lib/node/ai-skill-eval/prompt.ts';

describe('buildEvalPrompt', () => {
  test('embeds the skill body between SKILL markers', () => {
    const out = buildEvalPrompt('# Skill body\ncontent', 'my scenario');

    expect(out).toContain('===== SKILL =====\n# Skill body\ncontent\n===== END SKILL =====');
  });

  test('includes the user scenario verbatim', () => {
    const out = buildEvalPrompt('body', 'please handle a plugin-conventions task');

    expect(out).toContain('Scenario: please handle a plugin-conventions task');
  });

  test('includes the TRIGGER/REASON/NEXT_STEP response-shape instructions', () => {
    const out = buildEvalPrompt('body', 'x');

    expect(out).toContain('TRIGGER:');
    expect(out).toContain('REASON:');
    expect(out).toContain('NEXT_STEP:');
  });
});

describe('resolveRunsPerQuery', () => {
  test('CLI override wins over per-eval, file, and default', () => {
    expect(resolveRunsPerQuery({ runs_per_query: 5 }, { runs_per_query: 4 }, 7)).toBe(7);
  });

  test('per-eval override wins when no CLI override is set', () => {
    expect(resolveRunsPerQuery({ runs_per_query: 5 }, { runs_per_query: 4 }, null)).toBe(5);
  });

  test('file-level default applies when neither CLI nor per-eval is set', () => {
    expect(resolveRunsPerQuery({}, { runs_per_query: 4 }, null)).toBe(4);
  });

  test('falls back to the built-in default when nothing is specified', () => {
    expect(resolveRunsPerQuery({}, null, null)).toBe(DEFAULT_RUNS_PER_QUERY);
    expect(DEFAULT_RUNS_PER_QUERY).toBe(3);
  });

  test('ignores non-positive / non-integer values at any layer', () => {
    expect(resolveRunsPerQuery({ runs_per_query: 0 }, { runs_per_query: 4 }, null)).toBe(4);
    expect(resolveRunsPerQuery({ runs_per_query: 1.5 }, { runs_per_query: 4 }, null)).toBe(4);
    expect(resolveRunsPerQuery({}, { runs_per_query: -1 }, null)).toBe(DEFAULT_RUNS_PER_QUERY);
  });
});
