// CLI entry for ai-skill-eval: subcommand dispatch. Argparse + help text
// live in ./args.ts; this file wires parsed options into the per-subcommand
// handlers and the process exit path.
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { analysisReportPath, renderAnalysisMarkdown, runAnalyze, type RunAnalyzeResult } from './analyze.ts';
import { PROG, RuntimeError, UsageError, die, parseArgs, usageErr, type CliOptions } from './args.ts';
import { writeBenchmark, type BenchmarkDocument } from './benchmark.ts';
import {
  aggregateCompare,
  compareOutputDir,
  renderCompareMarkdown,
  runCompare,
  type CompareAggregate,
  type RunCompareResult,
} from './compare.ts';
import { runPool } from './concurrency.ts';
import { buildCriticPrompt, mergeCriticVerdict, writeCriticPrompt } from './critic.ts';
import { countEvals, discoverSkills, loadEvalsFile, resolveScanRoots } from './discovery.ts';
import { invokeCritic, invokeDriver, type DriverConfig } from './driver.ts';
import { gradeDeterministic, parseReply, pickMajorityRunIndex } from './grader.ts';
import {
  appendDescriptionHistory,
  loadTriggerEvalSet,
  runOptimizeLoop,
  type OptimizerHooks,
  type OptimizeResult,
} from './optimizer.ts';
import { buildEvalPrompt, resolveRunsPerQuery } from './prompt.ts';
import {
  hasFailures,
  loadGrades,
  renderCrossIterationMarkdown,
  renderJson,
  renderMarkdown,
  summarize,
} from './report.ts';
import { listRunFiles as sharedListRunFiles, resultDir } from './run-files.ts';
import { parseSkillMd, renderDescriptionDiff, rewriteDescription } from './skill-md.ts';
import { type EvalSpec, type EvalsFile, type GradeConfig, type SkillEntry } from './types.ts';
import { formatFailure, validateSkillMd, type ValidationFailure } from './validate.ts';
import {
  cleanLegacyFlat,
  iterationPath,
  latestIteration,
  listIterations,
  nextIteration,
  writeLatestSymlink,
} from './workspace.ts';

// Re-export the argparse surface so downstream consumers (including specs
// + sibling callers) can still `import { parseArgs, UsageError } from './cli.ts'`.
export { parseArgs, UsageError, RuntimeError, type CliOptions } from './args.ts';

function logVerbose(opts: CliOptions, msg: string): void {
  if (opts.verbose) process.stderr.write(`${PROG}: ${msg}\n`);
}

function driverConfig(opts: CliOptions): DriverConfig {
  return {
    driver: opts.driver,
    driverCmd: opts.driverCmd,
    model: opts.model,
    timeoutMs: opts.timeoutMs > 0 ? opts.timeoutMs : null,
  };
}

function filterSkills(entries: SkillEntry[], wanted: readonly string[]): SkillEntry[] {
  if (wanted.length === 0) return entries;
  const set = new Set(wanted);
  return entries.filter((e) => set.has(e.name));
}

function includesEvalFilter(filters: readonly string[], skill: string, evalId: string): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => f === evalId || f === `${skill}:${evalId}`);
}

/**
 * Run deterministic grading across all run files, then optionally replace
 * expectation scores with the critic's JSON verdict. The critic is always fed
 * a single reply: the majority-trigger run, matching the run used for the
 * deterministic expectation scoring.
 */
function gradeWithOptionalCritic(
  opts: CliOptions,
  entry: SkillEntry,
  ev: EvalSpec,
  config: GradeConfig,
  resultFiles: readonly string[],
  gradeFile: string,
): void {
  gradeDeterministic({
    skill: entry.name,
    evalId: ev.id,
    config,
    shouldTrigger: ev.should_trigger,
    expectations: ev.expectations,
    resultFiles,
    gradeFile,
    triggerThreshold: opts.triggerThreshold,
  });

  if (!opts.criticCmd) return;

  const winnerIdx = pickMajorityRunIndex(resultFiles.map((f) => parseReply(readFileSync(f, 'utf8'))));
  const winnerFile = resultFiles[winnerIdx] ?? resultFiles[0] ?? '';

  const base = gradeFile.replace(/\.json$/, '');
  const criticPromptFile = `${base}.critic-prompt.txt`;
  const criticOutFile = `${base}.critic-out.txt`;
  const criticPrompt = buildCriticPrompt({
    skill: entry.name,
    evalId: ev.id,
    shouldTrigger: ev.should_trigger,
    expectations: ev.expectations,
    resultFile: winnerFile,
  });
  writeCriticPrompt(criticPromptFile, criticPrompt);
  logVerbose(opts, `  critic: grading ${entry.name}/${ev.id} (${config})`);
  const { exitCode, stdout } = invokeCritic(opts.criticCmd, criticPromptFile, criticOutFile);
  if (exitCode !== 0) {
    logVerbose(opts, '  critic: driver failed; keeping deterministic grade');
    return;
  }
  try {
    mergeCriticVerdict(stdout, gradeFile);
  } catch {
    logVerbose(opts, '  critic: JSON parse failed; keeping deterministic grade');
  }
}

