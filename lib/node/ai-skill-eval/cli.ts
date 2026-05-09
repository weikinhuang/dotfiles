// CLI entry for ai-skill-eval: argparse + subcommand dispatch.
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runPool } from './concurrency.ts';
import { buildCriticPrompt, mergeCriticVerdict, writeCriticPrompt } from './critic.ts';
import { countEvals, discoverSkills, loadEvalsFile, resolveScanRoots } from './discovery.ts';
import { invokeCritic, invokeDriver, type DriverConfig } from './driver.ts';
import { DEFAULT_TRIGGER_THRESHOLD, gradeDeterministic, parseReply, pickMajorityRunIndex } from './grader.ts';
import { buildEvalPrompt, resolveRunsPerQuery } from './prompt.ts';
import { hasFailures, loadGrades, renderJson, renderMarkdown, summarize } from './report.ts';
import { type DriverKind, type EvalSpec, type EvalsFile, type GradeConfig, type SkillEntry } from './types.ts';
import { formatFailure, validateSkillMd, type ValidationFailure } from './validate.ts';

const PROG = 'ai-skill-eval';
const VERSION = '0.1.0';
const DEFAULT_WORKSPACE = '.ai-skill-eval';

const HELP_TEXT = `Usage: ai-skill-eval <subcommand> [options]

A harness-agnostic CLI for validating SKILL.md files with an LLM. Discovers
SKILL.md files, runs sibling evals/evals.json scenarios through a driver
(pi / claude / codex / custom command), grades TRIGGER detection and
expectation keyword-match, and emits a markdown report.

Subcommands:
  list                      List discovered skills with eval counts.
  run    [SKILL...]         Run evals (and grade + report) for named skills or all discovered.
  grade  [SKILL...]         Grade existing result files without re-running.
  rerun  SKILL:EVAL_ID...   Re-run named evals (e.g. 'plugin-conventions:positive-1').
  report [SKILL...]         Render markdown report from an existing workspace.
  validate [SKILL...]       Validate SKILL.md frontmatter (name / description /
                            compatibility / whitelist keys). No driver calls.

Global options:
  --skill-root DIR          Directory to scan for SKILL.md files (repeatable).
                            Defaults to these if they exist in cwd:
                              .agents/skills, config/agents/skills,
                              config/pi/skills, .claude/skills
  --workspace DIR           Where to write results. Default: .ai-skill-eval/
  --driver pi|claude|codex  Built-in driver. Default: auto-detected from PATH
                            (probe order pi \u2192 claude \u2192 codex).
  --model ID                Model id passed to the driver.
                            Defaults: pi \u2192 env AI_SKILL_EVAL_MODEL or
                            llama-cpp/qwen3-6-35b-a3b; claude / codex \u2192 driver default.
  --driver-cmd SHELL        Custom driver command. Reads the prompt from the
                            file at $AI_SKILL_EVAL_PROMPT_FILE, writes the
                            model reply to stdout. Overrides --driver.
  --critic-cmd SHELL        Optional critic driver for subjective grading
                            (same protocol). When set, critic JSON verdicts
                            replace the default keyword-match grade.
  --runs-per-query N        Run each eval N times and aggregate the TRIGGER
                            votes into a trigger-rate. Overrides any
                            \`runs_per_query\` in evals.json. Default: 3.
  --trigger-threshold T     Pass threshold (0.0–1.0) for trigger_rate.
                            \`>= T\` for should_trigger=true, \`< T\` for
                            should_trigger=false. Default: 0.5.
  --num-workers W           Run up to W driver invocations in parallel.
                            Default: 1 (safe for local llama-cpp / pi;
                            raise for hosted-model drivers that tolerate
                            parallelism).
  --timeout T               Kill any single driver call that exceeds T
                            seconds; the run's output file gets a
                            \`DRIVER_TIMEOUT\` marker appended and the grade
                            surfaces it in \`flaws\`. Default: 30. \`0\` or
                            negative disables the timeout.
  --baseline                Also run each eval in a \`without_skill\` baseline
                            variant (scenario + structured-output request,
                            no SKILL block). Report gains a side-by-side
                            delta column. Default: off.
  --only EVAL_ID            Filter to specific eval IDs (repeatable).
  --json                    Machine-readable JSON output (for list / report).
  -v, --verbose             Log each invocation to stderr.
  -h, --help                Show this help.
  --version                 Print version and exit.

Environment:
  AI_SKILL_EVAL_MODEL       Default model ID when --model is unset.
  AI_SKILL_EVAL_WORKSPACE   Default workspace when --workspace is unset.
  AI_SKILL_EVAL_DRIVER      Default driver when --driver is unset.
  AI_SKILL_EVAL_PROMPT_FILE Set by the tool when invoking --driver-cmd /
                            --critic-cmd; path to the prompt text file.

Examples:
  ai-skill-eval list
  ai-skill-eval run
  ai-skill-eval run plugin-conventions --model llama-cpp/qwen3-6-35b-a3b
  ai-skill-eval rerun bats-test-conventions:positive-1
  ai-skill-eval grade plugin-conventions --critic-cmd 'claude -p "$(cat "$AI_SKILL_EVAL_PROMPT_FILE")" --bare'
  ai-skill-eval report --json

Eval schema (<skill-dir>/evals/evals.json):
  { "skill_name": "...", "evals": [
      { "id": "positive-1", "should_trigger": true,
        "prompt": "...", "expectations": ["..."] }
  ]}

Exit codes: 0 ok, 1 validation/run error, 2 usage error.
`;

