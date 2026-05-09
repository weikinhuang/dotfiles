// Deterministic grading for ai-skill-eval: parses the model's reply and
// scores each expectation against a keyword-match heuristic.
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { type ExpectationResult, type GradeRecord, type ParsedReply } from './types.ts';

/**
 * Parse the model's reply into its three structured fields. Lines that are
 * not one of the TRIGGER / REASON / NEXT_STEP labels get appended to the
 * currently-open field so multi-line values survive.
 */
export function parseReply(text: string): ParsedReply {
  const acc: Record<'TRIGGER' | 'REASON' | 'NEXT_STEP', string[]> = {
    TRIGGER: [],
    REASON: [],
    NEXT_STEP: [],
  };
  let current: 'TRIGGER' | 'REASON' | 'NEXT_STEP' | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(TRIGGER|REASON|NEXT_STEP):\s*(.*)$/.exec(line);
    if (m) {
      current = m[1] as 'TRIGGER' | 'REASON' | 'NEXT_STEP';
      acc[current].push(m[2] ?? '');
      continue;
    }
    if (current && line) acc[current].push(line);
  }
  return {
    trigger: acc.TRIGGER.join(' ').trim(),
    reason: acc.REASON.join(' ').trim(),
    next_step: acc.NEXT_STEP.join(' ').trim(),
  };
}

/**
 * Pull a small set of lower-cased, deduplicated keywords out of an expectation
 * string. Order of precedence: backtick-quoted terms, path-like tokens,
 * file-name-with-extension tokens, then a small curated command vocabulary
 * (shellcheck / bats / ./dev/*.sh / ...).
 */
export function keywordsFor(expectation: string): string[] {
  const quoted = [...expectation.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  const paths = [...expectation.matchAll(/[\w./-]+(?:\/[\w./-]+)+/g)].map((m) => m[0]);
  const files = [...expectation.matchAll(/\b[\w-]+\.(?:sh|bash|ts|bats|json|md|tsx|mjs|cjs|yml|yaml)\b/g)].map(
    (m) => m[0],
  );
  const cmds = [
    ...expectation
      .toLowerCase()
      .matchAll(
        /\b(shellcheck|shfmt|vitest|bats|npm test|yarn test|pnpm test|\.\/dev\/[a-z-]+\.sh|jq|yamllint|tsc)\b/g,
      ),
  ].map((m) => m[0]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...quoted, ...paths, ...files, ...cmds]) {
    const k = raw.toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out.slice(0, 4);
}

export interface DeterministicGradeInput {
  skill: string;
  evalId: string;
  shouldTrigger: boolean;
  expectations: string[];
  resultFile: string;
  gradeFile: string;
}

/**
 * Grade a single eval's result file and write the JSON grade record to disk.
 * Returns the in-memory record for callers that want to chain critics.
 */
export function gradeDeterministic(input: DeterministicGradeInput): GradeRecord {
  const { skill, evalId, shouldTrigger, expectations, resultFile, gradeFile } = input;
  const raw = readFileSync(resultFile, 'utf8');
  const parsed = parseReply(raw);
  const trigYes = parsed.trigger.toLowerCase().startsWith('yes');
  const triggerPass = trigYes === shouldTrigger;
  const body = `${parsed.reason} ${parsed.next_step}`.toLowerCase();

  const expResults: ExpectationResult[] = expectations.map((exp) => {
    const kws = keywordsFor(exp);
    if (kws.length === 0) {
      return { text: exp, passed: false, note: 'no-specific-keywords' };
    }
    const hits = kws.filter((k) => body.includes(k));
    const threshold = Math.max(1, Math.floor(kws.length / 2) + (kws.length >= 3 ? 1 : 0));
    const passed = hits.length >= threshold;
    return {
      text: exp,
      passed,
      note: `matched ${hits.length}/${kws.length} keywords: [${hits.join(', ')}]`,
    };
  });

  const grade: GradeRecord = {
    skill,
    eval_id: evalId,
    should_trigger: shouldTrigger,
    got_trigger: parsed.trigger,
    trigger_pass: triggerPass,
    reason: parsed.reason,
    next_step: parsed.next_step,
    expectations: expResults,
    expectation_pass: expResults.filter((e) => e.passed).length,
    expectation_total: expectations.length,
    grader: 'deterministic',
  };
  mkdirSync(dirname(gradeFile), { recursive: true });
  writeFileSync(gradeFile, JSON.stringify(grade, null, 2));
  return grade;
}
