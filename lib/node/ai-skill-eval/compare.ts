// Blind A/B comparator for ai-skill-eval (R5.1).
//
// Takes two iterations' per-eval reply files and asks a user-supplied
// critic command to pick a winner without knowing which iteration
// produced which reply. The rubric prompt is a raw port of
// `~/.claude/skills/skill-creator/agents/comparator.md`, shipped under
// `prompts/comparator.md` and loaded at runtime.
//
// One compare turn per eval:
//
//   1. Pick the canonical reply file for each iteration (majority-run per
//      eval, falling back to run-1 on a tie, mirroring the grader's
//      {@link pickMajorityRunIndex}).
//   2. Randomise which iteration is labelled A vs B so the critic cannot
//      infer the mapping from file paths alone. The {@link makeRng}
//      default is `Math.random`-backed; specs inject a deterministic PRNG.
//   3. Build the comparator prompt (rubric + inlined inputs + inlined
//      reply contents) and pipe it through {@link invokeCritic}.
//   4. Parse the returned JSON verdict, unblind the winner label back to
//      the concrete iteration, and persist a record at
//      `<workspace>/<skill>/iteration-<A>/vs-iteration-<B>/compare-<eval-id>.json`.
//
// The CLI layer stacks these per-eval records into an aggregate win-rate
// summary plus a per-eval markdown table with the winner + a reason
// snippet. Nothing under `optimize/` or `without_skill/` is touched; we
// only compare `with_skill` replies.
//
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { invokeCritic } from './driver.ts';
import { parseReply, pickMajorityRunIndex } from './grader.ts';
import { listRunFilesAt } from './run-files.ts';
import { iterationPath } from './workspace.ts';

/** Basename of the directory holding per-eval comparator outputs, relative to iteration-A. */
export const VS_DIR_PREFIX = 'vs-iteration-';

const COMPARATOR_TEMPLATE_PATH = fileURLToPath(new URL('./prompts/comparator.md', import.meta.url));

/** Lazy-loaded copy of the rubric prompt template; reset by specs with {@link setComparatorTemplateForTest}. */
let comparatorTemplateCache: string | null = null;

/** Load the rubric prompt template from the sibling `prompts/comparator.md`, cached after the first read. */
export function loadComparatorTemplate(): string {
  if (comparatorTemplateCache != null) return comparatorTemplateCache;
  comparatorTemplateCache = readFileSync(COMPARATOR_TEMPLATE_PATH, 'utf8');
  return comparatorTemplateCache;
}

/** Test hook: override the rubric template so specs can keep prompts short and deterministic. */
export function setComparatorTemplateForTest(template: string | null): void {
  comparatorTemplateCache = template;
}

export interface ComparatorInputs {
  skill: string;
  evalId: string;
  evalPrompt: string;
  expectations: readonly string[];
  outputAPath: string;
  outputBPath: string;
}

/**
 * Compose the full critic prompt: the raw rubric port followed by a
 * clearly-labelled INPUTS section that names every parameter and inlines
 * both reply files (fenced) so the critic doesn't need tool access to
 * read them.
 */
