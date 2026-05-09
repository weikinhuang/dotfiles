// Critic integration for ai-skill-eval: builds the critic's grading prompt
// and merges its JSON verdict back into an existing grade record.
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { type ExpectationResult, type GradeRecord } from './types.ts';

export interface CriticPromptInput {
  skill: string;
  evalId: string;
  shouldTrigger: boolean;
  expectations: string[];
  resultFile: string;
}

export function buildCriticPrompt(input: CriticPromptInput): string {
  const { skill, evalId, shouldTrigger, expectations, resultFile } = input;
  const result = readFileSync(resultFile, 'utf8').trim();
  const lines = [
    'You are grading an AI skill-following eval.',
    '',
    `Skill: ${skill}`,
    `Eval:  ${evalId}  (should_trigger=${shouldTrigger})`,
    '',
    "Expectations to judge (each independently passes or fails based on the model's reply):",
  ];
  expectations.forEach((exp, i) => lines.push(`  ${i + 1}. ${exp}`));
  lines.push(
    '',
    "Model's reply (TRIGGER / REASON / NEXT_STEP):",
    '-----',
    result,
    '-----',
    '',
    'Output STRICT JSON, no prose, no code fences, matching this schema:',
    '{"expectations": [{"text": "...", "passed": true|false, "evidence": "..."}], "flaws": ["..."]}',
    '',
    "An expectation passes only if the model's reply substantively demonstrates the behavior the expectation describes.",
    'Paraphrasing is OK; specific commands/paths/files named must match.',
  );
  return lines.join('\n');
}

export function writeCriticPrompt(outFile: string, prompt: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, prompt);
}

interface CriticVerdict {
  expectations?: { text?: string; passed?: boolean; evidence?: string }[];
  flaws?: string[];
}

/**
 * Parse the critic's raw stdout (JSON possibly wrapped in prose) and merge the
 * per-expectation pass/fail + evidence into an existing grade-file on disk.
 * Throws if no JSON object is found in the critic output.
 */
export function mergeCriticVerdict(criticRaw: string, gradeFile: string): void {
  const m = /\{[\s\S]*\}/.exec(criticRaw);
  if (!m) throw new Error('critic output did not contain a JSON object');
  const verdict = JSON.parse(m[0]) as CriticVerdict;
  const grade = JSON.parse(readFileSync(gradeFile, 'utf8')) as GradeRecord;
  const criticExps = Array.isArray(verdict.expectations) ? verdict.expectations : [];
  grade.expectations = grade.expectations.map((exp, i): ExpectationResult => {
    const c = criticExps[i];
    if (!c) return exp;
    return {
      ...exp,
      passed: typeof c.passed === 'boolean' ? c.passed : exp.passed,
      note: `critic: ${c.evidence ?? ''}`,
    };
  });
  grade.expectation_pass = grade.expectations.filter((e) => e.passed).length;
  if (Array.isArray(verdict.flaws)) grade.flaws = verdict.flaws;
  grade.grader = 'critic';
  writeFileSync(gradeFile, JSON.stringify(grade, null, 2));
}
