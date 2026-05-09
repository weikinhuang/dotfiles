// Description-optimization loop (R4).
//
// Port of `~/.claude/skills/skill-creator/scripts/run_loop.py`. Orchestrates:
//
//   1. A stratified train/test split of the trigger eval set.
//   2. Up to N iterations of: render SKILL.md body with the candidate
//      description, evaluate every query via the driver, grade, then call
//      the improver driver with a blinded history to propose the next
//      description. A 1024-char safety-net rewrite kicks in when the
//      improver exceeds the frontmatter length limit.
//   3. Best-iteration selection: pick the description with the highest test
//      score (or train score when no test set exists). Ties break toward
//      the earliest iteration.
//
// The driver invocations are dependency-injected via {@link OptimizerHooks}
// so the spec can exercise the full loop deterministically without spawning
// real subprocesses. `cli.ts` wires the hooks to the existing `invokeDriver`.
//
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runPool } from './concurrency.ts';
import { gradeDeterministic } from './grader.ts';
import {
  buildImproverPrompt,
  buildShortenPrompt,
  MAX_DESCRIPTION_CHARS,
  parseNewDescription,
  type ImproverHistoryEntry,
  type ImproverTriggerResult,
} from './improver.ts';
import { buildEvalPrompt } from './prompt.ts';
import { parseSkillMdText, renderSkillWithDescription, type ParsedSkillMd } from './skill-md.ts';
import { stratifiedSplit } from './train-test-split.ts';
import { cleanLegacyFlat, iterationPath, listIterations, nextIteration, writeLatestSymlink } from './workspace.ts';

/** One trigger-only eval item. `id` is optional; the loop auto-assigns `q-<n>` when absent. */
export interface TriggerEval {
  query: string;
  should_trigger: boolean;
  id?: string;
}

interface EnumeratedEval extends TriggerEval {
  id: string;
}

/**
 * Hooks used by the optimizer to talk to a model. `runEvalDriver` writes the
 * model's structured TRIGGER/REASON/NEXT_STEP reply to `resultFile`;
 * `runImproverDriver` writes the raw improver response (expected to
 * contain `<new_description>…</new_description>`) to `outputFile`.
 *
 * In production both hooks wrap `invokeDriver`; the spec supplies
 * deterministic stubs.
 */
export interface OptimizerHooks {
  runEvalDriver: (promptFile: string, resultFile: string) => Promise<void>;
  runImproverDriver: (promptFile: string, outputFile: string) => Promise<void>;
}

export interface RunOptimizeInput {
  parsed: ParsedSkillMd;
  skillName: string;
  evalSet: readonly TriggerEval[];
  workspace: string;
  holdout: number;
  maxIterations: number;
  runsPerQuery: number;
  triggerThreshold: number;
  numWorkers: number;
  hooks: OptimizerHooks;
  /** Optional starting description override (defaults to `parsed.description`). */
  startingDescription?: string | null;
  /** PRNG seed for the stratified split. Defaults to 42 (upstream Python). */
  seed?: number;
  /** Verbose progress logger. Defaults to a no-op. */
  log?: (msg: string) => void;
}

/** Record of one optimizer iteration — one candidate description + its scores. */
export interface OptimizerIteration {
  /** 1-indexed optimizer iteration number. */
  iteration: number;
  /** Workspace iteration slot (`iteration-<slot>/`) this iteration wrote into. */
  slot: number;
  description: string;
  trainPassed: number;
  trainTotal: number;
  trainResults: ImproverTriggerResult[];
  testPassed: number | null;
  testTotal: number | null;
  testResults: ImproverTriggerResult[] | null;
  /** True when the improver's first proposal exceeded {@link MAX_DESCRIPTION_CHARS} and the shorten rewrite fired. */
  improverOverLong: boolean;
}

export type OptimizeExitReason = 'all_passed' | 'max_iterations';

export interface OptimizeResult {
  originalDescription: string;
  bestDescription: string;
  bestIteration: number;
  bestSlot: number;
  bestScore: string;
  /** Which split the best score was computed against. */
  bestSource: 'test' | 'train';
  exitReason: OptimizeExitReason;
  trainSize: number;
  testSize: number;
  holdout: number;
  iterations: OptimizerIteration[];
}

/** Assign stable ids to eval items so workspace paths are deterministic. */
function enumerateEvalSet(items: readonly TriggerEval[]): EnumeratedEval[] {
  return items.map((e, idx) => ({
    query: e.query,
    should_trigger: e.should_trigger,
    id: e.id && e.id.length > 0 ? e.id : `q-${idx + 1}`,
  }));
}

