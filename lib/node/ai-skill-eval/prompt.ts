// Prompt templates used by ai-skill-eval.
// SPDX-License-Identifier: MIT

/**
 * Wrap a SKILL.md body and a user-supplied scenario into the structured prompt
 * the driver sees. The reply format (TRIGGER / REASON / NEXT_STEP) is parsed
 * back in grader.ts — keep them in lockstep.
 */
export function buildEvalPrompt(skillBody: string, userPrompt: string): string {
  return [
    'You are an AI coding assistant working on a software project. The following skill is loaded in your context. Read it carefully, then answer the scenario that follows.',
    '',
    '===== SKILL =====',
    skillBody,
    '===== END SKILL =====',
    '',
    `Scenario: ${userPrompt}`,
    '',
    'Answer in EXACTLY this format, with these three labels and nothing else. Do not add extra prose, headings, or code fences before or after.',
    '',
    "TRIGGER: <yes or no — does this skill's WHEN clause apply to the scenario?>",
    'REASON: <one sentence explaining why or why not>',
    "NEXT_STEP: <2–4 sentences describing the concrete action you would take next, which must reflect the skill's guidance if TRIGGER is yes>",
    '',
  ].join('\n');
}
