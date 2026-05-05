/**
 * Resume helpers for the `/research` pipeline.
 *
 * The deep-research extension persists every stage's output to disk
 * (`plan.json`, `fanout.json`, `findings/sq-*.md`, `sources/*`,
 * `snapshots/sections/sq-*.md`, `report.md`, `snapshots/review/iter-*.md`).
 * This module inspects a run root and decides where a `--resume` flow
 * should re-enter the pipeline, plus the minimal disk-surgery a
 * resume needs to do before re-invoking existing stage functions:
 *
 *   - {@link validateRunRoot}              \u2014 is this directory a plausible run root?
 *   - {@link listRecentRuns}               \u2014 pick the most-recent run when `--run-root` is absent.
 *   - {@link countPriorReviewIterations}   \u2014 N prior review snapshots so the next iter is N+1.
 *   - {@link detectResumeStage}            \u2014 earliest incomplete stage, with reasoning string.
 *   - {@link invalidateIncompleteFanoutTasks} \u2014 flip failed/aborted tasks back to 'pending'
 *                                               so the idempotent fanout re-dispatches them.
 *   - {@link findStubbedSections}          \u2014 scan `report.md` for `[section unavailable: \u2026]`
 *                                               blocks so the extension can surface a
 *                                               targeted "resume from fanout" hint.
 *
 * Pure-data in / pure-data out (modulo disk reads + one atomic
 * rewrite of `fanout.json`). No pi imports.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { atomicWriteFile } from './atomic-write.ts';
import { isUnavailableStub } from './deep-research-structural-check.ts';
import { type ResumeStage } from './research-command-args.ts';
import { paths } from './research-paths.ts';
import { readPlan } from './research-plan.ts';

// ──────────────────────────────────────────────────────────────────────
// Run-root validation.
// ──────────────────────────────────────────────────────────────────────

export interface ValidateRunRootOk {
  ok: true;
  /** Absolute, normalized run root. */
  runRoot: string;
  /** Slug (basename). */
  slug: string;
}
export interface ValidateRunRootErr {
  ok: false;
  error: string;
}
export type ValidateRunRootResult = ValidateRunRootOk | ValidateRunRootErr;

/**
 * Confirm that `runRoot` (absolute or cwd-relative) is a plausible
 * deep-research run root: directory exists and contains a parseable
 * `plan.json`. Returns the absolute path + slug on success.
 */
