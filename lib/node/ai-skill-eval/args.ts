// Argument parsing + help text for the `ai-skill-eval` CLI.
//
// Split out from `cli.ts` so the dispatch file stays focused on
// subcommand handlers. All runtime behaviour stays in cli.ts (driver
// calls, workspace I/O, report rendering); this module only knows how
// to shape `argv` into a {@link CliOptions} or print the help / version
// banners. Exports are consumed exclusively by cli.ts today.
//
// SPDX-License-Identifier: MIT

import { DEFAULT_TRIGGER_THRESHOLD } from './grader.ts';
import { type DriverKind } from './types.ts';

/** Program name shown in `--help`, errors, and verbose output. */
export const PROG = 'ai-skill-eval';
/** Current CLI version printed by `--version`. Keep in step with the package bump. */
export const VERSION = '0.1.0';
/** Workspace directory used when neither `--workspace` nor `$AI_SKILL_EVAL_WORKSPACE` is set. */
export const DEFAULT_WORKSPACE = '.ai-skill-eval';

/** Full `--help` text. Rendered on `ai-skill-eval`, `ai-skill-eval -h`, and parse errors. */
export const HELP_TEXT = `Usage: ai-skill-eval <subcommand> [options]

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
  benchmark [SKILL...]      Emit aggregated benchmark.json + benchmark.md for
                            each skill under the workspace (stats over existing
                            grades + per-run metrics sidecars; no driver calls).
  compare  SKILL            Blind A/B comparator over two iterations' reply
                            files. Requires --iterations A,B and --critic-cmd;
                            writes per-eval compare-<eval-id>.json records
                            under iteration-A/vs-iteration-B/ plus a summary.
  analyze  SKILL            Post-hoc analyzer over an existing compare
                            output. Requires --iterations A,B and
                            --critic-cmd; feeds both iterations' rendered
                            SKILL.md plus reply transcripts to the critic
                            and writes analyze-<eval-id>.json + analysis.md
                            under iteration-A/vs-iteration-B/.
  optimize SKILL            Iteratively improve SKILL.md's \`description:\`
                            frontmatter against a trigger-only eval set
                            (<skill>/evals/trigger-evals.json, with fallback
                            to evals.json projected to {query, should_trigger}).
                            Prints the best-scoring description to stdout; pass
                            \`--write\` to rewrite the SKILL.md frontmatter in
                            place after snapshotting the previous description
                            to description-history.json.

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
  --iteration N             Which iteration-N subdir to write into (on run /
                            rerun) or read from (on grade / report /
                            benchmark). Default: auto-allocate the next
                            slot on run, use the latest existing slot on
                            read commands.
  --compare-to N            On 'report', emit a cross-iteration delta
                            against iteration-N as the baseline.
  --iterations A,B          On 'compare', the two iteration slots to diff
                            (comma-separated). A and B must be distinct
                            positive integers and both must already exist
                            under the workspace.
  --eval-set PATH           On 'optimize', explicit path to the trigger eval
                            set. Default: <skill>/evals/trigger-evals.json,
                            falling back to <skill>/evals/evals.json (projected
                            to {query, should_trigger}).
  --holdout F               Fraction (0–1) of the eval set to hold out as a
                            stratified test split. Default: 0.4. \`0\` disables.
  --max-iterations N        Maximum improver iterations. Default: 5.
  --write                   On 'optimize', rewrite SKILL.md's \`description:\`
                            frontmatter with the best iteration's result.
                            Snapshots the previous description to
                            .ai-skill-eval/<skill>/description-history.json
                            and prints a diff before writing. Without --write,
                            optimize prints the best description to stdout.
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
  ai-skill-eval compare my-skill --iterations 1,2 \\
    --critic-cmd 'claude -p "$(cat "$AI_SKILL_EVAL_PROMPT_FILE")" --bare'
  ai-skill-eval analyze my-skill --iterations 1,2 \\
    --critic-cmd 'claude -p "$(cat "$AI_SKILL_EVAL_PROMPT_FILE")" --bare'
  ai-skill-eval report --json

Eval schema (<skill-dir>/evals/evals.json):
  { "skill_name": "...", "evals": [
      { "id": "positive-1", "should_trigger": true,
        "prompt": "...", "expectations": ["..."] }
  ]}

Exit codes: 0 ok, 1 validation/run error, 2 usage error.
`;

export type Subcommand =
  | 'list'
  | 'run'
  | 'grade'
  | 'rerun'
  | 'report'
  | 'validate'
  | 'benchmark'
  | 'compare'
  | 'analyze'
  | 'optimize';