/**
 * Resolve the per-run result-file paths for one eval, under the given
 * iteration + config subtree. Files live at
 * `<iterationDir>/<config>/results/<eval-id>/run-{1..N}.txt`.
 */
function resultFilesFor(iterationDir: string, config: GradeConfig, evalId: string, runs: number): string[] {
  const dir = resultDir(iterationDir, config, evalId);
  const out: string[] = [];
  for (let i = 1; i <= runs; i += 1) out.push(join(dir, `run-${i}.txt`));
  return out;
}

/**
 * List any previously-written `<config>/results/<eval-id>/run-*.txt` files
 * under the given iteration directory, useful for the `grade` subcommand
 * when the caller didn't say how many runs happened. Delegates to the
 * shared {@link sharedListRunFiles} so cli / compare / benchmark stay in
 * lockstep on the numeric sort.
 */
function existingResultFiles(iterationDir: string, config: GradeConfig, evalId: string): string[] {
  return sharedListRunFiles(iterationDir, config, evalId);
}

/**
 * Resolve the iteration slot a read-side command should operate on: the
 * caller-provided `--iteration` override, or the latest existing iteration
 * for `skill`. Dies with a friendly error when no iteration exists yet.
 */
function requireIterationForRead(workspace: string, skill: string, override: number | null): number {
  if (override != null) {
    if (!existsSync(iterationPath(workspace, skill, override))) {
      die(`iteration-${override} not found for skill '${skill}'`);
    }
    return override;
  }
  const latest = latestIteration(workspace, skill);
  if (latest == null) {
    die(`no iterations found for skill '${skill}' (run first)`);
  }
  return latest;
}

/**
 * Resolve the iteration slot a `run`/`rerun` should write into. When the
 * caller passed `--iteration N`, we reuse that slot (overwriting any prior
 * results). Otherwise we allocate `latest + 1` so each plain `run` starts a
 * fresh iteration. When the skill has no iteration dirs yet AND legacy flat
 * subdirs linger from a pre-R3.3 workspace, we nuke them so `iteration-1/`
 * lands clean.
 */
function resolveIterationForRun(workspace: string, skill: string, override: number | null): number {
  if (override != null) return override;
  if (listIterations(workspace, skill).length === 0) {
    cleanLegacyFlat(workspace, skill);
  }
  return nextIteration(workspace, skill);
}

function runOneEvalPrep(
  opts: CliOptions,
  entry: SkillEntry,
  skillBody: string,
  ev: EvalSpec,
  file: EvalsFile,
  config: GradeConfig,
  iterationDir: string,
): { runs: number; promptFile: string; resultFiles: string[]; gradeFile: string } {
  const runs = resolveRunsPerQuery(ev, file, opts.runsPerQuery);
  const promptFile = join(iterationDir, config, 'prompts', `${ev.id}.txt`);
  const resultDir = join(iterationDir, config, 'results', ev.id);
  const gradeFile = join(iterationDir, config, 'grades', `${ev.id}.json`);

  mkdirSync(dirname(promptFile), { recursive: true });
  mkdirSync(resultDir, { recursive: true });
  mkdirSync(dirname(gradeFile), { recursive: true });
  writeFileSync(promptFile, buildEvalPrompt({ skillBody, scenario: ev.prompt, withSkill: config === 'with_skill' }));

  return { runs, promptFile, resultFiles: resultFilesFor(iterationDir, config, ev.id, runs), gradeFile };
}

interface DriverJob {
  entry: SkillEntry;
  ev: EvalSpec;
  config: GradeConfig;
  runIndex: number;
  runs: number;
  promptFile: string;
  resultFile: string;
}

/**
 * Run one driver invocation and persist its `.error` marker on failure /
 * timeout. Failures do not throw - the caller continues on to grading so
 * the resulting grade record reflects the partial run set (trigger_rate
 * drops accordingly, and the grader appends `DRIVER_TIMEOUT` to `flaws`).
 */
