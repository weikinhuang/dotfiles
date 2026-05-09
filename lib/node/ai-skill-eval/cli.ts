// CLI entry for ai-skill-eval: argparse + subcommand dispatch.
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildCriticPrompt, mergeCriticVerdict, writeCriticPrompt } from './critic.ts';
import { countEvals, discoverSkills, loadEvalsFile, resolveScanRoots } from './discovery.ts';
import { invokeCritic, invokeDriver, type DriverConfig } from './driver.ts';
import { gradeDeterministic } from './grader.ts';
import { buildEvalPrompt } from './prompt.ts';
import { hasFailures, loadGrades, renderJson, renderMarkdown, summarize } from './report.ts';
import { type DriverKind, type EvalSpec, type SkillEntry } from './types.ts';

const PROG = 'ai-skill-eval';
const VERSION = '0.1.0';
const DEFAULT_WORKSPACE = '.ai-skill-eval';

const HELP_TEXT = `Usage: ai-skill-eval <subcommand> [options]

A harness-agnostic CLI for validating SKILL.md files with an LLM. Discovers
SKILL.md files, runs sibling evals/evals.json scenarios through a driver
(pi / claude / custom command), grades TRIGGER detection and expectation
keyword-match, and emits a markdown report.

Subcommands:
  list                      List discovered skills with eval counts.
  run    [SKILL...]         Run evals (and grade + report) for named skills or all discovered.
  grade  [SKILL...]         Grade existing result files without re-running.
  rerun  SKILL:EVAL_ID...   Re-run named evals (e.g. 'plugin-conventions:positive-1').
  report [SKILL...]         Render markdown report from an existing workspace.

Global options:
  --skill-root DIR          Directory to scan for SKILL.md files (repeatable).
                            Defaults to these if they exist in cwd:
                              .agents/skills, config/agents/skills,
                              config/pi/skills, .claude/skills
  --workspace DIR           Where to write results. Default: .ai-skill-eval/
  --driver pi|claude|cmd    Model driver. Default: auto (pi if on PATH, else claude).
  --model ID                Model id passed to the driver.
                            Defaults: pi \u2192 env AI_SKILL_EVAL_MODEL or
                            llama-cpp/qwen3-6-35b-a3b; claude \u2192 driver default.
  --driver-cmd SHELL        Custom driver command. Reads the prompt from the
                            file at $AI_SKILL_EVAL_PROMPT_FILE, writes the
                            model reply to stdout. Overrides --driver.
  --critic-cmd SHELL        Optional critic driver for subjective grading
                            (same protocol). When set, critic JSON verdicts
                            replace the default keyword-match grade.
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

type Subcommand = 'list' | 'run' | 'grade' | 'rerun' | 'report';

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
  return v === 'pi' || v === 'claude';
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
      subcommand = first;
      break;
    default:
      if (first.startsWith('-')) {
        usageErr(`unknown option '${first}' (expected subcommand: list, run, grade, rerun, report)`);
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
  return { driver: opts.driver, driverCmd: opts.driverCmd, model: opts.model };
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

function gradeWithOptionalCritic(
  opts: CliOptions,
  entry: SkillEntry,
  ev: EvalSpec,
  resultFile: string,
  gradeFile: string,
): void {
  gradeDeterministic({
    skill: entry.name,
    evalId: ev.id,
    shouldTrigger: ev.should_trigger,
    expectations: ev.expectations,
    resultFile,
    gradeFile,
  });

  if (!opts.criticCmd) return;

  const base = gradeFile.replace(/\.json$/, '');
  const criticPromptFile = `${base}.critic-prompt.txt`;
  const criticOutFile = `${base}.critic-out.txt`;
  const criticPrompt = buildCriticPrompt({
    skill: entry.name,
    evalId: ev.id,
    shouldTrigger: ev.should_trigger,
    expectations: ev.expectations,
    resultFile,
  });
  writeCriticPrompt(criticPromptFile, criticPrompt);
  logVerbose(opts, `  critic: grading ${entry.name}/${ev.id}`);
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

function runOneEval(opts: CliOptions, entry: SkillEntry, skillBody: string, ev: EvalSpec): void {
  const skillWs = join(opts.workspace, entry.name);
  const promptFile = join(skillWs, 'prompts', `${ev.id}.txt`);
  const resultFile = join(skillWs, 'results', `${ev.id}.txt`);
  const gradeFile = join(skillWs, 'grades', `${ev.id}.json`);

  mkdirSync(dirname(promptFile), { recursive: true });
  mkdirSync(dirname(resultFile), { recursive: true });
  mkdirSync(dirname(gradeFile), { recursive: true });
  writeFileSync(promptFile, buildEvalPrompt(skillBody, ev.prompt));

  logVerbose(opts, `running ${entry.name}/${ev.id} (should_trigger=${String(ev.should_trigger)})`);
  const { exitCode, durationSec, bytes } = invokeDriver(driverConfig(opts), promptFile, resultFile);
  logVerbose(opts, `  exit=${exitCode} dur=${durationSec}s bytes=${bytes}`);
  if (exitCode !== 0) {
    writeFileSync(`${resultFile}.error`, 'DRIVER_FAILED\n');
  }

  gradeWithOptionalCritic(opts, entry, ev, resultFile, gradeFile);
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

function runOrGradeSkill(opts: CliOptions, entry: SkillEntry, mode: 'run' | 'grade'): void {
  if (!entry.evalsJson) {
    logVerbose(opts, `skip ${entry.name} (no evals/evals.json)`);
    return;
  }
  logVerbose(opts, `${mode}: ${entry.name} (${entry.evalsJson})`);
  const skillBody = readFileSync(entry.skillMd, 'utf8');
  const evals = loadEvalsFile(entry.evalsJson).evals;
  for (const ev of evals) {
    if (!ev.id) continue;
    if (!includesEvalFilter(opts.skillFilters, entry.name, ev.id)) continue;
    if (mode === 'run') {
      runOneEval(opts, entry, skillBody, ev);
    } else {
      const skillWs = join(opts.workspace, entry.name);
      const resultFile = join(skillWs, 'results', `${ev.id}.txt`);
      const gradeFile = join(skillWs, 'grades', `${ev.id}.json`);
      try {
        readFileSync(resultFile);
      } catch {
        logVerbose(opts, `grade: missing result ${resultFile} (run first)`);
        continue;
      }
      logVerbose(opts, `grading ${entry.name}/${ev.id}`);
      gradeWithOptionalCritic(opts, entry, ev, resultFile, gradeFile);
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
  return hasFailures(summarize(grades)) ? 1 : 0;
}

function cmdRunOrGrade(opts: CliOptions, mode: 'run' | 'grade'): number {
  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const wanted = opts.positional;
  const entries = filterSkills(all, wanted).filter((e) => e.evalsJson);

  if (entries.length === 0) {
    const suffix = wanted.length > 0 ? ` matching: ${wanted.join(' ')}` : '';
    die(`no skills with evals/evals.json found${suffix}`);
  }

  for (const entry of entries) {
    runOrGradeSkill(opts, entry, mode);
  }

  return renderReport(opts, wanted);
}

function cmdRerun(opts: CliOptions): number {
  if (opts.rerunTargets.length === 0) {
    usageErr('rerun requires at least one SKILL:EVAL_ID argument');
  }

  const roots = resolveScanRoots(opts.skillRoots);
  const all = discoverSkills(roots);
  const byName = new Map(all.map((e) => [e.name, e]));

  for (const target of opts.rerunTargets) {
    const sep = target.indexOf(':');
    if (sep <= 0) usageErr(`invalid rerun target '${target}' (expected SKILL:EVAL_ID)`);
    const skillName = target.slice(0, sep);
    const evalId = target.slice(sep + 1);
    const entry = byName.get(skillName);
    if (!entry) die(`skill '${skillName}' not found in scan roots: ${roots.join(' ')}`);
    if (!entry.evalsJson) die(`skill '${skillName}' has no evals/evals.json`);

    const skillBody = readFileSync(entry.skillMd, 'utf8');
    const evals = loadEvalsFile(entry.evalsJson).evals;
    const ev = evals.find((e) => e.id === evalId);
    if (!ev) die(`skill '${skillName}' has no eval '${evalId}'`);
    runOneEval(opts, entry, skillBody, ev);
  }

  return renderReport(opts, []);
}

function cmdReport(opts: CliOptions): number {
  return renderReport(opts, opts.positional);
}

export function main(argv: readonly string[]): void {
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
        code = cmdRunOrGrade(opts, 'run');
        break;
      case 'grade':
        code = cmdRunOrGrade(opts, 'grade');
        break;
      case 'rerun':
        code = cmdRerun(opts);
        break;
      case 'report':
        code = cmdReport(opts);
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
