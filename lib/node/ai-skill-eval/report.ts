// Report rendering for ai-skill-eval: loads per-skill grade JSON files out of
// the workspace and emits either a markdown report or a JSON summary.
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type GradeRecord } from './types.ts';

export interface ReportSummary {
  total_evals: number;
  trigger_correct: number;
  expectation_pass: number;
  expectation_total: number;
}

export function loadGrades(workspace: string, wanted: readonly string[]): GradeRecord[] {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace ${workspace} does not exist (run first)`);
  }
  const grades: GradeRecord[] = [];
  for (const name of readdirSync(workspace).sort()) {
    const skillDir = join(workspace, name);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    const gradesDir = join(skillDir, 'grades');
    if (!existsSync(gradesDir)) continue;
    for (const gf of readdirSync(gradesDir).sort()) {
      if (!gf.endsWith('.json')) continue;
      try {
        grades.push(JSON.parse(readFileSync(join(gradesDir, gf), 'utf8')) as GradeRecord);
      } catch {
        // Ignore malformed grade files (matches the bash original).
      }
    }
  }
  return grades;
}

export function summarize(grades: readonly GradeRecord[]): ReportSummary {
  return {
    total_evals: grades.length,
    trigger_correct: grades.filter((g) => g.trigger_pass).length,
    expectation_pass: grades.reduce((s, g) => s + (g.expectation_pass || 0), 0),
    expectation_total: grades.reduce((s, g) => s + (g.expectation_total || 0), 0),
  };
}

/** Report is "failing" when there are no grades or when any trigger_pass was false. */
export function hasFailures(summary: ReportSummary): boolean {
  return !(summary.total_evals > 0 && summary.trigger_correct === summary.total_evals);
}

export function renderJson(grades: readonly GradeRecord[]): string {
  const summary = summarize(grades);
  return `${JSON.stringify({ summary, evals: grades }, null, 2)}\n`;
}

/** Compact "N/M" label for a grade's trigger-rate column in the markdown table. */
function triggerRateLabel(g: GradeRecord): string {
  const triggers = g.triggers ?? 0;
  const runs = g.runs ?? g.per_run?.length ?? 0;
  return `${triggers}/${runs}`;
}

export function renderMarkdown(grades: readonly GradeRecord[]): string {
  const summary = summarize(grades);
  const lines: string[] = [
    '# ai-skill-eval report',
    '',
    `- Total evals: **${summary.total_evals}**`,
    `- Correct TRIGGER detection: **${summary.trigger_correct}/${summary.total_evals}**`,
    `- Expectation matches: **${summary.expectation_pass}/${summary.expectation_total}**`,
    '',
    '## Per-eval',
    '',
    '| Skill | Eval | Expected | Trigger rate | Trigger | Expectations |',
    '|---|---|---|---|---|---|',
  ];
  for (const g of grades) {
    const want = g.should_trigger ? 'yes' : 'no';
    const mark = g.trigger_pass ? '✅' : '❌';
    const exp = `${g.expectation_pass || 0}/${g.expectation_total || 0}`;
    lines.push(`| ${g.skill} | ${g.eval_id} | ${want} | ${triggerRateLabel(g)} | ${mark} | ${exp} |`);
  }
  lines.push('', '## Detail', '');
  for (const g of grades) {
    const mark = g.trigger_pass ? '✅ correct' : '❌ wrong';
    const runs = g.runs ?? g.per_run?.length ?? 0;
    const triggers = g.triggers ?? 0;
    const rate = typeof g.trigger_rate === 'number' ? g.trigger_rate.toFixed(2) : '0.00';
    lines.push(`### ${g.skill} / ${g.eval_id}`, '');
    lines.push(`- **Trigger rate:** ${triggers}/${runs} (${rate}) — ${mark}`);
    if (Array.isArray(g.per_run) && g.per_run.length > 0) {
      lines.push('- **Per-run replies:**');
      g.per_run.forEach((r, i) => {
        const t = r.trigger || '(empty)';
        const reason = r.reason || '';
        const step = r.next_step || '';
        lines.push(`  - Run ${i + 1}: \`${t}\` — ${reason} / ${step}`);
      });
    }
    lines.push('- **Expectations:**');
    for (const exp of g.expectations ?? []) {
      const m = exp.passed ? '✅' : '⚠️';
      lines.push(`  - ${m} ${exp.text}  *(${exp.note || ''})*`);
    }
    if (Array.isArray(g.flaws) && g.flaws.length > 0) {
      lines.push('- **Critic flaws:**');
      for (const fl of g.flaws) lines.push(`  - ${fl}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