interface EvalJob {
  promptFile: string;
  resultFile: string;
}

export async function runOptimizeLoop(input: RunOptimizeInput): Promise<OptimizeResult> {
  const {
    parsed,
    skillName,
    evalSet,
    workspace,
    holdout,
    maxIterations,
    runsPerQuery,
    triggerThreshold,
    numWorkers,
    hooks,
  } = input;
  const log = input.log ?? ((_msg: string): void => undefined);
  const seed = input.seed ?? 42;
  const startingDescription = input.startingDescription ?? parsed.description;

  const enumerated = enumerateEvalSet(evalSet);
  const { train, test } = stratifiedSplit(enumerated, holdout, seed);
  log(
    test.length > 0
      ? `Split: ${train.length} train, ${test.length} test (holdout=${holdout})`
      : `No holdout: ${train.length} train, 0 test`,
  );

  // First touch on a fresh workspace should nuke any pre-R3.3 flat
  // layout so our `iteration-<N>` slots land clean.
  if (listIterations(workspace, skillName).length === 0) {
    cleanLegacyFlat(workspace, skillName);
  }

  let currentDescription = startingDescription;
  const iterations: OptimizerIteration[] = [];
  let exitReason: OptimizeExitReason = 'max_iterations';

  for (let iter = 1; iter <= maxIterations; iter += 1) {
    const slot = nextIteration(workspace, skillName);
    const iterDir = iterationPath(workspace, skillName, slot);
    mkdirSync(iterDir, { recursive: true });
    log(`Iteration ${iter}/${maxIterations} -> iteration-${slot}`);

    // Render a candidate SKILL.md (same body, swapped description) so the
    // driver sees the improved skill context.
    const skillBody = renderSkillWithDescription(parsed, currentDescription);

    // Stage prompts + result dirs for every query × every run.
    const queries: EnumeratedEval[] = [...train, ...test];
    const jobs: EvalJob[] = [];
    const resultFilesById = new Map<string, string[]>();

    const promptsDir = join(iterDir, 'with_skill', 'prompts');
    const gradesDir = join(iterDir, 'with_skill', 'grades');
    mkdirSync(promptsDir, { recursive: true });
    mkdirSync(gradesDir, { recursive: true });

    for (const q of queries) {
      const promptFile = join(promptsDir, `${q.id}.txt`);
      writeFileSync(promptFile, buildEvalPrompt({ skillBody, scenario: q.query, withSkill: true }));
      const resultDir = join(iterDir, 'with_skill', 'results', q.id);
      mkdirSync(resultDir, { recursive: true });
      const files: string[] = [];
      for (let r = 1; r <= runsPerQuery; r += 1) {
        const resultFile = join(resultDir, `run-${r}.txt`);
        jobs.push({ promptFile, resultFile });
        files.push(resultFile);
      }
      resultFilesById.set(q.id, files);
    }

    // Fan the driver calls out through the concurrency limiter.
    await runPool(jobs, { limit: numWorkers }, async (job) => {
      await hooks.runEvalDriver(job.promptFile, job.resultFile);
    });

    // Grade each query deterministically + collect compact improver-facing records.
    const resultsById = new Map<string, ImproverTriggerResult>();
    for (const q of queries) {
      const files = resultFilesById.get(q.id) ?? [];
      const gradeFile = join(gradesDir, `${q.id}.json`);
      const grade = gradeDeterministic({
        skill: skillName,
        evalId: q.id,
        config: 'with_skill',
        shouldTrigger: q.should_trigger,
        expectations: [],
        resultFiles: files,
        gradeFile,
        triggerThreshold,
      });
      resultsById.set(q.id, {
        query: q.query,
        should_trigger: q.should_trigger,
        triggers: grade.triggers,
        runs: grade.runs,
        pass: grade.trigger_pass,
      });
    }

    const trainResults = train.map((q) => resultsById.get(q.id)!);
    const testResults = test.length > 0 ? test.map((q) => resultsById.get(q.id)!) : null;
    const trainPassed = trainResults.filter((r) => r.pass).length;
    const testPassed = testResults ? testResults.filter((r) => r.pass).length : null;

    const rec: OptimizerIteration = {
      iteration: iter,
      slot,
      description: currentDescription,
      trainPassed,
      trainTotal: trainResults.length,
      trainResults,
      testPassed,
      testTotal: testResults?.length ?? null,
      testResults,
      improverOverLong: false,
    };
    iterations.push(rec);
    writeLatestSymlink(workspace, skillName, slot);

    log(
      testResults
        ? `  Train: ${trainPassed}/${trainResults.length}, Test: ${testPassed}/${testResults.length}`
        : `  Train: ${trainPassed}/${trainResults.length}`,
    );

    // Exit conditions:
    //   - train set has zero failures (or is empty — vacuous "all pass")
    //   - reached the max-iterations cap
    if (trainPassed === trainResults.length) {
      exitReason = 'all_passed';
      break;
    }
    if (iter === maxIterations) {
      exitReason = 'max_iterations';
      break;
    }

    // Improvement turn.
    const improverDir = join(iterDir, 'optimize', 'improver');
    mkdirSync(improverDir, { recursive: true });
    // History blinding: strip test_* keys before feeding iterations back
    // so the improver can't overfit to held-out data.
    const blindedHistory: ImproverHistoryEntry[] = iterations.map((h) => ({
      iteration: h.iteration,
      description: h.description,
      train_passed: h.trainPassed,
      train_total: h.trainTotal,
      train_results: h.trainResults,
    }));
    const primaryPrompt = buildImproverPrompt({
      skillName,
      skillContent: parsed.raw,
      currentDescription,
      trainResults,
      trainSummary: { passed: trainPassed, total: trainResults.length },
      testSummary: testPassed != null && testResults ? { passed: testPassed, total: testResults.length } : null,
      blindedHistory,
    });
    const primaryPromptFile = join(improverDir, 'prompt.txt');
    const primaryResponseFile = join(improverDir, 'response.txt');
    writeFileSync(primaryPromptFile, primaryPrompt);
    await hooks.runImproverDriver(primaryPromptFile, primaryResponseFile);
    const primaryRaw = readFileSync(primaryResponseFile, 'utf8');
    let candidate = parseNewDescription(primaryRaw);
    const overLong = candidate.length > MAX_DESCRIPTION_CHARS;
    rec.improverOverLong = overLong;

    const transcript: Record<string, unknown> = {
      iteration: iter,
      char_count: candidate.length,
      over_limit: overLong,
      parsed_description: candidate,
    };

    if (overLong) {
      log(`  improver response is ${candidate.length} chars, issuing shortener rewrite`);
      const shortenPrompt = buildShortenPrompt(primaryPrompt, candidate);
      const shortenPromptFile = join(improverDir, 'shorten-prompt.txt');
      const shortenResponseFile = join(improverDir, 'shorten-response.txt');
      writeFileSync(shortenPromptFile, shortenPrompt);
      await hooks.runImproverDriver(shortenPromptFile, shortenResponseFile);
      const shortenRaw = readFileSync(shortenResponseFile, 'utf8');
      const rewritten = parseNewDescription(shortenRaw);
      transcript.rewrite_prompt_file = shortenPromptFile;
      transcript.rewrite_response_file = shortenResponseFile;
      transcript.rewrite_description = rewritten;
      transcript.rewrite_char_count = rewritten.length;
      candidate = rewritten;
    }
    writeFileSync(join(improverDir, 'parsed.json'), `${JSON.stringify(transcript, null, 2)}\n`);

    log(`  new description (${candidate.length} chars): ${candidate.slice(0, 120)}`);
    currentDescription = candidate;
  }

  // Best-iteration selection. Use test score when a test set exists (even
  // when it was added later by a bigger holdout), otherwise fall back to
  // train. Ties break toward the earliest iteration because the forward
  // walk only replaces `best` on a strictly higher score.
  if (iterations.length === 0) {
    // Unreachable in practice: the for-loop body above always pushes at
    // least one iteration before we get here (maxIterations >= 1). An
    // explicit guard avoids a silent `undefined` crawl and makes the
    // invariant legible to future readers.
    throw new Error('optimize: no iterations recorded (maxIterations must be >= 1)');
  }
  const useTest = iterations.some((h) => h.testTotal != null && h.testTotal > 0);
  const bestSource: 'test' | 'train' = useTest ? 'test' : 'train';
  let best: OptimizerIteration = iterations[0];
  for (const it of iterations) {
    const cur = useTest ? (it.testPassed ?? -1) : it.trainPassed;
    const bestVal = useTest ? (best.testPassed ?? -1) : best.trainPassed;
    if (cur > bestVal) best = it;
  }
  const bestScore = useTest
    ? `${best.testPassed ?? 0}/${best.testTotal ?? 0}`
    : `${best.trainPassed}/${best.trainTotal}`;

  return {
    originalDescription: parsed.description,
    bestDescription: best.description,
    bestIteration: best.iteration,
    bestSlot: best.slot,
    bestScore,
    bestSource,
    exitReason,
    trainSize: train.length,
    testSize: test.length,
    holdout,
    iterations,
  };
}