type Subcommand = 'list' | 'run' | 'grade' | 'rerun' | 'report' | 'validate';

interface CliOptions {
  subcommand: Subcommand;
  skillRoots: string[];
  skillFilters: string[]; // --only values
  rerunTargets: string[]; // rerun positional args
  positional: string[]; // list/run/grade/report positional args
  workspace: string;
  driver: DriverKind | null;
  driverCmd: string | null;
  model: string | null;
  criticCmd: string | null;
  runsPerQuery: number | null;
  triggerThreshold: number;
  numWorkers: number;
  timeoutMs: number;
  baseline: boolean;
  json: boolean;
  verbose: boolean;
}

export class UsageError extends Error {
  readonly code = 2;
}

export class RuntimeError extends Error {
  readonly code = 1;
}

function die(msg: string): never {
  throw new RuntimeError(msg);
}

function usageErr(msg: string): never {
  throw new UsageError(msg);
}

function valueFor(flag: string, argv: string[], i: number): { value: string; advance: number } {
  if (flag.includes('=')) {
    return { value: flag.slice(flag.indexOf('=') + 1), advance: 1 };
  }
  if (i + 1 >= argv.length) usageErr(`missing value for ${flag.split('=')[0]}`);
  return { value: argv[i + 1] ?? '', advance: 2 };
}

function isKnownDriver(v: string): v is DriverKind {
  return v === 'pi' || v === 'claude' || v === 'codex';
}