export function buildComparatorPrompt(inputs: ComparatorInputs, template = loadComparatorTemplate()): string {
  const readSafe = (p: string): string => {
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[error reading ${p}: ${msg}]`;
    }
  };
  const bodyA = readSafe(inputs.outputAPath).trimEnd();
  const bodyB = readSafe(inputs.outputBPath).trimEnd();
  const expectationsBlock =
    inputs.expectations.length > 0
      ? inputs.expectations.map((exp, i) => `  ${i + 1}. ${exp}`).join('\n')
      : '  (none — judge on content + structure only)';

  return [
    template.trimEnd(),
    '',
    '---',
    '',
    '## Inputs for this comparison',
    '',
    `Skill: ${inputs.skill}`,
    `Eval:  ${inputs.evalId}`,
    '',
    '- output_a_path: ' + inputs.outputAPath,
    '- output_b_path: ' + inputs.outputBPath,
    '',
    'eval_prompt:',
    '-----',
    inputs.evalPrompt.trimEnd(),
    '-----',
    '',
    'expectations:',
    expectationsBlock,
    '',
    'Output A (from output_a_path):',
    '-----',
    bodyA,
    '-----',
    '',
    'Output B (from output_b_path):',
    '-----',
    bodyB,
    '-----',
    '',
    'Respond with STRICT JSON matching this schema, no prose, no code fences:',
    '{"winner": "A"|"B"|"tie", "reason": "...", "scores": {"a": {"overall_score": 0-10, ...}, "b": {"overall_score": 0-10, ...}}}',
    '',
    'The `scores` object is optional — omit it if you did not generate rubric numbers — but `winner` and `reason` are required.',
  ].join('\n');
}

/** Winner label as it appears in the critic verdict (case-insensitive "A"/"B"/"tie"). */
export type WinnerLabel = 'A' | 'B' | 'tie';

/** Parsed critic verdict. Scores are passed through untouched when present. */
export interface ComparatorVerdict {
  winner: WinnerLabel;
  reason: string;
  scores?: { a?: Record<string, unknown>; b?: Record<string, unknown> };
  raw: unknown;
}

function coerceWinner(value: unknown): WinnerLabel {
  if (typeof value !== 'string') throw new Error(`comparator winner must be a string, got ${typeof value}`);
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'a' || trimmed === 'output a') return 'A';
  if (trimmed === 'b' || trimmed === 'output b') return 'B';
  if (trimmed === 'tie' || trimmed === 'draw' || trimmed === 'equal') return 'tie';
  throw new Error(`comparator winner must be "A", "B", or "tie" (got ${JSON.stringify(value)})`);
}

function isScoresObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normaliseScores(v: Record<string, unknown>): {
  a?: Record<string, unknown>;
  b?: Record<string, unknown>;
} {
  // Accept both {a, b} and {A, B} shapes from a sloppy critic.
  const a = v.a ?? v.A;
  const b = v.b ?? v.B;
  const out: { a?: Record<string, unknown>; b?: Record<string, unknown> } = {};
  if (isScoresObject(a)) out.a = a;
  if (isScoresObject(b)) out.b = b;
  return out;
}

/**
 * Extract the first JSON object from the critic's stdout and coerce it
 * into a {@link ComparatorVerdict}. Accepts `"A"`, `"a"`, `"Output A"`,
 * and `"TIE"` for the winner field; an unrecognised value throws.
 */
export function parseComparatorVerdict(raw: string): ComparatorVerdict {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error('comparator output did not contain a JSON object');
  const verdict = JSON.parse(m[0]) as Record<string, unknown>;
  const winner = coerceWinner(verdict.winner);
  const reason =
    typeof verdict.reason === 'string'
      ? verdict.reason
      : typeof (verdict as { reasoning?: unknown }).reasoning === 'string'
        ? (verdict as { reasoning: string }).reasoning
        : '';
  const scoresRaw = (verdict as { scores?: unknown }).scores;
  const scores = isScoresObject(scoresRaw) ? normaliseScores(scoresRaw) : undefined;
  return { winner, reason, scores, raw: verdict };
}

/** Minimal PRNG contract: returns a number in [0, 1). Deterministic specs inject a seeded stub. */
export type Rng = () => number;

/**
 * Pick which iteration gets label A vs B. Returns an object naming the
 * iteration behind each label so the caller can unblind the critic's
 * answer after the JSON verdict comes back.
 */
export function assignLabels(iterationA: number, iterationB: number, rng: Rng): { A: number; B: number } {
  if (rng() < 0.5) return { A: iterationA, B: iterationB };
  return { A: iterationB, B: iterationA };
}

/**
 * List the `run-*.txt` files for `evalId` under `iteration-<N>/with_skill/`,
 * sorted numerically. Returns `[]` when the directory does not exist.
 * Thin adapter over the shared {@link listRunFilesAt} helper so `compare`,
 * the `grade` CLI path, and the benchmark aggregator all agree on how to
 * enumerate per-run replies.
 */
export function listRunFiles(workspace: string, skill: string, iteration: number, evalId: string): string[] {
  return listRunFilesAt(workspace, skill, iteration, 'with_skill', evalId);
}

/**
 * Pick the canonical reply file for `iteration × evalId`: the majority-run
 * per {@link pickMajorityRunIndex}, falling back to run-1 on a tie.
 * Returns `null` when the iteration has no run files yet (the caller
 * reports the eval as an error instead of throwing).
 */
export function pickCanonicalReplyFile(
  workspace: string,
  skill: string,
  iteration: number,
  evalId: string,
): string | null {
  const files = listRunFiles(workspace, skill, iteration, evalId);
  if (files.length === 0) return null;
  const replies = files.map((p) => parseReply(readFileSync(p, 'utf8')));
  const idx = pickMajorityRunIndex(replies);
  return files[idx] ?? files[0] ?? null;
}

export interface CompareRecord {
  skill: string;
  eval_id: string;
  iteration_a: number;
  iteration_b: number;
  /** Which real iteration sat behind each blind label at compare time. */
  label_mapping: { A: number; B: number };
  output_a_path: string;
  output_b_path: string;
  winner_label: WinnerLabel;
  /** Unblinded winner: the concrete iteration number, or `null` on tie. */
  winner_iteration: number | null;
  reason: string;
  scores?: ComparatorVerdict['scores'];
  /** Raw JSON decoded from the critic's stdout — useful for analyzer/debug. */
  raw_verdict: unknown;
}

/** Short, single-line form of `reason` for the per-eval markdown table. */
function snippet(reason: string, max = 140): string {
  const one = reason.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

/**
 * Directory that per-eval compare records land under, relative to
 * `iteration-<A>/`. Caller creates it on first write.
 */
export function compareOutputDir(workspace: string, skill: string, iterationA: number, iterationB: number): string {
  return join(iterationPath(workspace, skill, iterationA), `${VS_DIR_PREFIX}${iterationB}`);
}

/** Per-eval compare record path: `<compareOutputDir>/compare-<evalId>.json`. */
export function compareRecordPath(
  workspace: string,
  skill: string,
  iterationA: number,
  iterationB: number,
  evalId: string,
): string {
  return join(compareOutputDir(workspace, skill, iterationA, iterationB), `compare-${evalId}.json`);
}

/** Spec-injectable critic surface — signature matches {@link invokeCritic} minus the runtime coupling. */
export type CriticInvoker = (
  criticCmd: string,
  promptFile: string,
  outputFile: string,
) => { exitCode: number; stdout: string };

export interface RunCompareInput {
  workspace: string;
  skill: string;
  iterationA: number;
  iterationB: number;
  criticCmd: string;
  /** One entry per eval being compared. Callers pre-resolve these from the shared evals.json. */
  evals: readonly { id: string; prompt: string; expectations: readonly string[] }[];
  rng?: Rng;
  /** Optional hook, defaults to {@link invokeCritic}. Specs inject a stub. */
  critic?: CriticInvoker;
  /** Verbose progress logger; defaults to a no-op. */
  log?: (msg: string) => void;
  /** Optional rubric override (specs keep prompts tiny). */
  template?: string;
}

export interface CompareError {
  eval_id: string;
  reason: string;
}

export interface RunCompareResult {
  skill: string;
  iteration_a: number;
  iteration_b: number;
  records: CompareRecord[];
  errors: CompareError[];
}

/**
 * Run the blind A/B comparator for every eval in `input.evals`, writing
 * per-eval JSON records + a `summary.json` under
 * `iteration-<A>/vs-iteration-<B>/`. Evals whose iteration is missing a
 * reply file (or whose critic call fails / returns unparseable JSON) are
 * reported via `errors` and skipped — the overall run keeps going so a
 * single bad eval doesn't tank the aggregate.
 */
export function runCompare(input: RunCompareInput): RunCompareResult {
  const rng: Rng = input.rng ?? Math.random;
  const critic: CriticInvoker = input.critic ?? invokeCritic;
  const log = input.log ?? ((): void => undefined);
  const template = input.template ?? loadComparatorTemplate();

  const outDir = compareOutputDir(input.workspace, input.skill, input.iterationA, input.iterationB);
  mkdirSync(outDir, { recursive: true });

  const records: CompareRecord[] = [];
  const errors: CompareError[] = [];

  for (const ev of input.evals) {
    const replyA = pickCanonicalReplyFile(input.workspace, input.skill, input.iterationA, ev.id);
    const replyB = pickCanonicalReplyFile(input.workspace, input.skill, input.iterationB, ev.id);
    if (!replyA || !replyB) {
      const missing = !replyA ? `iteration-${input.iterationA}` : `iteration-${input.iterationB}`;
      const msg = `missing reply file under ${missing}/with_skill/results/${ev.id}/`;
      log(`  skip ${ev.id}: ${msg}`);
      errors.push({ eval_id: ev.id, reason: msg });
      continue;
    }

    const labels = assignLabels(input.iterationA, input.iterationB, rng);
    const outputAPath = labels.A === input.iterationA ? replyA : replyB;
    const outputBPath = labels.B === input.iterationA ? replyA : replyB;

    const prompt = buildComparatorPrompt(
      {
        skill: input.skill,
        evalId: ev.id,
        evalPrompt: ev.prompt,
        expectations: ev.expectations,
        outputAPath,
        outputBPath,
      },
      template,
    );

    const promptFile = join(outDir, `compare-${ev.id}.prompt.txt`);
    const criticOutFile = join(outDir, `compare-${ev.id}.critic-out.txt`);
    writeFileSync(promptFile, prompt);

    log(`  comparing ${input.skill}/${ev.id}: A=iteration-${labels.A}, B=iteration-${labels.B}`);
    const { exitCode, stdout } = critic(input.criticCmd, promptFile, criticOutFile);
    if (exitCode !== 0) {
      const msg = `critic exit ${exitCode} (see ${criticOutFile})`;
      log(`  skip ${ev.id}: ${msg}`);
      errors.push({ eval_id: ev.id, reason: msg });
      continue;
    }

    let verdict: ComparatorVerdict;
    try {
      verdict = parseComparatorVerdict(stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  skip ${ev.id}: ${msg}`);
      errors.push({ eval_id: ev.id, reason: msg });
      continue;
    }

    const winnerIteration = verdict.winner === 'tie' ? null : verdict.winner === 'A' ? labels.A : labels.B;

    const record: CompareRecord = {
      skill: input.skill,
      eval_id: ev.id,
      iteration_a: input.iterationA,
      iteration_b: input.iterationB,
      label_mapping: labels,
      output_a_path: outputAPath,
      output_b_path: outputBPath,
      winner_label: verdict.winner,
      winner_iteration: winnerIteration,
      reason: verdict.reason,
      ...(verdict.scores ? { scores: verdict.scores } : {}),
      raw_verdict: verdict.raw,
    };
    const recordFile = compareRecordPath(input.workspace, input.skill, input.iterationA, input.iterationB, ev.id);
    mkdirSync(dirname(recordFile), { recursive: true });
    writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
    records.push(record);
  }

  const result: RunCompareResult = {
    skill: input.skill,
    iteration_a: input.iterationA,
    iteration_b: input.iterationB,
    records,
    errors,
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export interface CompareAggregate {
  /** Wins for iteration-A (the first `--iterations` value). */
  wins_a: number;
  /** Wins for iteration-B (the second `--iterations` value). */
  wins_b: number;
  ties: number;
  /** Total records with a recorded winner (includes ties). */
  decided: number;
  /** Evals that could not produce a verdict (missing files, critic failures). */
  errors: number;
  /** `wins_a / decided` (0 when `decided === 0`). */
  win_rate_a: number;
  /** `wins_b / decided`. */
  win_rate_b: number;
  /** `ties / decided`. */
  tie_rate: number;
}

/** Aggregate a {@link RunCompareResult} into win-rate counts for the final report. */
export function aggregateCompare(result: RunCompareResult): CompareAggregate {
  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (const r of result.records) {
    if (r.winner_label === 'tie') ties += 1;
    else if (r.winner_iteration === result.iteration_a) winsA += 1;
    else if (r.winner_iteration === result.iteration_b) winsB += 1;
  }
  const decided = winsA + winsB + ties;
  const rate = (n: number): number => (decided === 0 ? 0 : Math.round((n / decided) * 100) / 100);
  return {
    wins_a: winsA,
    wins_b: winsB,
    ties,
    decided,
    errors: result.errors.length,
    win_rate_a: rate(winsA),
    win_rate_b: rate(winsB),
    tie_rate: rate(ties),
  };
}

/**
 * Render a human-readable markdown report: aggregate win-rate line on top,
 * per-eval table below with the winner and a reason snippet. Used both by
 * the CLI's stdout path and by callers that want to pipe the report
 * elsewhere.
 */
export function renderCompareMarkdown(result: RunCompareResult): string {
  const agg = aggregateCompare(result);
  const lines: string[] = [];
  lines.push(`# compare ${result.skill}: iteration-${result.iteration_a} vs iteration-${result.iteration_b}`);
  lines.push('');
  lines.push(
    `- iteration-${result.iteration_a} wins: **${agg.wins_a}** (${agg.win_rate_a})`,
    `- iteration-${result.iteration_b} wins: **${agg.wins_b}** (${agg.win_rate_b})`,
    `- ties: ${agg.ties} (${agg.tie_rate})`,
    `- decided: ${agg.decided}  errors: ${agg.errors}`,
    '',
  );
  if (result.records.length > 0) {
    lines.push('| eval | winner | reason |');
    lines.push('| --- | --- | --- |');
    for (const r of result.records) {
      const winner = r.winner_label === 'tie' ? 'tie' : `iteration-${r.winner_iteration ?? '?'} (${r.winner_label})`;
      lines.push(`| ${r.eval_id} | ${winner} | ${snippet(r.reason)} |`);
    }
    lines.push('');
  }
  if (result.errors.length > 0) {
    lines.push('## errors', '');
    for (const err of result.errors) {
      lines.push(`- ${err.eval_id}: ${err.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
