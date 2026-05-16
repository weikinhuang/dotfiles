// Post-hoc analyzer for ai-skill-eval (R5.2).
//
// Consumes the per-eval compare-<eval-id>.json records produced by R5.1
// and asks a user-supplied critic command to explain *why* the winner
// won, then to propose concrete improvements for the losing iteration's
// SKILL.md. The rubric prompt is a raw port of
// `~/.claude/skills/skill-creator/agents/analyzer.md`, shipped under
// `prompts/analyzer.md` and loaded at runtime.
//
// One analyze turn per eval with a decided winner:
//
//   1. Walk `<workspace>/<skill>/iteration-<A>/vs-iteration-<B>/` for
//      `compare-*.json` records. Ties and records the comparator couldn't
//      score are recorded as skips/errors.
//   2. For each record, resolve the winner + loser iteration, read their
//      rendered SKILL.md bodies out of the per-iteration prompt files
//      (the `===== SKILL =====` block `buildEvalPrompt` emits), and pull
//      the winner + loser reply transcripts from the comparator's
//      unblinded `output_{a,b}_path` pair.
//   3. Build the analyzer prompt (rubric + inlined inputs) and pipe it
//      through {@link invokeCritic}.
//   4. Parse the returned JSON verdict and persist it to
//      `<compareOutputDir>/analyze-<eval-id>.json`; the caller stacks
//      these into a single `analysis.md` report with a per-eval section
//      (winner strengths / loser weaknesses / suggestions).
//
// The analyzer is strictly post-hoc: it never re-runs the driver, never
// touches SKILL.md, and never asks the critic to pick a new winner. Its
// only job is to surface actionable guidance on the losing iteration.
//
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareOutputDir, type CompareRecord, type WinnerLabel } from './compare.ts';
import { invokeCritic } from './driver.ts';
import { iterationPath } from './workspace.ts';

const ANALYZER_TEMPLATE_PATH = fileURLToPath(new URL('./prompts/analyzer.md', import.meta.url));

/** Lazy-loaded copy of the rubric prompt template; reset by specs with {@link setAnalyzerTemplateForTest}. */
let analyzerTemplateCache: string | null = null;

/** Load the rubric prompt template from the sibling `prompts/analyzer.md`, cached after the first read. */
export function loadAnalyzerTemplate(): string {
  if (analyzerTemplateCache != null) return analyzerTemplateCache;
  analyzerTemplateCache = readFileSync(ANALYZER_TEMPLATE_PATH, 'utf8');
  return analyzerTemplateCache;
}

/** Test hook: override the rubric template so specs can keep prompts short and deterministic. */
export function setAnalyzerTemplateForTest(template: string | null): void {
  analyzerTemplateCache = template;
}

/**
 * Extract the SKILL body buildEvalPrompt emits between
 * `===== SKILL =====` / `===== END SKILL =====` markers. Returns the
 * whole file verbatim when the markers are absent - callers want *some*
 * context for the analyzer rather than silently dropping the input.
 */
export function extractSkillBodyFromPrompt(promptContents: string): string {
  const m = /^===== SKILL =====\n([\s\S]*?)\n===== END SKILL =====/m.exec(promptContents);
  if (!m?.[1]) return promptContents;
  return m[1];
}

/** Path of the per-iteration rendered prompt for one eval. */
export function promptFilePath(workspace: string, skill: string, iteration: number, evalId: string): string {
  return join(iterationPath(workspace, skill, iteration), 'with_skill', 'prompts', `${evalId}.txt`);
}

/** Per-eval analyzer record path: `<compareOutputDir>/analyze-<evalId>.json`. */
export function analyzeRecordPath(
  workspace: string,
  skill: string,
  iterationA: number,
  iterationB: number,
  evalId: string,
): string {
  return join(compareOutputDir(workspace, skill, iterationA, iterationB), `analyze-${evalId}.json`);
}

/** Combined human report path: `<compareOutputDir>/analysis.md`. */
export function analysisReportPath(workspace: string, skill: string, iterationA: number, iterationB: number): string {
  return join(compareOutputDir(workspace, skill, iterationA, iterationB), 'analysis.md');
}

