// Report rendering for ai-skill-eval: loads per-skill grade JSON files out of
// the workspace and emits either a markdown report or a JSON summary. R3.3
// switched the workspace layout to
// `<workspace>/<skill>/iteration-<N>/<config>/grades/`, so the loader now
// resolves an iteration per skill (caller-provided override, or the latest
// existing slot). A cross-iteration Δ renderer backs `--compare-to` on the
// `report` subcommand.
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadIterationGrades } from './grade-loader.ts';
import { type GradeConfig, type GradeRecord } from './types.ts';
import { iterationPath, latestIteration } from './workspace.ts';

export interface ReportSummary {
  total_evals: number;
  trigger_correct: number;
  expectation_pass: number;
  expectation_total: number;
}

/**
 * Walk `<workspace>/<skill>/iteration-<N>/<config>/grades/*.json` for every
 * skill directory and every known {@link GradeConfig} subtree. Grade records
 * predating R2 are stamped with `config: 'with_skill'` at load time so older
 * workspaces keep rendering sanely.
 *
 * `iteration` selects the iteration subdir to read:
 *   - `null` (default): pick `latestIteration(skill)`. Skills with no
 *     iteration dirs are silently skipped.
 *   - a positive integer: read exactly that iteration. Missing iteration
 *     dirs for some skills are silently skipped; callers that need a hard
 *     error should validate up front with {@link workspace.latestIteration}.
 */