async function runDriverJob(opts: CliOptions, job: DriverJob): Promise<void> {
  logVerbose(
    opts,
    `running ${job.entry.name}/${job.ev.id} [${job.config}] run ${job.runIndex + 1}/${job.runs} (should_trigger=${String(job.ev.should_trigger)})`,
  );
  const { exitCode, durationSec, bytes, timedOut, tokens, toolCalls } = await invokeDriver(
    driverConfig(opts),
    job.promptFile,
    job.resultFile,
  );
  logVerbose(
    opts,
    `  exit=${exitCode} dur=${durationSec}s bytes=${bytes}${tokens != null ? ` tokens=${tokens}` : ''}${timedOut ? ' (TIMEOUT)' : ''}`,
  );
  // Per-run metrics sidecar feeds the `benchmark` subcommand (R3.2). Written
  // for every run, including failures and timeouts, so aggregate stats have
  // a stable input even when the grader later records DRIVER_TIMEOUT flaws.
  const meta = {
    exit_code: exitCode,
    duration_sec: durationSec,
    bytes,
    timed_out: timedOut,
    tokens,
    tool_calls: toolCalls,
  };
  try {
    writeFileSync(`${job.resultFile}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // Metrics are diagnostic; a write failure should not break the run.
  }
  if (timedOut) {
    writeFileSync(`${job.resultFile}.error`, 'DRIVER_TIMEOUT\n');
  } else if (exitCode !== 0) {
    writeFileSync(`${job.resultFile}.error`, 'DRIVER_FAILED\n');
  }
}

function cmdList(opts: CliOptions): number {
  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const rows = (opts.skillFilters.length > 0 ? filterSkills(all, opts.skillFilters) : all).map((e) => ({
    name: e.name,
    skill_md: e.skillMd,
    eval_count: e.evalsJson ? countEvals(e.evalsJson) : 0,
  }));

  if (opts.json) {
    if (rows.length === 0) {
      process.stdout.write('[]\n');
    } else {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    }
    return 0;
  }

  if (rows.length === 0) {
    const list = roots.length > 0 ? roots.join(' ') : '<none>';
    process.stderr.write(`No SKILL.md files discovered in: ${list}\n`);
    return 0;
  }

  process.stdout.write(`${'SKILL'.padEnd(40)} ${'EVALS'.padStart(5)}  PATH\n`);
  for (const row of rows) {
    process.stdout.write(`${row.name.padEnd(40)} ${String(row.eval_count).padStart(5)}  ${row.skill_md}\n`);
  }
  return 0;
}

interface EvalPlan {
  entry: SkillEntry;
  ev: EvalSpec;
  config: GradeConfig;
  prep: { runs: number; promptFile: string; resultFiles: string[]; gradeFile: string };
}

function configsFor(opts: CliOptions): GradeConfig[] {
  return opts.baseline ? ['with_skill', 'without_skill'] : ['with_skill'];
}

function planRun(opts: CliOptions, entries: readonly SkillEntry[]): EvalPlan[] {
  const plans: EvalPlan[] = [];
  const configs = configsFor(opts);
  for (const entry of entries) {
    if (!entry.evalsJson) {
      logVerbose(opts, `skip ${entry.name} (no evals/evals.json)`);
      continue;
    }
    const iterationN = resolveIterationForRun(opts.workspace, entry.name, opts.iteration);
    const iterDir = iterationPath(opts.workspace, entry.name, iterationN);
    mkdirSync(iterDir, { recursive: true });
    logVerbose(opts, `run: ${entry.name} -> iteration-${iterationN} (${entry.evalsJson})`);
    const skillBody = readFileSync(entry.skillMd, 'utf8');
    const file = loadEvalsFile(entry.evalsJson);
    for (const ev of file.evals) {
      if (!ev.id) continue;
      if (!includesEvalFilter(opts.skillFilters, entry.name, ev.id)) continue;
      for (const config of configs) {
        const prep = runOneEvalPrep(opts, entry, skillBody, ev, file, config, iterDir);
        plans.push({ entry, ev, config, prep });
      }
    }
  }
  return plans;
}

async function executeRunPlans(opts: CliOptions, plans: readonly EvalPlan[]): Promise<void> {
  const jobs: DriverJob[] = [];
  for (const plan of plans) {
    for (let i = 0; i < plan.prep.runs; i += 1) {
      jobs.push({
        entry: plan.entry,
        ev: plan.ev,
        config: plan.config,
        runIndex: i,
        runs: plan.prep.runs,
        promptFile: plan.prep.promptFile,
        resultFile: plan.prep.resultFiles[i] ?? '',
      });
    }
  }
  if (jobs.length === 0) return;
  await runPool(jobs, { limit: opts.numWorkers }, (job) => runDriverJob(opts, job));
  // Grade after the whole pool has drained - keeps grading serial and
  // deterministic regardless of how the driver jobs interleaved.
  for (const plan of plans) {
    gradeWithOptionalCritic(opts, plan.entry, plan.ev, plan.config, plan.prep.resultFiles, plan.prep.gradeFile);
  }
  // Refresh the `latest` symlink per touched skill. Best-effort: silently
  // no-ops on platforms that don't allow symlinks without elevation.
  const touched = new Map<string, number>();
  for (const plan of plans) {
    const latest = latestIteration(opts.workspace, plan.entry.name);
    if (latest != null) touched.set(plan.entry.name, latest);
  }
  for (const [skill, iterN] of touched) writeLatestSymlink(opts.workspace, skill, iterN);
}

function gradeOnlySkill(opts: CliOptions, entry: SkillEntry): void {
  if (!entry.evalsJson) {
    logVerbose(opts, `skip ${entry.name} (no evals/evals.json)`);
    return;
  }
  const iterationN = requireIterationForRead(opts.workspace, entry.name, opts.iteration);
  const iterDir = iterationPath(opts.workspace, entry.name, iterationN);
  logVerbose(opts, `grade: ${entry.name} (${entry.evalsJson}) @ iteration-${iterationN}`);
  const file = loadEvalsFile(entry.evalsJson);
  const configs = configsFor(opts);
  for (const ev of file.evals) {
    if (!ev.id) continue;
    if (!includesEvalFilter(opts.skillFilters, entry.name, ev.id)) continue;
    for (const config of configs) {
      const resultFiles = existingResultFiles(iterDir, config, ev.id);
      const gradeFile = join(iterDir, config, 'grades', `${ev.id}.json`);
      if (resultFiles.length === 0) {
        logVerbose(opts, `grade: missing ${config} results for ${entry.name}/${ev.id} (run first)`);
        continue;
      }
      logVerbose(opts, `grading ${entry.name}/${ev.id} [${config}] across ${resultFiles.length} run(s)`);
      gradeWithOptionalCritic(opts, entry, ev, config, resultFiles, gradeFile);
    }
  }
}

function renderReport(opts: CliOptions, wanted: readonly string[]): number {
  const grades = loadGrades(opts.workspace, wanted, opts.iteration);
  if (opts.json) {
    process.stdout.write(renderJson(grades));
  } else {
    process.stdout.write(renderMarkdown(grades));
  }
  if (opts.compareTo != null) {
    const compared = loadGrades(opts.workspace, wanted, opts.compareTo);
    process.stdout.write(renderCrossIterationMarkdown(grades, compared, opts.compareTo));
  }
  // Baseline grades are diagnostic; the exit code tracks the with_skill run
  // only. Reports on a workspace with zero with_skill grades still fail.
  const withSkillGrades = grades.filter((g) => g.config !== 'without_skill');
  return hasFailures(summarize(withSkillGrades)) ? 1 : 0;
}

/**
 * Walk discovered entries, lint each skill's SKILL.md, write a one-line
 * diagnostic to stderr for every failure, and return the split. The run /
 * grade pre-flight drops invalid skills from the work list; the `validate`
 * subcommand uses the same helper to emit its report.
 */
function preflightValidate(entries: readonly SkillEntry[]): {
  valid: SkillEntry[];
  failures: ValidationFailure[];
} {
  const valid: SkillEntry[] = [];
  const failures: ValidationFailure[] = [];
  for (const entry of entries) {
    const r = validateSkillMd(entry.skillMd);
    if (r.ok) {
      valid.push(entry);
    } else {
      failures.push(r);
      process.stderr.write(`${PROG}: ${formatFailure(r)}\n`);
      process.stderr.write(`${PROG}: skipping '${entry.name}' (frontmatter invalid)\n`);
    }
  }
  return { valid, failures };
}

async function cmdRunOrGrade(opts: CliOptions, mode: 'run' | 'grade'): Promise<number> {
  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const wanted = opts.positional;
  const discovered = filterSkills(all, wanted).filter((e) => e.evalsJson);

  if (discovered.length === 0) {
    const suffix = wanted.length > 0 ? ` matching: ${wanted.join(' ')}` : '';
    die(`no skills with evals/evals.json found${suffix}`);
  }

  // Pre-flight: SKILL.md frontmatter must lint clean before we spawn any
  // driver calls. Invalid skills are reported to stderr and dropped; the
  // final exit code stays 1 if any were skipped.
  const { valid: entries, failures } = preflightValidate(discovered);
  if (entries.length === 0) {
    die('no valid skills remain after pre-flight validation (see stderr for details)');
  }

  if (mode === 'run') {
    const plans = planRun(opts, entries);
    await executeRunPlans(opts, plans);
  } else {
    for (const entry of entries) gradeOnlySkill(opts, entry);
  }

  const reportCode = renderReport(opts, wanted);
  return failures.length > 0 ? Math.max(1, reportCode) : reportCode;
}

async function cmdRerun(opts: CliOptions): Promise<number> {
  if (opts.rerunTargets.length === 0) {
    usageErr('rerun requires at least one SKILL:EVAL_ID argument');
  }

  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const byName = new Map(all.map((e) => [e.name, e]));

  const plans: EvalPlan[] = [];
  const touched = new Set<string>();
  for (const target of opts.rerunTargets) {
    const sep = target.indexOf(':');
    if (sep <= 0) usageErr(`invalid rerun target '${target}' (expected SKILL:EVAL_ID)`);
    const skillName = target.slice(0, sep);
    const evalId = target.slice(sep + 1);
    const entry = byName.get(skillName);
    if (!entry) die(`skill '${skillName}' not found in scan roots: ${roots.join(' ')}`);
    if (!entry.evalsJson) die(`skill '${skillName}' has no evals/evals.json`);

    // Per-skill pre-flight: a malformed SKILL.md in one rerun target still
    // aborts the whole rerun so the user notices.
    const verdict = validateSkillMd(entry.skillMd);
    if (!verdict.ok) {
      process.stderr.write(`${PROG}: ${formatFailure(verdict)}\n`);
      die(`skill '${skillName}' failed frontmatter validation; fix SKILL.md and rerun`);
    }

    // Rerun targets the latest existing iteration by default (or --iteration N).
    const iterationN = requireIterationForRead(opts.workspace, skillName, opts.iteration);
    const iterDir = iterationPath(opts.workspace, skillName, iterationN);

    const skillBody = readFileSync(entry.skillMd, 'utf8');
    const file = loadEvalsFile(entry.evalsJson);
    const ev = file.evals.find((e) => e.id === evalId);
    if (!ev) die(`skill '${skillName}' has no eval '${evalId}'`);
    for (const config of configsFor(opts)) {
      plans.push({ entry, ev, config, prep: runOneEvalPrep(opts, entry, skillBody, ev, file, config, iterDir) });
    }
    touched.add(skillName);
  }

  await executeRunPlans(opts, plans);
  for (const skill of touched) {
    const latest = latestIteration(opts.workspace, skill);
    if (latest != null) writeLatestSymlink(opts.workspace, skill, latest);
  }
  return renderReport(opts, []);
}

function cmdReport(opts: CliOptions): number {
  return renderReport(opts, opts.positional);
}

/**
 * `ai-skill-eval compare SKILL --iterations A,B --critic-cmd '...'` - blind
 * A/B comparator over two iterations' per-eval reply files. Evals are
 * resolved from the skill's `evals/evals.json` so the comparator sees the
 * scenario prompt + expectations for each turn. Per-eval records + a
 * `summary.json` are written under
 * `<workspace>/<skill>/iteration-<A>/vs-iteration-<B>/`; the markdown
 * report goes to stdout (or JSON with `--json`).
 */
function cmdCompare(opts: CliOptions): number {
  if (opts.positional.length !== 1) {
    usageErr("compare requires exactly one SKILL argument (e.g. 'ai-skill-eval compare my-skill --iterations 1,2')");
  }
  if (opts.iterationsPair == null) {
    usageErr('compare requires --iterations A,B');
  }
  if (!opts.criticCmd) {
    usageErr('compare requires --critic-cmd (no built-in model choice)');
  }
  const skillName = opts.positional[0];
  const [iterA, iterB] = opts.iterationsPair;

  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const entry = all.find((e) => e.name === skillName);
  if (!entry) die(`skill '${skillName}' not found in scan roots: ${roots.join(' ')}`);
  if (!entry.evalsJson) die(`skill '${skillName}' has no evals/evals.json`);

  if (!existsSync(iterationPath(opts.workspace, skillName, iterA))) {
    die(`iteration-${iterA} not found under ${opts.workspace}/${skillName}/ (run first)`);
  }
  if (!existsSync(iterationPath(opts.workspace, skillName, iterB))) {
    die(`iteration-${iterB} not found under ${opts.workspace}/${skillName}/ (run first)`);
  }

  const file = loadEvalsFile(entry.evalsJson);
  const evals = file.evals
    .filter((ev) => ev.id && includesEvalFilter(opts.skillFilters, skillName, ev.id))
    .map((ev) => ({ id: ev.id, prompt: ev.prompt, expectations: ev.expectations ?? [] }));
  if (evals.length === 0) {
    die(`no evals to compare for '${skillName}' (evals.json empty or all filtered by --only)`);
  }

  logVerbose(opts, `compare ${skillName}: iteration-${iterA} vs iteration-${iterB} across ${evals.length} eval(s)`);

  const result: RunCompareResult = runCompare({
    workspace: opts.workspace,
    skill: skillName,
    iterationA: iterA,
    iterationB: iterB,
    criticCmd: opts.criticCmd,
    evals,
    log: (msg) => logVerbose(opts, msg),
  });

  if (opts.json) {
    const agg: CompareAggregate = aggregateCompare(result);
    process.stdout.write(`${JSON.stringify({ ...result, aggregate: agg }, null, 2)}\n`);
  } else {
    process.stdout.write(renderCompareMarkdown(result));
  }
  if (result.errors.length > 0) return 1;
  return 0;
}

/**
 * `ai-skill-eval analyze SKILL --iterations A,B --critic-cmd '...'` -
 * R5.2 post-hoc analyzer. Reads the R5.1 compare records under
 * `iteration-A/vs-iteration-B/`, feeds both iterations' rendered SKILL.md
 * plus reply transcripts to the critic, and writes per-eval
 * `analyze-<eval-id>.json` records alongside a combined `analysis.md`
 * markdown report. Ties have no loser so they're recorded under
 * `skipped` rather than `errors`; critic failures / JSON parse failures
 * land under `errors` so the caller can tell the two apart.
 */
function cmdAnalyze(opts: CliOptions): number {
  if (opts.positional.length !== 1) {
    usageErr("analyze requires exactly one SKILL argument (e.g. 'ai-skill-eval analyze my-skill --iterations 1,2')");
  }
  if (opts.iterationsPair == null) {
    usageErr('analyze requires --iterations A,B');
  }
  if (!opts.criticCmd) {
    usageErr('analyze requires --critic-cmd (no built-in model choice)');
  }
  const skillName = opts.positional[0];
  const [iterA, iterB] = opts.iterationsPair;

  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const entry = all.find((e) => e.name === skillName);
  if (!entry) die(`skill '${skillName}' not found in scan roots: ${roots.join(' ')}`);
  if (!entry.evalsJson) die(`skill '${skillName}' has no evals/evals.json`);

  const outDir = compareOutputDir(opts.workspace, skillName, iterA, iterB);
  if (!existsSync(outDir)) {
    die(`no compare output at ${outDir} (run \`ai-skill-eval compare\` first)`);
  }

  const file = loadEvalsFile(entry.evalsJson);
  const evals = file.evals
    .filter((ev) => ev.id)
    .map((ev) => ({ id: ev.id, prompt: ev.prompt, expectations: ev.expectations ?? [] }));
  if (evals.length === 0) {
    die(`no evals found for '${skillName}' in ${entry.evalsJson}`);
  }

  const only = opts.skillFilters.length > 0 ? opts.skillFilters : undefined;
  logVerbose(opts, `analyze ${skillName}: iteration-${iterA} vs iteration-${iterB}`);

  const result: RunAnalyzeResult = runAnalyze({
    workspace: opts.workspace,
    skill: skillName,
    iterationA: iterA,
    iterationB: iterB,
    criticCmd: opts.criticCmd,
    evals,
    only,
    log: (msg) => logVerbose(opts, msg),
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderAnalysisMarkdown(result));
  }
  logVerbose(opts, `analyze: wrote ${analysisReportPath(opts.workspace, skillName, iterA, iterB)}`);
  if (result.errors.length > 0) return 1;
  return 0;
}

/**
 * `ai-skill-eval optimize SKILL` - the R4 description-optimization loop.
 * Loads a trigger eval set, runs {@link runOptimizeLoop} with the same
 * driver abstraction `run` uses, prints the best-scoring description, and
 * (commit 2) rewrites the SKILL.md frontmatter when `--write` is set.
 */
async function cmdOptimize(opts: CliOptions): Promise<number> {
  if (opts.positional.length !== 1) {
    usageErr("optimize requires exactly one SKILL argument (e.g. 'ai-skill-eval optimize my-skill')");
  }
  const skillName = opts.positional[0];

  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const entry = all.find((e) => e.name === skillName);
  if (!entry) die(`skill '${skillName}' not found in scan roots: ${roots.join(' ')}`);

  // Pre-flight: SKILL.md frontmatter must lint clean before we touch it.
  const verdict = validateSkillMd(entry.skillMd);
  if (!verdict.ok) {
    process.stderr.write(`${PROG}: ${formatFailure(verdict)}\n`);
    die(`skill '${skillName}' failed frontmatter validation; fix SKILL.md and retry`);
  }

  const parsed = parseSkillMd(entry.skillMd);

  // Resolve the eval set path. Explicit --eval-set wins; otherwise look
  // for <skill>/evals/trigger-evals.json; fall back to evals.json projected.
  let evalSetPath = opts.evalSet;
  if (!evalSetPath) {
    const triggerPath = join(dirname(entry.skillMd), 'evals', 'trigger-evals.json');
    if (existsSync(triggerPath)) {
      evalSetPath = triggerPath;
    } else if (entry.evalsJson && existsSync(entry.evalsJson)) {
      logVerbose(opts, `no trigger-evals.json; projecting ${entry.evalsJson} to trigger-only`);
      evalSetPath = entry.evalsJson;
    }
  }
  if (!evalSetPath) {
    die(
      `no eval set found for '${skillName}': pass --eval-set PATH, ` +
        'or add <skill>/evals/trigger-evals.json (or evals/evals.json for fallback)',
    );
  }

  const evalSet = loadTriggerEvalSet(readFileSync(evalSetPath, 'utf8'), evalSetPath);
  if (evalSet.length < 2) {
    die(`eval set at ${evalSetPath} has fewer than 2 items; optimize needs both trigger + no-trigger coverage`);
  }

  const cfg = driverConfig(opts);
  // Improver calls are text-generation workloads and run for longer than
  // TRIGGER evals. Bump the improver timeout to at least 300s (mirroring
  // `improve_description.py`), unless the user explicitly disabled timeouts.
  const improverCfg: DriverConfig =
    cfg.timeoutMs == null || cfg.timeoutMs <= 0 ? cfg : { ...cfg, timeoutMs: Math.max(cfg.timeoutMs, 300_000) };

  const hooks: OptimizerHooks = {
    async runEvalDriver(promptFile, resultFile) {
      const { exitCode, durationSec, timedOut } = await invokeDriver(cfg, promptFile, resultFile);
      logVerbose(opts, `  optimize eval exit=${exitCode} dur=${durationSec}s${timedOut ? ' (TIMEOUT)' : ''}`);
      if (timedOut) writeFileSync(`${resultFile}.error`, 'DRIVER_TIMEOUT\n');
      else if (exitCode !== 0) writeFileSync(`${resultFile}.error`, 'DRIVER_FAILED\n');
    },
    async runImproverDriver(promptFile, outputFile) {
      const { exitCode, durationSec, timedOut } = await invokeDriver(improverCfg, promptFile, outputFile);
      logVerbose(opts, `  improver exit=${exitCode} dur=${durationSec}s${timedOut ? ' (TIMEOUT)' : ''}`);
      if (timedOut || exitCode !== 0) {
        throw new Error(
          `improver driver ${timedOut ? 'timed out' : `exited ${exitCode}`} on ${promptFile} (see ${outputFile})`,
        );
      }
    },
  };

  const runs = opts.runsPerQuery ?? 3;
  logVerbose(
    opts,
    `optimize ${skillName}: ${evalSet.length} eval(s), holdout=${opts.holdout}, max-iter=${opts.maxIterations}, runs-per-query=${runs}`,
  );

  const result: OptimizeResult = await runOptimizeLoop({
    parsed,
    skillName,
    evalSet,
    workspace: opts.workspace,
    holdout: opts.holdout,
    maxIterations: opts.maxIterations,
    runsPerQuery: runs,
    triggerThreshold: opts.triggerThreshold,
    numWorkers: opts.numWorkers,
    hooks,
    log: (msg) => logVerbose(opts, msg),
  });

  // Summary on stderr so stdout carries just the best description (lets
  // `--write`-less invocations pipe cleanly into other tools).
  process.stderr.write(
    `${PROG}: best iteration ${result.bestIteration}/${result.iterations.length} ` +
      `(${result.bestSource}=${result.bestScore}, exit=${result.exitReason})\n`,
  );

  if (opts.write) {
    // Snapshot the live description into the per-skill history file
    // BEFORE rewriting SKILL.md, so an interrupted write still leaves
    // the prior description recoverable.
    const historyPath = join(opts.workspace, skillName, 'description-history.json');
    mkdirSync(dirname(historyPath), { recursive: true });
    appendDescriptionHistory(historyPath, {
      timestamp: new Date().toISOString(),
      description: parsed.description,
      source: 'replaced',
      iteration: result.bestIteration,
      score: `${result.bestSource}=${result.bestScore}`,
    });

    process.stdout.write(renderDescriptionDiff(parsed.description, result.bestDescription));
    const { previous } = rewriteDescription(entry.skillMd, result.bestDescription);
    process.stderr.write(`${PROG}: wrote ${entry.skillMd} (previous description snapshotted to ${historyPath})\n`);
    process.stderr.write(`${PROG}: previous description was ${previous.length} chars\n`);
    return 0;
  }

  process.stdout.write(`${result.bestDescription}\n`);
  return 0;
}

/**
 * `ai-skill-eval validate [SKILL...]` - lint SKILL.md frontmatter for every
 * discovered (or named) skill. Exits 1 if any fail, 0 otherwise. No driver
 * calls.
 */
function cmdValidate(opts: CliOptions): number {
  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const wanted = opts.positional;
  const entries = filterSkills(all, wanted);

  if (entries.length === 0) {
    const suffix = wanted.length > 0 ? ` matching: ${wanted.join(' ')}` : '';
    die(`no SKILL.md files found${suffix}`);
  }

  let failed = 0;
  for (const entry of entries) {
    const r = validateSkillMd(entry.skillMd);
    if (r.ok) {
      if (opts.verbose) process.stdout.write(`ok  ${entry.name}  ${entry.skillMd}\n`);
    } else {
      failed += 1;
      process.stderr.write(`${formatFailure(r)}\n`);
    }
  }

  if (!opts.verbose && failed === 0) {
    process.stdout.write(`${entries.length} skill(s) validated\n`);
  }
  return failed > 0 ? 1 : 0;
}

/**
 * `ai-skill-eval benchmark [SKILL...]` - aggregate existing grades +
 * per-run `.meta.json` sidecars under the workspace into a
 * schema-compatible `benchmark.json` + human-readable `benchmark.md` per
 * skill. No driver calls; meant to run after `run` (optionally with
 * `--baseline` to populate the `without_skill` column + delta block).
 *
 * Exits 1 if a named skill has no workspace directory, or if no benchmark
 * could be produced for any skill. Otherwise exits 0 even when one skill
 * is missing a config (we still write whatever we have).
 */
function cmdBenchmark(opts: CliOptions): number {
  if (!existsSync(opts.workspace)) {
    die(`workspace ${opts.workspace} does not exist (run first)`);
  }
  const wanted = opts.positional;
  const skillDirs = readdirSync(opts.workspace).filter((name) => {
    const full = join(opts.workspace, name);
    try {
      return existsSync(full) && readdirSync(full).length > 0;
    } catch {
      return false;
    }
  });
  const selected = wanted.length > 0 ? skillDirs.filter((n) => wanted.includes(n)) : skillDirs;
  if (selected.length === 0) {
    const suffix = wanted.length > 0 ? ` matching: ${wanted.join(' ')}` : '';
    die(`no skill workspaces found${suffix}`);
  }

  const docs: BenchmarkDocument[] = [];
  for (const skill of selected) {
    const iterationN = requireIterationForRead(opts.workspace, skill, opts.iteration);
    const doc = writeBenchmark(opts.workspace, skill, iterationN);
    docs.push(doc);
    const target = join(iterationPath(opts.workspace, skill, iterationN));
    logVerbose(opts, `benchmark: wrote ${target}/benchmark.{json,md} (iteration-${iterationN})`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(docs, null, 2)}\n`);
  } else {
    for (const doc of docs) {
      const iterationN =
        doc.metadata.iteration ?? requireIterationForRead(opts.workspace, doc.metadata.skill_name, opts.iteration);
      const target = iterationPath(opts.workspace, doc.metadata.skill_name, iterationN);
      process.stdout.write(`# ${doc.metadata.skill_name}: benchmark written to ${target}/benchmark.{json,md}\n`);
    }
  }
  return 0;
}

