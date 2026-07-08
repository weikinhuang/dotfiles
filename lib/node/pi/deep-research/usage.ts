/**
 * Usage string for the deep-research extension's `/research` slash
 * command. Kept in a pure sibling module (per the extension USAGE
 * convention in `config/pi/extensions/AGENTS.md`) so the handler,
 * the `--help` path, and the empty-arg path share one source of
 * truth instead of inlining the text.
 *
 * No pi imports.
 */

/** Usage string shown on a bare `/research` invocation. */
export const DEEP_RESEARCH_USAGE =
  'Usage:\n' +
  '  /research <question>                 - run the planner → synth pipeline; writes report.md\n' +
  '  /research --list                     - list runs under ./research/\n' +
  '  /research --selftest                 - run the research-core self-test fixture\n' +
  '  /research --resume [flags]           - resume an existing run; auto-detects stage from\n' +
  '                                         on-disk state unless `--from <stage>` is pinned\n' +
  '\n' +
  'Resume-mode flags (only valid with `--resume`):\n' +
  '  --run-root <path>                    runRoot to resume (default: most-recent run under\n' +
  '                                         ./research/)\n' +
  '  --from <stage>                       pin the resume stage: plan-crit | fanout | synth |\n' +
  '                                         review (overrides auto-detection)\n' +
  '  --sq <id>[,<id>...]                  re-fanout only the named sub-question ids; defaults\n' +
  '                                         --from to fanout when the flag is the sole stage\n' +
  '                                         signal. Unknown ids are rejected against plan.json.\n' +
  '\n' +
  'Question-mode flags (may appear in any order before the question):\n' +
  '  --model provider/id                  override the parent research session’s model;\n' +
  '                                         inherit-mode subagents (web-researcher, plan-crit,\n' +
  '                                         critic) inherit it unless they have their own\n' +
  '                                         per-agent override below. Agents that pin a\n' +
  '                                         specific model in their .md stay pinned.\n' +
  '  --plan-crit-model provider/id        override the research-planning-critic subagent only\n' +
  '                                         (takes precedence over --model).\n' +
  '  --fanout-model provider/id           override every web-researcher fanout spawn only\n' +
  '                                         (takes precedence over --model).\n' +
  '  --critic-model provider/id           override the subjective critic subagent only\n' +
  '                                         (takes precedence over --model).\n' +
  '  --fanout-max-turns N                 maxTurns cap for every web-researcher fanout spawn\n' +
  '                                         (default: web-researcher.md declares 20).\n' +
  '  --critic-max-turns N                 maxTurns cap for the research-planning-critic +\n' +
  '                                         subjective critic spawns.\n' +
  '  --review-max-iter N                  cap on cross-stage review iterations (default 4).\n' +
  '                                         Also honored by `--resume` to extend the budget\n' +
  '                                         on a prior `budget-exhausted` run.\n' +
  '  --fanout-parallel N                  cap simultaneous web-researcher workers. Overrides\n' +
  '                                         plan.budget.maxSubagents for this run. Set to 1\n' +
  '                                         when fanout points at a single local model that\n' +
  '                                         cannot handle concurrent requests.\n' +
  '  --wall-clock <dur>                   wall-clock override. Accepts a bare integer\n' +
  '                                         (seconds) or a suffixed duration (`90s` / `30m` /\n' +
  '                                         `2h`); clamp 24h. Replaces plan.budget.wallClockSec\n' +
  '                                         for this run.';