export function loadGrades(
  workspace: string,
  wanted: readonly string[],
  iteration: number | null = null,
): GradeRecord[] {
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
    const iterN = iteration ?? latestIteration(workspace, name);
    if (iterN == null) continue;
    grades.push(...loadIterationGrades(iterationPath(workspace, name, iterN)));
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

/**
 * Split grades by {@link GradeConfig} so callers can render each config as its
 * own block and compute deltas eval-by-eval.
 */
export function groupByConfig(grades: readonly GradeRecord[]): Record<GradeConfig, GradeRecord[]> {
  const out: Record<GradeConfig, GradeRecord[]> = { with_skill: [], without_skill: [] };
  for (const g of grades) {
    const key: GradeConfig = g.config === 'without_skill' ? 'without_skill' : 'with_skill';
    out[key].push(g);
  }
  return out;
}

/** Report is "failing" when there are no grades or when any trigger_pass was false. */
export function hasFailures(summary: ReportSummary): boolean {
  return !(summary.total_evals > 0 && summary.trigger_correct === summary.total_evals);
}

export function renderJson(grades: readonly GradeRecord[]): string {
  const groups = groupByConfig(grades);
  const summaries: Record<string, ReportSummary> = { with_skill: summarize(groups.with_skill) };
  if (groups.without_skill.length > 0) summaries.without_skill = summarize(groups.without_skill);
  const payload: Record<string, unknown> = {
    summary: summaries.with_skill,
    summary_by_config: summaries,
    evals: grades,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Compact "N/M" label for a grade's trigger-rate column in the markdown table. */
function triggerRateLabel(g: GradeRecord): string {
  const triggers = g.triggers ?? 0;
  const runs = g.runs ?? g.per_run?.length ?? 0;
  return `${triggers}/${runs}`;
}

/**
 * Signed, plus-leading delta in percentage points. `0` keeps a leading `+`
 * for visual alignment with the non-zero rows.
 */
function formatDelta(a: number, b: number): string {
  const d = a - b;
  const pts = Math.round(d * 100);
  return pts >= 0 ? `+${pts}%` : `${pts}%`;
}

/**
 * Percentage-point delta for expectation pass fractions. Reports the
 * difference between the two pass rates (primary - baseline), rounded to
 * integer points; stable enough for a table column.
 */
function formatExpectationDelta(pPass: number, pTotal: number, bPass: number, bTotal: number): string {
  const pRate = pTotal > 0 ? pPass / pTotal : 0;
  const bRate = bTotal > 0 ? bPass / bTotal : 0;
  return formatDelta(pRate, bRate);
}

function renderDetailSection(g: GradeRecord, lines: string[]): void {
  const mark = g.trigger_pass ? '✅ correct' : '❌ wrong';
  const runs = g.runs ?? g.per_run?.length ?? 0;
  const triggers = g.triggers ?? 0;
  const rate = typeof g.trigger_rate === 'number' ? g.trigger_rate.toFixed(2) : '0.00';
  const configTag = g.config === 'without_skill' ? ' [without_skill]' : ' [with_skill]';
  lines.push(`### ${g.skill} / ${g.eval_id}${configTag}`, '');
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

function renderBasicTable(grades: readonly GradeRecord[], lines: string[]): void {
  lines.push(
    '## Per-eval',
    '',
    '| Skill | Eval | Expected | Trigger rate | Trigger | Expectations |',
    '|---|---|---|---|---|---|',
  );
  for (const g of grades) {
    const want = g.should_trigger ? 'yes' : 'no';
    const mark = g.trigger_pass ? '✅' : '❌';
    const exp = `${g.expectation_pass || 0}/${g.expectation_total || 0}`;
    lines.push(`| ${g.skill} | ${g.eval_id} | ${want} | ${triggerRateLabel(g)} | ${mark} | ${exp} |`);
  }
}

function renderBaselineTable(
  withSkill: readonly GradeRecord[],
  withoutSkill: readonly GradeRecord[],
  lines: string[],
): void {
  // Index baseline by skill:eval_id for O(1) pairing with the with_skill row.
  const baseline = new Map<string, GradeRecord>();
  for (const g of withoutSkill) baseline.set(`${g.skill}:${g.eval_id}`, g);
  lines.push(
    '## Per-eval (with_skill vs without_skill)',
    '',
    '| Skill | Eval | Expected | with_skill rate | without_skill rate | Δ trigger rate | with_skill pass | without_skill pass |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const g of withSkill) {
    const want = g.should_trigger ? 'yes' : 'no';
    const wsRate = `${triggerRateLabel(g)} (${(g.trigger_rate ?? 0).toFixed(2)})`;
    const b = baseline.get(`${g.skill}:${g.eval_id}`);
    const bRate = b ? `${triggerRateLabel(b)} (${(b.trigger_rate ?? 0).toFixed(2)})` : '—';
    const delta = b ? formatDelta(g.trigger_rate ?? 0, b.trigger_rate ?? 0) : '—';
    const wsMark = g.trigger_pass ? '✅' : '❌';
    const bMark = b ? (b.trigger_pass ? '✅' : '❌') : '—';
    lines.push(`| ${g.skill} | ${g.eval_id} | ${want} | ${wsRate} | ${bRate} | ${delta} | ${wsMark} | ${bMark} |`);
  }
}

/**
 * Render the markdown report. When any `without_skill` grades are present the
 * output gains a per-config summary block, a side-by-side Δ table, and a
 * footer calling out the R2 caveat for `should_trigger=false` evals.
 */
export function renderMarkdown(grades: readonly GradeRecord[]): string {
  const groups = groupByConfig(grades);
  const hasBaseline = groups.without_skill.length > 0;
  const primary = hasBaseline ? groups.with_skill : grades;
  const primarySummary = summarize(primary);
  const lines: string[] = [
    '# ai-skill-eval report',
    '',
    `- Total evals: **${primarySummary.total_evals}**`,
    `- Correct TRIGGER detection: **${primarySummary.trigger_correct}/${primarySummary.total_evals}**`,
    `- Expectation matches: **${primarySummary.expectation_pass}/${primarySummary.expectation_total}**`,
    '',
  ];

  if (hasBaseline) {
    const baselineSummary = summarize(groups.without_skill);
    lines.push(
      '## with_skill',
      '',
      `- Total evals: **${primarySummary.total_evals}**`,
      `- Correct TRIGGER detection: **${primarySummary.trigger_correct}/${primarySummary.total_evals}**`,
      `- Expectation matches: **${primarySummary.expectation_pass}/${primarySummary.expectation_total}**`,
      '',
      '## without_skill (baseline)',
      '',
      `- Total evals: **${baselineSummary.total_evals}**`,
      `- Correct TRIGGER detection: **${baselineSummary.trigger_correct}/${baselineSummary.total_evals}**`,
      `- Expectation matches: **${baselineSummary.expectation_pass}/${baselineSummary.expectation_total}**`,
      `- Aggregate Δ trigger-rate pass: **${formatDelta(primarySummary.trigger_correct / Math.max(primarySummary.total_evals, 1), baselineSummary.trigger_correct / Math.max(baselineSummary.total_evals, 1))}**`,
      '',
    );
    renderBaselineTable(groups.with_skill, groups.without_skill, lines);
  } else {
    renderBasicTable(grades, lines);
  }

  lines.push('', '## Detail', '');
  for (const g of groups.with_skill) renderDetailSection(g, lines);
  for (const g of groups.without_skill) renderDetailSection(g, lines);

  if (hasBaseline) {
    lines.push(
      '---',
      '',
      "Note: for `should_trigger=false` evals, a baseline 'pass' means the model also declined to apply a skill — which is the **uncued** default, NOT evidence that the skill helped. Only the `should_trigger=true` rows where `with_skill` passed and `without_skill` failed are direct evidence the skill moved the model.",
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render the cross-iteration Δ section appended to `report --compare-to N`.
 * Pairs primary vs compared by `(skill, eval_id, config)` and shows the
 * per-eval trigger-rate + expectation-pass deltas. Missing counterparts on
 * either side are shown as `—`; this is expected when evals were added or
 * removed between iterations.
 */
export function renderCrossIterationMarkdown(
  primary: readonly GradeRecord[],
  compared: readonly GradeRecord[],
  comparedIteration: number,
): string {
  const lines: string[] = [`## Cross-iteration Δ (baseline: iteration-${comparedIteration})`, ''];
  if (primary.length === 0 && compared.length === 0) {
    lines.push('_No grades on either side._', '');
    return `${lines.join('\n')}\n`;
  }
  const index = new Map<string, GradeRecord>();
  for (const g of compared) index.set(`${g.skill}:${g.eval_id}:${g.config ?? 'with_skill'}`, g);

  lines.push(
    '| Skill | Eval | Config | primary trigger | baseline trigger | Δ trigger | primary expect | baseline expect | Δ expect |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const p of primary) {
    const cfg = p.config ?? 'with_skill';
    const key = `${p.skill}:${p.eval_id}:${cfg}`;
    const b = index.get(key);
    const pTrig = triggerRateLabel(p);
    const bTrig = b ? triggerRateLabel(b) : '—';
    const dTrig = b ? formatDelta(p.trigger_rate ?? 0, b.trigger_rate ?? 0) : '—';
    const pExp = `${p.expectation_pass || 0}/${p.expectation_total || 0}`;
    const bExp = b ? `${b.expectation_pass || 0}/${b.expectation_total || 0}` : '—';
    const dExp = b
      ? formatExpectationDelta(
          p.expectation_pass || 0,
          p.expectation_total || 0,
          b.expectation_pass || 0,
          b.expectation_total || 0,
        )
      : '—';
    lines.push(`| ${p.skill} | ${p.eval_id} | ${cfg} | ${pTrig} | ${bTrig} | ${dTrig} | ${pExp} | ${bExp} | ${dExp} |`);
  }

  // Rows only present on the baseline side (eval removed since).
  const primaryKeys = new Set(primary.map((g) => `${g.skill}:${g.eval_id}:${g.config ?? 'with_skill'}`));
  for (const b of compared) {
    const cfg = b.config ?? 'with_skill';
    const key = `${b.skill}:${b.eval_id}:${cfg}`;
    if (primaryKeys.has(key)) continue;
    const bTrig = triggerRateLabel(b);
    const bExp = `${b.expectation_pass || 0}/${b.expectation_total || 0}`;
    lines.push(`| ${b.skill} | ${b.eval_id} | ${cfg} | — | ${bTrig} | — | — | ${bExp} | — |`);
  }

  return `${lines.join('\n')}\n`;
}