function coerceTriggerEval(item: unknown, sourcePath: string, idx: number): TriggerEval {
  if (!item || typeof item !== 'object') {
    throw new Error(`${sourcePath}: item[${idx}] is not an object`);
  }
  const e = item as { query?: unknown; should_trigger?: unknown; id?: unknown };
  if (typeof e.query !== 'string') {
    throw new Error(`${sourcePath}: item[${idx}].query must be a string`);
  }
  if (typeof e.should_trigger !== 'boolean') {
    throw new Error(`${sourcePath}: item[${idx}].should_trigger must be a boolean`);
  }
  return {
    query: e.query,
    should_trigger: e.should_trigger,
    id: typeof e.id === 'string' ? e.id : undefined,
  };
}

/**
 * Parse a trigger-eval set from JSON text. Accepts either:
 *
 *   - The R4 flat shape: `[{query, should_trigger}, ...]`
 *   - A fallback projection of the full `evals.json`: `{ "evals": [{prompt, should_trigger, ...}] }`
 *     is converted to `[{query: prompt, should_trigger}]`. Expectations are
 *     discarded — the optimizer only scores TRIGGER rate.
 */
export function loadTriggerEvalSet(raw: string, sourcePath: string): TriggerEval[] {
  const data = JSON.parse(raw) as unknown;
  if (Array.isArray(data)) {
    return data.map((item, idx) => coerceTriggerEval(item, sourcePath, idx));
  }
  if (data && typeof data === 'object' && Array.isArray((data as { evals?: unknown }).evals)) {
    return (data as { evals: unknown[] }).evals.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`${sourcePath}: evals[${idx}] is not an object`);
      }
      const e = item as { prompt?: unknown; id?: unknown; should_trigger?: unknown };
      if (typeof e.prompt !== 'string') {
        throw new Error(`${sourcePath}: evals[${idx}].prompt must be a string`);
      }
      if (typeof e.should_trigger !== 'boolean') {
        throw new Error(`${sourcePath}: evals[${idx}].should_trigger must be a boolean`);
      }
      return {
        query: e.prompt,
        should_trigger: e.should_trigger,
        id: typeof e.id === 'string' ? e.id : undefined,
      };
    });
  }
  throw new Error(`${sourcePath}: expected a flat [{query, should_trigger}] list or an {evals: [...]} object`);
}

