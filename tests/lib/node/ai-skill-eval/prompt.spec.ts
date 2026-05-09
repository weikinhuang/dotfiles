// Tests for lib/node/ai-skill-eval/prompt.ts.

import { describe, expect, test } from 'vitest';

import { buildEvalPrompt } from '../../../../lib/node/ai-skill-eval/prompt.ts';

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