export interface CliOptions {
  subcommand: Subcommand;
  skillRoots: string[];
  /** `--only EVAL_ID` values. */
  skillFilters: string[];
  /** `rerun SKILL:EVAL_ID ...` positional args. */
  rerunTargets: string[];
  /** list / run / grade / report / validate / benchmark / compare / analyze / optimize positional args. */
  positional: string[];
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
  iteration: number | null;
  compareTo: number | null;
  /** Pair of iteration slots from `--iterations A,B`, only valid on `compare` / `analyze`. */
  iterationsPair: [number, number] | null;
  evalSet: string | null;
  holdout: number;
  maxIterations: number;
  write: boolean;
  json: boolean;
  verbose: boolean;
}

/** Thrown on argparse / flag-shape errors. `main()` maps this to exit code 2. */
export class UsageError extends Error {
  readonly code = 2;
}

/** Thrown on runtime errors (missing files, driver failures). `main()` maps this to exit code 1. */
export class RuntimeError extends Error {
  readonly code = 1;
}

/** Throw {@link RuntimeError} with `msg`. Used by cli.ts for runtime failures. */
export function die(msg: string): never {
  throw new RuntimeError(msg);
}

/** Throw {@link UsageError} with `msg`. Used by argparse + flag-shape validation. */
export function usageErr(msg: string): never {
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

/**
 * Parse `argv` (everything past `node script` — i.e. the subcommand is
 * at index 0) into a fully-defaulted {@link CliOptions}. Throws
 * {@link UsageError} on flag-shape problems; `--help` / `--version` /
 * no-args exit the process directly. The {@link RuntimeError} path via
 * {@link die} is used only for the `--driver` unknown-value branch,
 * which historically maps to the runtime exit code.
 */
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
    case 'benchmark':
    case 'compare':
    case 'analyze':
    case 'optimize':
      subcommand = first;
      break;
    default:
      if (first.startsWith('-')) {
        usageErr(
          `unknown option '${first}' (expected subcommand: list, run, grade, rerun, report, validate, benchmark, compare, analyze, optimize)`,
        );
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
    iteration: null,
    compareTo: null,
    iterationsPair: null,
    evalSet: null,
    holdout: 0.4,
    maxIterations: 5,
    write: false,
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
      case '--iteration': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          usageErr(`--iteration expects a positive integer, got '${value}'`);
        }
        opts.iteration = n;
        i += advance;
        break;
      }
      case '--compare-to': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          usageErr(`--compare-to expects a positive integer, got '${value}'`);
        }
        opts.compareTo = n;
        i += advance;
        break;
      }
      case '--iterations': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const parts = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (parts.length !== 2) {
          usageErr(`--iterations expects 'A,B' with two positive integers, got '${value}'`);
        }
        const a = Number.parseInt(parts[0] ?? '', 10);
        const b = Number.parseInt(parts[1] ?? '', 10);
        if (!Number.isFinite(a) || a < 1 || !Number.isFinite(b) || b < 1) {
          usageErr(`--iterations expects two positive integers, got '${value}'`);
        }
        if (a === b) {
          usageErr(`--iterations A and B must differ, got '${value}'`);
        }
        opts.iterationsPair = [a, b];
        i += advance;
        break;
      }
      case '--eval-set': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        opts.evalSet = value;
        i += advance;
        break;
      }
      case '--holdout': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const h = Number.parseFloat(value);
        if (!Number.isFinite(h) || h < 0 || h >= 1) {
          usageErr(`--holdout expects a number in [0.0, 1.0), got '${value}'`);
        }
        opts.holdout = h;
        i += advance;
        break;
      }
      case '--max-iterations': {
        const { value, advance } = valueFor(arg, argv as string[], i);
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          usageErr(`--max-iterations expects a positive integer, got '${value}'`);
        }
        opts.maxIterations = n;
        i += advance;
        break;
      }
      case '--write':
        opts.write = true;
        i += 1;
        break;
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

  if (opts.compareTo != null && opts.subcommand !== 'report') {
    usageErr("--compare-to is only valid on the 'report' subcommand");
  }

  if (opts.iterationsPair != null && opts.subcommand !== 'compare' && opts.subcommand !== 'analyze') {
    usageErr("--iterations is only valid on the 'compare' and 'analyze' subcommands");
  }

  if (opts.write && opts.subcommand !== 'optimize') {
    usageErr("--write is only valid on the 'optimize' subcommand");
  }
  if (opts.evalSet != null && opts.subcommand !== 'optimize') {
    usageErr("--eval-set is only valid on the 'optimize' subcommand");
  }

  return opts;
}