export function parseArgs(argv: readonly string[]): CliOptions {
  if (argv.length === 0) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const first = argv[0] ?? '';
  if (first === '-h' || first === '--help') {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  if (first === '--version') {
    process.stdout.write(`${PROG} ${VERSION}\n`);
    process.exit(0);
  }

  let subcommand: Subcommand;
  switch (first) {
    case 'list':
    case 'run':
    case 'grade':
    case 'rerun':
    case 'report':
    case 'validate':
      subcommand = first;
      break;
    default:
      if (first.startsWith('-')) {
        usageErr(`unknown option '${first}' (expected subcommand: list, run, grade, rerun, report, validate)`);
      }
      usageErr(`unknown subcommand '${first}'`);
  }

  const opts: CliOptions = {
    subcommand,
    skillRoots: [],
    skillFilters: [],
    rerunTargets: [],
    positional: [],
    workspace: '',
    driver: null,
    driverCmd: null,
    model: null,
    criticCmd: null,
    runsPerQuery: null,
    triggerThreshold: DEFAULT_TRIGGER_THRESHOLD,
    numWorkers: 1,
    timeoutMs: 30_000,
    baseline: false,
    json: false,
    verbose: false,
  };

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i] ?? '';
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    switch (name) {
      case '--skill-root': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        opts.skillRoots.push(value);
        i += advance;
        break;
      }
      case '--workspace': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        opts.workspace = value;
        i += advance;
        break;
      }
      case '--driver': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        if (!isKnownDriver(value)) {
          die(`unknown driver '${value}' (expected pi, claude, or set --driver-cmd)`);
        }
        opts.driver = value;
        i += advance;
        break;
      }
      case '--driver-cmd': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        opts.driverCmd = value;
        i += advance;
        break;
      }
      case '--model': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        opts.model = value;
        i += advance;
        break;
      }
      case '--critic-cmd': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        opts.criticCmd = value;
        i += advance;
        break;
      }
      case '--runs-per-query': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          usageErr(`--runs-per-query expects a positive integer, got '${value}'`);
        }
        opts.runsPerQuery = n;
        i += advance;
        break;
      }
      case '--trigger-threshold': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const t = Number.parseFloat(value);
        if (!Number.isFinite(t) || t < 0 || t > 1) {
          usageErr(`--trigger-threshold expects a number between 0.0 and 1.0, got '${value}'`);
        }
        opts.triggerThreshold = t;
        i += advance;
        break;
      }
      case '--num-workers': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          usageErr(`--num-workers expects a positive integer, got '${value}'`);
        }
        opts.numWorkers = n;
        i += advance;
        break;
      }
      case '--timeout': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const t = Number.parseFloat(value);
        if (!Number.isFinite(t) || t < 0) {
          usageErr(`--timeout expects a non-negative number of seconds, got '${value}'`);
        }
        opts.timeoutMs = Math.round(t * 1000);
        i += advance;
        break;
      }
      case '--only': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        opts.skillFilters.push(value);
        i += advance;
        break;
      }
      case '--json':
        opts.json = true;
        i += 1;
        break;
      case '--baseline':
        opts.baseline = true;
        i += 1;
        break;
      case '-v':
      case '--verbose':
        opts.verbose = true;
        i += 1;
        break;
      case '-h':
      case '--help':
        process.stdout.write(HELP_TEXT);
        process.exit(0);
        break;
      case '--version':
        process.stdout.write(`${PROG} ${VERSION}\n`);
        process.exit(0);
        break;
      case '--':
        i += 1;
        break;
      default:
        if (arg.startsWith('-')) usageErr(`unknown option: ${arg}`);
        if (subcommand === 'rerun') opts.rerunTargets.push(arg);
        else opts.positional.push(arg);
        i += 1;
        break;
    }
  }

  if (!opts.workspace) {
    opts.workspace = process.env.AI_SKILL_EVAL_WORKSPACE ?? DEFAULT_WORKSPACE;
  }

  return opts;
}

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
 * Resolve the per-run result-file paths for one eval, under the given config
 * subtree. Files are `<config>/results/<eval-id>/run-{1..N}.txt` relative to
 * the skill workspace.
 */
function resultFilesFor(skillWs: string, config: GradeConfig, evalId: string, runs: number): string[] {
  const dir = join(skillWs, config, 'results', evalId);
  const out: string[] = [];
  for (let i = 1; i <= runs; i += 1) out.push(join(dir, `run-${i}.txt`));
  return out;
}

/**
 * List any previously-written `<config>/results/<eval-id>/run-*.txt` files,
 * useful for the `grade` subcommand when the caller didn't say how many runs
 * happened.
 */
function existingResultFiles(skillWs: string, config: GradeConfig, evalId: string): string[] {
  const dir = join(skillWs, config, 'results', evalId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^run-\d+\.txt$/.test(f))
    .sort((a, b) => {
      const na = Number.parseInt(a.replace(/^run-|\.txt$/g, ''), 10);
      const nb = Number.parseInt(b.replace(/^run-|\.txt$/g, ''), 10);
      return na - nb;
    })
    .map((f) => join(dir, f));
}

/**
 * Remove legacy result files from pre-R2 workspaces before writing the new
 * layout. Two shapes may linger:
 *   - `results/<eval-id>.txt` (pre-R1a flat file)
 *   - `results/<eval-id>/run-*.txt` (R1a flat per-run dir, sibling of the new
 *     `with_skill/` / `without_skill/` subtrees)
 * The new-layout files live under `<config>/results/…` so the legacy paths
 * are safe to delete unconditionally on any R2 `run`.
 */
function deleteLegacyFlatResult(skillWs: string, evalId: string): void {
  const legacyFlat = join(skillWs, 'results', `${evalId}.txt`);
  if (existsSync(legacyFlat)) rmSync(legacyFlat, { force: true });
  const legacyDir = join(skillWs, 'results', evalId);
  if (existsSync(legacyDir)) rmSync(legacyDir, { recursive: true, force: true });
}

