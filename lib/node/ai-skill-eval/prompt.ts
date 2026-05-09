// Prompt templates used by ai-skill-eval.
// SPDX-License-Identifier: MIT

import { type EvalSpec, type EvalsFile } from './types.ts';

export const DEFAULT_RUNS_PER_QUERY = 3;

/**
 * Resolve how many times an eval should be invoked. Priority (highest first):
 *   1. CLI `--runs-per-query N` override (`cliOverride`)
 *   2. Per-eval `runs_per_query` in evals.json
 *   3. File-level `runs_per_query` in evals.json
 *   4. {@link DEFAULT_RUNS_PER_QUERY}
 *
 * Non-positive or non-integer values at any layer are ignored in favour of the
 * next fallback; guards against a bad config silently coercing to 0 runs.
 */
export function resolveRunsPerQuery(
  ev: Pick<EvalSpec, 'runs_per_query'>,
  file: Pick<EvalsFile, 'runs_per_query'> | null | undefined,
  cliOverride: number | null,
): number {
  const valid = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 1;
  if (valid(cliOverride)) return cliOverride;
  if (valid(ev.runs_per_query)) return ev.runs_per_query;
  if (file && valid(file.runs_per_query)) return file.runs_per_query;
  return DEFAULT_RUNS_PER_QUERY;
}

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
