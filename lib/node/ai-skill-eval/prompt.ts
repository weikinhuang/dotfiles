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
 * Input for {@link buildEvalPrompt}. `withSkill=true` embeds the SKILL.md body
 * between `===== SKILL =====` markers (current behavior); `withSkill=false`
 * emits only the scenario + structured-output request — the R2 baseline
 * variant used by `--baseline` to measure what the model does without any
 * skill nudging.
 */
export interface BuildEvalPromptInput {
  skillBody: string;
  scenario: string;
  withSkill: boolean;
}

/**
 * Wrap a SKILL.md body and a user-supplied scenario into the structured prompt
 * the driver sees. The reply format (TRIGGER / REASON / NEXT_STEP) is parsed
 * back in grader.ts — keep them in lockstep.
 *
 * When `withSkill=false`, the SKILL block is omitted entirely and the TRIGGER
 * question is rephrased to ask whether the scenario calls for a specialized
 * convention, so the model is scored on its uncued priors.
 */
export function buildEvalPrompt(input: BuildEvalPromptInput): string {
  const { skillBody, scenario, withSkill } = input;
  const intro = withSkill
    ? 'You are an AI coding assistant working on a software project. The following skill is loaded in your context. Read it carefully, then answer the scenario that follows.'
    : 'You are an AI coding assistant working on a software project. Answer the scenario that follows.';
  const triggerQuestion = withSkill
    ? "TRIGGER: <yes or no \u2014 does this skill's WHEN clause apply to the scenario?>"
    : 'TRIGGER: <yes or no \u2014 does this scenario call for applying a specialized skill or convention (rather than general reasoning)?>';
  const lines: string[] = [intro, ''];
  if (withSkill) {
    lines.push('===== SKILL =====', skillBody, '===== END SKILL =====', '');
  }
  lines.push(
    `Scenario: ${scenario}`,
    '',
    'Answer in EXACTLY this format, with these three labels and nothing else. Do not add extra prose, headings, or code fences before or after.',
    '',
    triggerQuestion,
    'REASON: <one sentence explaining why or why not>',
    withSkill
      ? "NEXT_STEP: <2\u20134 sentences describing the concrete action you would take next, which must reflect the skill's guidance if TRIGGER is yes>"
      : 'NEXT_STEP: <2\u20134 sentences describing the concrete action you would take next>',
    '',
  );
  return lines.join('\n');
}