function runOneEvalPrep(
  opts: CliOptions,
  entry: SkillEntry,
  skillBody: string,
  ev: EvalSpec,
  file: EvalsFile,
  config: GradeConfig,
): { runs: number; promptFile: string; resultFiles: string[]; gradeFile: string } {
  const runs = resolveRunsPerQuery(ev, file, opts.runsPerQuery);
  const skillWs = join(opts.workspace, entry.name);
  const promptFile = join(skillWs, config, 'prompts', `${ev.id}.txt`);
  const resultDir = join(skillWs, config, 'results', ev.id);
  const gradeFile = join(skillWs, config, 'grades', `${ev.id}.json`);

  deleteLegacyFlatResult(skillWs, ev.id);
  mkdirSync(dirname(promptFile), { recursive: true });
  mkdirSync(resultDir, { recursive: true });
  mkdirSync(dirname(gradeFile), { recursive: true });
  writeFileSync(promptFile, buildEvalPrompt({ skillBody, scenario: ev.prompt, withSkill: config === 'with_skill' }));

  return { runs, promptFile, resultFiles: resultFilesFor(skillWs, config, ev.id, runs), gradeFile };
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
 * timeout. Failures do not throw — the caller continues on to grading so
 * the resulting grade record reflects the partial run set (trigger_rate
 * drops accordingly, and the grader appends `DRIVER_TIMEOUT` to `flaws`).
 */
async function runDriverJob(opts: CliOptions, job: DriverJob): Promise<void> {
  logVerbose(
    opts,
    `running ${job.entry.name}/${job.ev.id} [${job.config}] run ${job.runIndex + 1}/${job.runs} (should_trigger=${String(job.ev.should_trigger)})`,
  );
  const { exitCode, durationSec, bytes, timedOut } = await invokeDriver(
    driverConfig(opts),
    job.promptFile,
    job.resultFile,
  );
  logVerbose(opts, `  exit=${exitCode} dur=${durationSec}s bytes=${bytes}${timedOut ? ' (TIMEOUT)' : ''}`);
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
    logVerbose(opts, `run: ${entry.name} (${entry.evalsJson})`);
    const skillBody = readFileSync(entry.skillMd, 'utf8');
    const file = loadEvalsFile(entry.evalsJson);
    for (const ev of file.evals) {
      if (!ev.id) continue;
      if (!includesEvalFilter(opts.skillFilters, entry.name, ev.id)) continue;
      for (const config of configs) {
        const prep = runOneEvalPrep(opts, entry, skillBody, ev, file, config);
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
  // Grade after the whole pool has drained — keeps grading serial and
  // deterministic regardless of how the driver jobs interleaved.
  for (const plan of plans) {
    gradeWithOptionalCritic(opts, plan.entry, plan.ev, plan.config, plan.prep.resultFiles, plan.prep.gradeFile);
  }
}

function gradeOnlySkill(opts: CliOptions, entry: SkillEntry): void {
  if (!entry.evalsJson) {
    logVerbose(opts, `skip ${entry.name} (no evals/evals.json)`);
    return;
  }
  logVerbose(opts, `grade: ${entry.name} (${entry.evalsJson})`);
  const file = loadEvalsFile(entry.evalsJson);
  const configs = configsFor(opts);
  for (const ev of file.evals) {
    if (!ev.id) continue;
    if (!includesEvalFilter(opts.skillFilters, entry.name, ev.id)) continue;
    const skillWs = join(opts.workspace, entry.name);
    for (const config of configs) {
      const resultFiles = existingResultFiles(skillWs, config, ev.id);
      const gradeFile = join(skillWs, config, 'grades', `${ev.id}.json`);
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
  const grades = loadGrades(opts.workspace, wanted);
  if (opts.json) {
    process.stdout.write(renderJson(grades));
  } else {
    process.stdout.write(renderMarkdown(grades));
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

    const skillBody = readFileSync(entry.skillMd, 'utf8');
    const file = loadEvalsFile(entry.evalsJson);
    const ev = file.evals.find((e) => e.id === evalId);
    if (!ev) die(`skill '${skillName}' has no eval '${evalId}'`);
    for (const config of configsFor(opts)) {
      plans.push({ entry, ev, config, prep: runOneEvalPrep(opts, entry, skillBody, ev, file, config) });
    }
  }

  await executeRunPlans(opts, plans);
  return renderReport(opts, []);
}

function cmdReport(opts: CliOptions): number {
  return renderReport(opts, opts.positional);
}

/**
 * `ai-skill-eval validate [SKILL...]` — lint SKILL.md frontmatter for every
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