export async function main(argv: readonly string[]): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${PROG}: ${err.message}\n`);
      process.stderr.write(`Run \`${PROG} --help\` for usage.\n`);
      process.exit(err.code);
    }
    throw err;
  }

  mkdirSync(opts.workspace, { recursive: true });

  try {
    let code: number;
    switch (opts.subcommand) {
      case 'list':
        code = cmdList(opts);
        break;
      case 'run':
        code = await cmdRunOrGrade(opts, 'run');
        break;
      case 'grade':
        code = await cmdRunOrGrade(opts, 'grade');
        break;
      case 'rerun':
        code = await cmdRerun(opts);
        break;
      case 'report':
        code = cmdReport(opts);
        break;
      case 'validate':
        code = cmdValidate(opts);
        break;
      case 'benchmark':
        code = cmdBenchmark(opts);
        break;
      case 'compare':
        code = cmdCompare(opts);
        break;
      case 'analyze':
        code = cmdAnalyze(opts);
        break;
      case 'optimize':
        code = await cmdOptimize(opts);
        break;
    }
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${PROG}: ${err.message}\n`);
      process.stderr.write(`Run \`${PROG} --help\` for usage.\n`);
      process.exit(err.code);
    }
    if (err instanceof RuntimeError) {
      process.stderr.write(`${PROG}: ${err.message}\n`);
      process.exit(err.code);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${PROG}: ${msg}\n`);
    process.exit(1);
  }
}
