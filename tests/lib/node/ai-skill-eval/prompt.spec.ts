// Tests for lib/node/ai-skill-eval/prompt.ts.

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_RUNS_PER_QUERY,
  buildEvalPrompt,
  resolveRunsPerQuery,
} from '../../../../lib/node/ai-skill-eval/prompt.ts';

describe('buildEvalPrompt', () => {
  test('embeds the skill body between SKILL markers when withSkill=true', () => {
    const out = buildEvalPrompt({ skillBody: '# Skill body\ncontent', scenario: 'my scenario', withSkill: true });

    expect(out).toContain('===== SKILL =====\n# Skill body\ncontent\n===== END SKILL =====');
  });

  test('includes the user scenario verbatim', () => {
    const out = buildEvalPrompt({
      skillBody: 'body',
      scenario: 'please handle a plugin-conventions task',
      withSkill: true,
    });

    expect(out).toContain('Scenario: please handle a plugin-conventions task');
  });

  test('includes the TRIGGER/REASON/NEXT_STEP response-shape instructions', () => {
    const out = buildEvalPrompt({ skillBody: 'body', scenario: 'x', withSkill: true });

    expect(out).toContain('TRIGGER:');
    expect(out).toContain('REASON:');
    expect(out).toContain('NEXT_STEP:');
  });

  test('withSkill=false omits the SKILL block but keeps the scenario + TRIGGER/REASON/NEXT_STEP shape', () => {
    const out = buildEvalPrompt({ skillBody: '# Skill body\ncontent', scenario: 'my scenario', withSkill: false });

    expect(out).not.toContain('===== SKILL =====');
    expect(out).not.toContain('===== END SKILL =====');
    expect(out).not.toContain('# Skill body');
    expect(out).toContain('Scenario: my scenario');
    expect(out).toContain('TRIGGER:');
    expect(out).toContain('REASON:');
    expect(out).toContain('NEXT_STEP:');
  });

  test('withSkill=false rephrases the TRIGGER question away from "this skill"', () => {
    const out = buildEvalPrompt({ skillBody: 'body', scenario: 'x', withSkill: false });

    expect(out).not.toContain("this skill's WHEN clause");
    // Baseline wording asks generically about specialized skills / conventions.
    expect(out).toMatch(/specialized skill|specialized convention/);
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
