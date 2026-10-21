/**
 * Pure thinking-level precedence for extensions that swap the model
 * (persona, preset).
 *
 * pi core's `setModel()` resets the thinking level to the per-model or
 * global `defaultThinkingLevel` setting (then clamps it to the model's
 * `thinkingLevelMap`). When an extension calls `pi.setModel()` at
 * `session_start`, that reset silently clobbers an explicit
 * `--thinking off` on the command line (observed: `off` -> settings
 * `high` -> clamped `xhigh` for a llama.cpp Qwen model), and on resume it
 * clobbers a level the user changed mid-session. Callers therefore
 * capture the level BEFORE `setModel()` and re-apply the level this
 * helper picks AFTER it.
 *
 * Precedence:
 *   startup activation:  CLI `--thinking` > override `thinkingLevel` > level before the model swap
 *   interactive switch:  override `thinkingLevel` > level before the model swap
 *
 * The CLI flag only wins at startup (CLI flag, session restore, env
 * default): a later `/persona <name>` / `/preset <name>` or cycle is a
 * fresh, explicit user choice, so the override's own `thinkingLevel`
 * applies then.
 */

/** Mirrors pi's CLI `VALID_THINKING_LEVELS` (cli/args.js). */
export const CLI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CliThinkingLevel = (typeof CLI_THINKING_LEVELS)[number];

function isCliThinkingLevel(value: string | undefined): value is CliThinkingLevel {
  return value !== undefined && (CLI_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Extract the explicit thinking level from pi's argv, mirroring
 * `cli/args.js`: `--thinking <level>` wins; otherwise the
 * `--model <pattern>:<level>` shorthand. Invalid levels are ignored
 * (pi warns and ignores them too). Only the space-separated form is
 * recognised because that is the only form pi's parser accepts.
 */
export function parseCliThinkingLevel(argv: readonly string[]): CliThinkingLevel | undefined {
  let fromThinking: CliThinkingLevel | undefined;
  let fromModel: CliThinkingLevel | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--thinking' && i + 1 < argv.length) {
      const level = argv[++i];
      if (isCliThinkingLevel(level)) fromThinking = level;
    } else if (arg === '--model' && i + 1 < argv.length) {
      const pattern = argv[++i] ?? '';
      const colon = pattern.lastIndexOf(':');
      const suffix = colon >= 0 ? pattern.slice(colon + 1) : undefined;
      fromModel = isCliThinkingLevel(suffix) ? suffix : undefined;
    }
  }
  return fromThinking ?? fromModel;
}

export interface ThinkingAfterModelSwapInput {
  /** True when activation happens at `session_start` (CLI flag / session restore / env default). */
  startup: boolean;
  /** Explicit CLI level from {@link parseCliThinkingLevel}. */
  cliLevel?: string;
  /** The persona's / preset's own `thinkingLevel`. */
  overrideLevel?: string;
  /** `pi.getThinkingLevel()` captured before `pi.setModel()`. */
  levelBeforeModelSwap?: string;
}

/**
 * Pick the thinking level to (re-)apply after a persona / preset model
 * swap. Returns `undefined` when there is nothing to apply.
 */
export function resolveThinkingAfterModelSwap(input: ThinkingAfterModelSwapInput): string | undefined {
  if (input.startup && input.cliLevel) return input.cliLevel;
  return input.overrideLevel ?? input.levelBeforeModelSwap;
}