/** Re-export for callers that want to parse a SKILL.md string into the shape `runOptimizeLoop` expects. */
export { parseSkillMdText };

/** One entry of `.ai-skill-eval/<skill>/description-history.json`. */
export interface DescriptionHistoryEntry {
  timestamp: string;
  description: string;
  /** `replaced` today; reserved for future origins (e.g. `seeded`). */
  source: 'replaced';
  /** Optimizer iteration whose best description was written. */
  iteration: number;
  /** `N/M` score string that picked this iteration (e.g. train=7/8 or test=3/4). */
  score: string;
}

/**
 * Append `entry` to the skill's `description-history.json` and write the
 * updated list back atomically. Creates a fresh single-element file when
 * the history doesn't exist yet. Silently treats an unreadable or
 * malformed existing file as "empty" so a corrupted sidecar never blocks
 * a `--write` run — the whole point is to snapshot the live description
 * before we overwrite it.
 */
export function appendDescriptionHistory(path: string, entry: DescriptionHistoryEntry): DescriptionHistoryEntry[] {
  let prev: DescriptionHistoryEntry[] = [];
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      prev = parsed.filter((e): e is DescriptionHistoryEntry => {
        return (
          !!e &&
          typeof e === 'object' &&
          typeof (e as DescriptionHistoryEntry).description === 'string' &&
          typeof (e as DescriptionHistoryEntry).timestamp === 'string'
        );
      });
    }
  } catch {
    // Missing or corrupt history — start fresh.
  }
  const out = [...prev, entry];
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  return out;
}