export function validateRunRoot(cwd: string, runRoot: string): ValidateRunRootResult {
  const abs = isAbsolute(runRoot) ? runRoot : resolve(cwd, runRoot);
  if (!existsSync(abs)) {
    return { ok: false, error: `runRoot does not exist: ${abs}` };
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch (e) {
    return { ok: false, error: `runRoot stat failed: ${(e as Error).message}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `runRoot is not a directory: ${abs}` };
  }
  const planPath = paths(abs).plan;
  if (!existsSync(planPath)) {
    return {
      ok: false,
      error: `runRoot has no plan.json: ${abs} — not a deep-research run`,
    };
  }
  try {
    readPlan(planPath);
  } catch (e) {
    return { ok: false, error: `runRoot has malformed plan.json: ${(e as Error).message}` };
  }
  return { ok: true, runRoot: abs, slug: basename(abs) };
}

// ──────────────────────────────────────────────────────────────────────
// Recent-runs listing (for `--resume` with no `--run-root`).
// ──────────────────────────────────────────────────────────────────────

export interface RunListing {
  runRoot: string;
  slug: string;
  /** `mtime` of `plan.json` (fallback: directory mtime). */
  mtimeMs: number;
}

/**
 * List every directory under `<cwd>/research/` that has a
 * `plan.json`, sorted by mtime descending. Used by the resume flow
 * when `--run-root` is omitted. Returns `[]` if `<cwd>/research/`
 * does not exist.
 */
export function listRecentRuns(cwd: string): RunListing[] {
  const researchDir = join(cwd, 'research');
  if (!existsSync(researchDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(researchDir);
  } catch {
    return [];
  }
  const runs: RunListing[] = [];
  for (const entry of entries) {
    // Skip the quarantine dir the pipeline creates for failed runs.
    if (entry === '_quarantined' || entry.startsWith('.')) continue;
    const runRoot = join(researchDir, entry);
    let dirStat;
    try {
      dirStat = statSync(runRoot);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const planPath = paths(runRoot).plan;
    if (!existsSync(planPath)) continue;
    let mtimeMs = dirStat.mtimeMs;
    try {
      mtimeMs = statSync(planPath).mtimeMs;
    } catch {
      /* keep dir mtime */
    }
    runs.push({ runRoot, slug: entry, mtimeMs });
  }
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runs;
}

// ──────────────────────────────────────────────────────────────────────
// Review-iteration counting.
// ──────────────────────────────────────────────────────────────────────

/**
 * Count the highest iteration number present under
 * `<runRoot>/snapshots/review/iter-NNN-*.md`. Returns `0` when the
 * directory is absent or empty, so the caller can pass
 * `startIteration = count + 1` to resume at iter N+1.
 */
export function countPriorReviewIterations(runRoot: string): number {
  const reviewDir = join(paths(runRoot).snapshots, 'review');
  if (!existsSync(reviewDir)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(reviewDir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const entry of entries) {
    const m = /^iter-(\d{3,})-(structural|subjective)\.md$/.exec(entry);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

// ──────────────────────────────────────────────────────────────────────
// Stage auto-detection.
// ──────────────────────────────────────────────────────────────────────

export interface DetectResumeStageOk {
  ok: true;
  stage: ResumeStage;
  reason: string;
  /** Sub-question ids whose findings are missing or whose fanout state is failed/aborted. */
  needsRefanout: string[];
}
export interface DetectResumeStageErr {
  ok: false;
  error: string;
}
export type DetectResumeStageResult = DetectResumeStageOk | DetectResumeStageErr;

/**
 * Inspect the on-disk state of `runRoot` and return the earliest
 * stage at which a resume should re-enter the pipeline. Precedence
 * (earliest → latest):
 *
 *   1. `plan.json` missing         → error (nothing to resume).
 *   2. any `findings/<id>.md` missing OR `fanout.json` has a non-completed
 *      terminal state (failed/aborted) OR fanout.json absent   → `fanout`.
 *   3. all findings present, no `report.md`                    → `synth`.
 *   4. `report.md` present                                     → `review`.
 *
 * `plan-crit` is not auto-detected (plan-crit's failure surface is
 * a user-visible `checkpoint` outcome; automating re-entry would
 * override an explicit human decision). Users can still force it
 * with `--from=plan-crit`.
 */
export function detectResumeStage(runRoot: string): DetectResumeStageResult {
  const p = paths(runRoot);
  if (!existsSync(p.plan)) {
    return { ok: false, error: `no plan.json under ${runRoot} — nothing to resume` };
  }
  let plan;
  try {
    plan = readPlan(p.plan);
  } catch (e) {
    return { ok: false, error: `plan.json is malformed: ${(e as Error).message}` };
  }
  if (plan.kind !== 'deep-research') {
    return { ok: false, error: `plan is kind=${plan.kind}; expected deep-research` };
  }

  // eslint-disable-next-line no-use-before-define -- sumFanoutDeficit is a function declaration; hoisting is safe
  const needsRefanout = sumFanoutDeficit(
    runRoot,
    plan.subQuestions.map((sq) => sq.id),
  );
  if (needsRefanout.length > 0) {
    return {
      ok: true,
      stage: 'fanout',
      reason: `findings incomplete for: ${needsRefanout.join(', ')}`,
      needsRefanout,
    };
  }

  if (!existsSync(p.report)) {
    return {
      ok: true,
      stage: 'synth',
      reason: `all ${plan.subQuestions.length} findings present but report.md is missing`,
      needsRefanout: [],
    };
  }

  return {
    ok: true,
    stage: 'review',
    reason: 'report.md exists — resuming review phase',
    needsRefanout: [],
  };
}

/**
 * Sub-question ids that need to be re-fanned-out: finding file
 * missing, empty, or the task state in `fanout.json` is
 * failed/aborted/pending. Exported for tests + for the extension
 * to surface a clear "will re-run these" message.
 */
export function sumFanoutDeficit(runRoot: string, subQuestionIds: readonly string[]): string[] {
  const p = paths(runRoot);
  const need = new Set<string>();

  // Findings-file deficit.
  for (const id of subQuestionIds) {
    const findingPath = join(p.findings, `${id}.md`);
    if (!existsSync(findingPath)) {
      need.add(id);
      continue;
    }
    let size = 0;
    try {
      size = statSync(findingPath).size;
    } catch {
      need.add(id);
      continue;
    }
    if (size === 0) need.add(id);
  }

  // Fanout.json deficit.
  if (existsSync(p.fanout)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(p.fanout, 'utf8'));
      if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)) {
        const tasks = (raw as { tasks: unknown[] }).tasks;
        for (const t of tasks) {
          if (t === null || typeof t !== 'object') continue;
          const id = (t as { id?: unknown }).id;
          const state = (t as { state?: unknown }).state;
          if (typeof id !== 'string') continue;
          if (!subQuestionIds.includes(id)) continue;
          if (state === 'failed' || state === 'aborted' || state === 'pending' || state === 'spawned') {
            need.add(id);
          }
        }
      }
    } catch {
      /* malformed fanout.json → treat every sub-question as needing re-fanout */
      for (const id of subQuestionIds) need.add(id);
    }
  } else {
    // No fanout.json at all — every sub-question is a candidate.
    for (const id of subQuestionIds) need.add(id);
  }

  // Preserve plan ordering in the output so the message is stable.
  return subQuestionIds.filter((id) => need.has(id));
}

// ──────────────────────────────────────────────────────────────────────
// Fanout-state invalidation.
// ──────────────────────────────────────────────────────────────────────

export interface InvalidateFanoutResult {
  ok: boolean;
  /** Ids whose state was flipped back to 'pending'. */
  reset: string[];
  /** Ids that were already 'pending' or 'completed' — left alone. */
  untouched: string[];
  /** When `ok=false`, the reason. */
  error?: string;
}

/**
 * Rewrite `<runRoot>/fanout.json` so that every task whose id is in
 * `ids` is forced back to `state: 'pending'`, dropping its prior
 * `output` / `reason` / timestamps. The idempotent {@link
 * ../research-fanout.fanout} call will then re-dispatch those
 * tasks on the next run.
 *
 * Completed tasks in `ids` are also reset: callers pass a vetted
 * `ids` list (typically {@link sumFanoutDeficit}'s output), so a
 * completed-state entry in that list is assumed inconsistent with
 * disk (e.g. the subagent said "completed" but the finding file is
 * missing — the sq-1/sq-3 anti-pattern observed in real runs) and
 * a reset is the correct remedy.
 *
 * If `fanout.json` is absent or malformed the function returns
 * `ok: true` with `reset: []` \u2014 there is nothing to invalidate; the
 * caller should invoke fanout, which will create a fresh file.
 */
export function invalidateIncompleteFanoutTasks(runRoot: string, ids: readonly string[]): InvalidateFanoutResult {
  const fanoutPath = paths(runRoot).fanout;
  if (!existsSync(fanoutPath)) {
    return { ok: true, reset: [], untouched: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fanoutPath, 'utf8'));
  } catch (e) {
    return { ok: false, reset: [], untouched: [], error: `fanout.json parse failed: ${(e as Error).message}` };
  }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reset: [], untouched: [], error: 'fanout.json is not an object' };
  }
  const persisted = raw as { version?: unknown; mode?: unknown; agentName?: unknown; tasks?: unknown };
  if (persisted.version !== 1 || !Array.isArray(persisted.tasks)) {
    return { ok: false, reset: [], untouched: [], error: 'fanout.json has unexpected shape' };
  }

  const idSet = new Set(ids);
  const reset: string[] = [];
  const untouched: string[] = [];

  const nextTasks = persisted.tasks.map((t: unknown) => {
    if (t === null || typeof t !== 'object') return t;
    const task = t as { id?: unknown; prompt?: unknown; state?: unknown };
    if (typeof task.id !== 'string' || typeof task.prompt !== 'string') return t;
    if (!idSet.has(task.id)) {
      untouched.push(task.id);
      return t;
    }
    reset.push(task.id);
    // Drop output/reason/timestamps; keep id + prompt.
    return { id: task.id, prompt: task.prompt, state: 'pending' };
  });

  const nextFanout = {
    version: 1 as const,
    mode: persisted.mode,
    agentName: persisted.agentName,
    tasks: nextTasks,
  };

  try {
    atomicWriteFile(fanoutPath, JSON.stringify(nextFanout, null, 2) + '\n');
  } catch (e) {
    return { ok: false, reset: [], untouched: [], error: `fanout.json write failed: ${(e as Error).message}` };
  }

  return { ok: true, reset, untouched };
}

// ───────────────────────────────────────────────────────────────────
// Stub-section detection (Phase 4 guardrail).
// ───────────────────────────────────────────────────────────────────

export interface StubbedSection {
  /** H2 heading text (verbatim, minus the `## ` prefix and trailing whitespace). */
  heading: string;
  /** Reason string extracted from `[section unavailable: <reason>]`. */
  reason: string;
}

/**
 * Walk `reportPath`, split on `^## ` H2 boundaries, and return any
 * section whose body is a whole-section
 * `[section unavailable: \u2026]` stub emitted by
 * `deep-research-synth-sections`. Used by the extension's review
 * path to surface a targeted "run /research --resume --from=fanout
 * to re-fetch these" hint instead of letting the review loop burn
 * its budget on unfixable sections.
 *
 * Stub detection uses the same predicate the structural check
 * already exempts from the citation rule
 * ({@link ../deep-research-structural-check.isUnavailableStub}),
 * so a section that reports as stubbed here is exactly the set
 * the structural check treats as blameless.
 *
 * Returns `[]` when `reportPath` doesn't exist or can't be read;
 * this helper is advisory and must never break the review flow.
 */
export function findStubbedSections(reportPath: string): StubbedSection[] {
  if (!existsSync(reportPath)) return [];
  let text: string;
  try {
    text = readFileSync(reportPath, 'utf8');
  } catch {
    return [];
  }

  const stubbed: StubbedSection[] = [];
  const lines = text.split(/\r?\n/);
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  const flush = (): void => {
    if (currentHeading === null) return;
    const body = currentBody.join('\n');
    if (isUnavailableStub(body)) {
      const match = /^\[section unavailable:\s*([^\]]*)\]\s*$/.exec(body.trim());
      stubbed.push({
        heading: currentHeading,
        reason: (match?.[1] ?? '').trim(),
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      currentHeading = line.slice(3).trim();
      currentBody = [];
      continue;
    }
    if (currentHeading !== null) currentBody.push(line);
  }
  flush();
  return stubbed;
}