/**
 * Walk the R5.1 `vs-iteration-<B>/` directory for `compare-*.json`
 * records, parse them, and skip files that don't match the
 * {@link CompareRecord} shape. Returns records sorted by eval id for
 * deterministic output. Throws if the directory is missing - the caller
 * has a nicer error path than we can synthesize here.
 */
function isCompareRecord(v: unknown): v is CompareRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.skill === 'string' &&
    typeof o.eval_id === 'string' &&
    typeof o.iteration_a === 'number' &&
    typeof o.iteration_b === 'number' &&
    typeof o.winner_label === 'string' &&
    (o.winner_iteration === null || typeof o.winner_iteration === 'number') &&
    typeof o.output_a_path === 'string' &&
    typeof o.output_b_path === 'string'
  );
}

export function loadCompareRecords(
  workspace: string,
  skill: string,
  iterationA: number,
  iterationB: number,
): CompareRecord[] {
  const dir = compareOutputDir(workspace, skill, iterationA, iterationB);
  if (!existsSync(dir)) {
    throw new Error(`no compare output at ${dir} (run \`ai-skill-eval compare\` first)`);
  }
  const records: CompareRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^compare-(.+)\.json$/.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isCompareRecord(parsed)) continue;
    records.push(parsed);
  }
  return records;
}

export interface AnalyzerInputs {
  skill: string;
  evalId: string;
  evalPrompt: string;
  expectations: readonly string[];
  winnerIteration: number;
  loserIteration: number;
  winnerLabel: Exclude<WinnerLabel, 'tie'>;
  comparatorReason: string;
  winnerSkillPath: string;
  loserSkillPath: string;
  winnerSkillBody: string;
  loserSkillBody: string;
  winnerTranscriptPath: string;
  loserTranscriptPath: string;
  winnerTranscript: string;
  loserTranscript: string;
}

/**
 * Compose the full critic prompt: the raw rubric port followed by a
 * clearly-labelled INPUTS section that names every parameter and inlines
 * both SKILL.md bodies + both reply transcripts so the critic doesn't
 * need tool access to read them.
 */
export function buildAnalyzerPrompt(inputs: AnalyzerInputs, template = loadAnalyzerTemplate()): string {
  const expectationsBlock =
    inputs.expectations.length > 0
      ? inputs.expectations.map((exp, i) => `  ${i + 1}. ${exp}`).join('\n')
      : '  (none - judge on content + structure only)';

  return [
    template.trimEnd(),
    '',
    '---',
    '',
    '## Inputs for this analysis',
    '',
    `Skill: ${inputs.skill}`,
    `Eval:  ${inputs.evalId}`,
    `Winner: iteration-${inputs.winnerIteration} (blind label ${inputs.winnerLabel})`,
    `Loser:  iteration-${inputs.loserIteration}`,
    '',
    '- winner_skill_path: ' + inputs.winnerSkillPath,
    '- loser_skill_path: ' + inputs.loserSkillPath,
    '- winner_transcript_path: ' + inputs.winnerTranscriptPath,
    '- loser_transcript_path: ' + inputs.loserTranscriptPath,
    '',
    'comparator_reason:',
    '-----',
    inputs.comparatorReason.trimEnd(),
    '-----',
    '',
    'eval_prompt:',
    '-----',
    inputs.evalPrompt.trimEnd(),
    '-----',
    '',
    'expectations:',
    expectationsBlock,
    '',
    `winner_skill (iteration-${inputs.winnerIteration}):`,
    '-----',
    inputs.winnerSkillBody.trimEnd(),
    '-----',
    '',
    `loser_skill (iteration-${inputs.loserIteration}):`,
    '-----',
    inputs.loserSkillBody.trimEnd(),
    '-----',
    '',
    `winner_transcript (iteration-${inputs.winnerIteration}):`,
    '-----',
    inputs.winnerTranscript.trimEnd(),
    '-----',
    '',
    `loser_transcript (iteration-${inputs.loserIteration}):`,
    '-----',
    inputs.loserTranscript.trimEnd(),
    '-----',
    '',
    'Respond with STRICT JSON matching this schema, no prose, no code fences:',
    '{',
    '  "comparison_summary": {',
    '    "winner_iteration": <number>,',
    '    "loser_iteration": <number>,',
    '    "comparator_reasoning": "..."',
    '  },',
    '  "winner_strengths": ["..."],',
    '  "loser_weaknesses": ["..."],',
    '  "improvement_suggestions": [',
    '    {"priority": "high"|"medium"|"low", "category": "instructions"|"tools"|"examples"|"error_handling"|"structure"|"references", "suggestion": "...", "expected_impact": "..."}',
    '  ]',
    '}',
    '',
    'Optional fields: `instruction_following` ({winner:{score,issues[]}, loser:{score,issues[]}}) and `transcript_insights` ({winner_execution_pattern, loser_execution_pattern}). Omit either when you do not have evidence for it. `winner_strengths`, `loser_weaknesses`, and `improvement_suggestions` are required.',
  ].join('\n');
}

/** Priority tiers accepted by {@link ImprovementSuggestion}. */
export type SuggestionPriority = 'high' | 'medium' | 'low';

/** Single improvement suggestion. Free-form `category` (the template suggests a shortlist but does not enforce it). */
export interface ImprovementSuggestion {
  priority: SuggestionPriority;
  category: string;
  suggestion: string;
  expected_impact: string;
}

/** Parsed analyzer verdict; optional sections match the prompt schema. */
export interface AnalyzerVerdict {
  comparison_summary: {
    winner_iteration: number | null;
    loser_iteration: number | null;
    comparator_reasoning: string;
  };
  winner_strengths: string[];
  loser_weaknesses: string[];
  improvement_suggestions: ImprovementSuggestion[];
  instruction_following?: {
    winner?: { score?: number | null; issues: string[] };
    loser?: { score?: number | null; issues: string[] };
  };
  transcript_insights?: {
    winner_execution_pattern?: string;
    loser_execution_pattern?: string;
  };
  /** Raw JSON decoded from the critic's stdout - useful for debug / downstream tooling. */
  raw: unknown;
}

function coerceStringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${what} must be an array of strings`);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item);
  }
  return out;
}

function coercePriority(v: unknown): SuggestionPriority {
  if (typeof v !== 'string') return 'medium';
  const t = v.trim().toLowerCase();
  if (t === 'high' || t === 'medium' || t === 'low') return t;
  return 'medium';
}

function coerceSuggestions(v: unknown): ImprovementSuggestion[] {
  if (!Array.isArray(v)) throw new Error('improvement_suggestions must be an array');
  const out: ImprovementSuggestion[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const suggestion = typeof o.suggestion === 'string' ? o.suggestion : '';
    if (suggestion.trim().length === 0) continue;
    out.push({
      priority: coercePriority(o.priority),
      category: typeof o.category === 'string' ? o.category : 'instructions',
      suggestion,
      expected_impact: typeof o.expected_impact === 'string' ? o.expected_impact : '',
    });
  }
  return out;
}

function coerceInstructionFollowing(v: unknown): AnalyzerVerdict['instruction_following'] {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const side = (raw: unknown): { score?: number | null; issues: string[] } | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const s = raw as Record<string, unknown>;
    const score = typeof s.score === 'number' ? s.score : null;
    const issues = Array.isArray(s.issues) ? s.issues.filter((x): x is string => typeof x === 'string') : [];
    return { score, issues };
  };
  const winner = side(o.winner);
  const loser = side(o.loser);
  if (!winner && !loser) return undefined;
  return { ...(winner ? { winner } : {}), ...(loser ? { loser } : {}) };
}

function coerceTranscriptInsights(v: unknown): AnalyzerVerdict['transcript_insights'] {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const winner = typeof o.winner_execution_pattern === 'string' ? o.winner_execution_pattern : undefined;
  const loser = typeof o.loser_execution_pattern === 'string' ? o.loser_execution_pattern : undefined;
  if (winner == null && loser == null) return undefined;
  return {
    ...(winner != null ? { winner_execution_pattern: winner } : {}),
    ...(loser != null ? { loser_execution_pattern: loser } : {}),
  };
}

/**
 * Extract the first JSON object from the critic's stdout and coerce it
 * into an {@link AnalyzerVerdict}. Tolerates missing optional sections
 * but requires the three load-bearing lists (`winner_strengths`,
 * `loser_weaknesses`, `improvement_suggestions`).
 */
export function parseAnalyzerVerdict(raw: string): AnalyzerVerdict {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error('analyzer output did not contain a JSON object');
  const verdict = JSON.parse(m[0]) as Record<string, unknown>;

  const summaryRaw = (verdict.comparison_summary ?? {}) as Record<string, unknown>;
  const summary = {
    winner_iteration: typeof summaryRaw.winner_iteration === 'number' ? summaryRaw.winner_iteration : null,
    loser_iteration: typeof summaryRaw.loser_iteration === 'number' ? summaryRaw.loser_iteration : null,
    comparator_reasoning:
      typeof summaryRaw.comparator_reasoning === 'string'
        ? summaryRaw.comparator_reasoning
        : typeof summaryRaw.reasoning === 'string'
          ? summaryRaw.reasoning
          : '',
  };

  return {
    comparison_summary: summary,
    winner_strengths: coerceStringArray(verdict.winner_strengths, 'winner_strengths'),
    loser_weaknesses: coerceStringArray(verdict.loser_weaknesses, 'loser_weaknesses'),
    improvement_suggestions: coerceSuggestions(verdict.improvement_suggestions),
    instruction_following: coerceInstructionFollowing(verdict.instruction_following),
    transcript_insights: coerceTranscriptInsights(verdict.transcript_insights),
    raw: verdict,
  };
}

export interface AnalyzeRecord {
  skill: string;
  eval_id: string;
  iteration_a: number;
  iteration_b: number;
  winner_iteration: number;
  loser_iteration: number;
  winner_label: Exclude<WinnerLabel, 'tie'>;
  winner_skill_path: string;
  loser_skill_path: string;
  winner_transcript_path: string;
  loser_transcript_path: string;
  comparator_reason: string;
  verdict: AnalyzerVerdict;
}

/** Error surfaced per-eval (missing inputs, critic failure, parse failure). */
export interface AnalyzeError {
  eval_id: string;
  reason: string;
}

/** Record of an eval that was skipped (not an error) - e.g. a tie with no loser. */
export interface AnalyzeSkip {
  eval_id: string;
  reason: string;
}

export interface RunAnalyzeResult {
  skill: string;
  iteration_a: number;
  iteration_b: number;
  records: AnalyzeRecord[];
  skipped: AnalyzeSkip[];
  errors: AnalyzeError[];
}

/** Spec-injectable critic surface - signature matches {@link invokeCritic}. */
export type CriticInvoker = (
  criticCmd: string,
  promptFile: string,
  outputFile: string,
) => { exitCode: number; stdout: string };

export interface RunAnalyzeInput {
  workspace: string;
  skill: string;
  iterationA: number;
  iterationB: number;
  criticCmd: string;
  /** Eval prompt + expectations keyed by eval id (reused from the shared evals.json). */
  evals: readonly { id: string; prompt: string; expectations: readonly string[] }[];
  /** Pre-loaded compare records; defaults to walking the R5.1 directory. */
  compareRecords?: readonly CompareRecord[];
  /** Optional eval-id filter; evals not in this set are silently ignored. */
  only?: readonly string[];
  /** Optional hook, defaults to {@link invokeCritic}. Specs inject a stub. */
  critic?: CriticInvoker;
  /** Verbose progress logger; defaults to a no-op. */
  log?: (msg: string) => void;
  /** Optional rubric override (specs keep prompts tiny). */
  template?: string;
}

/**
 * Render the combined human report. One top-level section summarises
 * counts; each per-eval section names the winner + loser, quotes the
 * comparator reason, and lists winner strengths, loser weaknesses, and
 * suggestions (priority + category + text + expected impact).
 */
export function renderAnalysisMarkdown(result: RunAnalyzeResult): string {
  const lines: string[] = [];
  lines.push(`# analyze ${result.skill}: iteration-${result.iteration_a} vs iteration-${result.iteration_b}`);
  lines.push('');
  lines.push(
    `- analyzed: ${result.records.length}`,
    `- skipped (ties): ${result.skipped.length}`,
    `- errors: ${result.errors.length}`,
    '',
  );

  for (const r of result.records) {
    lines.push(`## ${r.eval_id} - winner iteration-${r.winner_iteration}, loser iteration-${r.loser_iteration}`, '');
    if (r.comparator_reason.trim().length > 0) {
      lines.push('**Comparator reason:**', '', `> ${r.comparator_reason.replace(/\n/g, ' ')}`, '');
    }

    lines.push(`### Winner strengths (iteration-${r.winner_iteration})`, '');
    if (r.verdict.winner_strengths.length === 0) lines.push('- _(none)_');
    for (const s of r.verdict.winner_strengths) lines.push(`- ${s}`);
    lines.push('');

    lines.push(`### Loser weaknesses (iteration-${r.loser_iteration})`, '');
    if (r.verdict.loser_weaknesses.length === 0) lines.push('- _(none)_');
    for (const w of r.verdict.loser_weaknesses) lines.push(`- ${w}`);
    lines.push('');

    lines.push(`### Suggestions for iteration-${r.loser_iteration}`, '');
    if (r.verdict.improvement_suggestions.length === 0) {
      lines.push('- _(none)_', '');
    } else {
      for (const s of r.verdict.improvement_suggestions) {
        const impact = s.expected_impact.trim().length > 0 ? ` _(impact: ${s.expected_impact})_` : '';
        lines.push(`- **[${s.priority}]** _${s.category}_ - ${s.suggestion}${impact}`);
      }
      lines.push('');
    }

    const insights = r.verdict.transcript_insights;
    if (insights && (insights.winner_execution_pattern || insights.loser_execution_pattern)) {
      lines.push('### Transcript insights', '');
      if (insights.winner_execution_pattern) lines.push(`- **winner:** ${insights.winner_execution_pattern}`);
      if (insights.loser_execution_pattern) lines.push(`- **loser:** ${insights.loser_execution_pattern}`);
      lines.push('');
    }
  }

  if (result.skipped.length > 0) {
    lines.push('## skipped', '');
    for (const s of result.skipped) lines.push(`- ${s.eval_id}: ${s.reason}`);
    lines.push('');
  }
  if (result.errors.length > 0) {
    lines.push('## errors', '');
    for (const e of result.errors) lines.push(`- ${e.eval_id}: ${e.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Run the post-hoc analyzer for every compare record with a decided
 * winner. Ties are recorded under `skipped` (not an error); missing
 * prompt files / critic failures / unparseable JSON are recorded under
 * `errors`. The overall run keeps going so a single bad eval doesn't
 * tank the aggregate.
 */
export function runAnalyze(input: RunAnalyzeInput): RunAnalyzeResult {
  const critic: CriticInvoker = input.critic ?? invokeCritic;
  const log = input.log ?? ((): void => undefined);
  const template = input.template ?? loadAnalyzerTemplate();

  const records =
    input.compareRecords ?? loadCompareRecords(input.workspace, input.skill, input.iterationA, input.iterationB);
  const evalById = new Map(input.evals.map((e) => [e.id, e]));
  const onlySet = input.only && input.only.length > 0 ? new Set(input.only) : null;

  const outDir = compareOutputDir(input.workspace, input.skill, input.iterationA, input.iterationB);
  mkdirSync(outDir, { recursive: true });

  const out: RunAnalyzeResult = {
    skill: input.skill,
    iteration_a: input.iterationA,
    iteration_b: input.iterationB,
    records: [],
    skipped: [],
    errors: [],
  };

  for (const record of records) {
    if (onlySet && !onlySet.has(record.eval_id)) continue;

    if (record.winner_label === 'tie' || record.winner_iteration == null) {
      out.skipped.push({ eval_id: record.eval_id, reason: 'tie - no loser to analyze' });
      log(`  skip ${record.eval_id}: tie`);
      continue;
    }

    const ev = evalById.get(record.eval_id);
    if (!ev) {
      out.errors.push({ eval_id: record.eval_id, reason: 'eval not found in evals.json' });
      log(`  skip ${record.eval_id}: eval not found`);
      continue;
    }

    const winnerIteration = record.winner_iteration;
    const loserIteration = winnerIteration === record.iteration_a ? record.iteration_b : record.iteration_a;
    const winnerLabel = record.winner_label;

    const winnerTranscriptPath = record.winner_label === 'A' ? record.output_a_path : record.output_b_path;
    const loserTranscriptPath = record.winner_label === 'A' ? record.output_b_path : record.output_a_path;

    const winnerSkillPath = promptFilePath(input.workspace, input.skill, winnerIteration, record.eval_id);
    const loserSkillPath = promptFilePath(input.workspace, input.skill, loserIteration, record.eval_id);

    let winnerSkillBody: string;
    let loserSkillBody: string;
    let winnerTranscript: string;
    let loserTranscript: string;
    try {
      winnerSkillBody = extractSkillBodyFromPrompt(readFileSync(winnerSkillPath, 'utf8'));
      loserSkillBody = extractSkillBodyFromPrompt(readFileSync(loserSkillPath, 'utf8'));
      winnerTranscript = readFileSync(winnerTranscriptPath, 'utf8');
      loserTranscript = readFileSync(loserTranscriptPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.errors.push({ eval_id: record.eval_id, reason: `failed to read inputs: ${msg}` });
      log(`  skip ${record.eval_id}: ${msg}`);
      continue;
    }

    const prompt = buildAnalyzerPrompt(
      {
        skill: input.skill,
        evalId: record.eval_id,
        evalPrompt: ev.prompt,
        expectations: ev.expectations,
        winnerIteration,
        loserIteration,
        winnerLabel,
        comparatorReason: record.reason,
        winnerSkillPath,
        loserSkillPath,
        winnerSkillBody,
        loserSkillBody,
        winnerTranscriptPath,
        loserTranscriptPath,
        winnerTranscript,
        loserTranscript,
      },
      template,
    );

    const promptFile = join(outDir, `analyze-${record.eval_id}.prompt.txt`);
    const criticOutFile = join(outDir, `analyze-${record.eval_id}.critic-out.txt`);
    writeFileSync(promptFile, prompt);

    log(`  analyzing ${input.skill}/${record.eval_id}: winner=iteration-${winnerIteration}`);
    const { exitCode, stdout } = critic(input.criticCmd, promptFile, criticOutFile);
    if (exitCode !== 0) {
      const msg = `critic exit ${exitCode} (see ${criticOutFile})`;
      log(`  skip ${record.eval_id}: ${msg}`);
      out.errors.push({ eval_id: record.eval_id, reason: msg });
      continue;
    }

    let verdict: AnalyzerVerdict;
    try {
      verdict = parseAnalyzerVerdict(stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  skip ${record.eval_id}: ${msg}`);
      out.errors.push({ eval_id: record.eval_id, reason: msg });
      continue;
    }

    const analyzeRecord: AnalyzeRecord = {
      skill: input.skill,
      eval_id: record.eval_id,
      iteration_a: input.iterationA,
      iteration_b: input.iterationB,
      winner_iteration: winnerIteration,
      loser_iteration: loserIteration,
      winner_label: winnerLabel,
      winner_skill_path: winnerSkillPath,
      loser_skill_path: loserSkillPath,
      winner_transcript_path: winnerTranscriptPath,
      loser_transcript_path: loserTranscriptPath,
      comparator_reason: record.reason,
      verdict,
    };
    const recordFile = analyzeRecordPath(
      input.workspace,
      input.skill,
      input.iterationA,
      input.iterationB,
      record.eval_id,
    );
    mkdirSync(dirname(recordFile), { recursive: true });
    writeFileSync(recordFile, `${JSON.stringify(analyzeRecord, null, 2)}\n`);
    out.records.push(analyzeRecord);
  }

  // Persist the combined markdown alongside the per-eval records so the
  // caller can cat/`glow` it without re-rendering.
  const md = renderAnalysisMarkdown(out);
  writeFileSync(analysisReportPath(input.workspace, input.skill, input.iterationA, input.iterationB), md);
  return out;
}
