/* Read "Internals" at the bottom — public command surface comes
 * first. The `no-use-before-define` rule is disabled at the file
 * scope because TS function declarations are hoisted and this
 * ordering reads top-down (command handler → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Deep-research extension for pi.
 *
 * Registers the `/research` slash command with three sub-forms:
 *
 *   - `/research --list`      → walk `./research/`, print a
 *                                `slug | status | wall-clock | cost`
 *                                table via `research-runs.runListCommand`.
 *   - `/research --selftest`  → run the research-core canned fixture
 *                                via `research-selftest.selftestDeepResearch`
 *                                and report the result.
 *   - `/research <question>`  → full pipeline: planner → self-critic →
 *                                planning-critic → fanout → synth →
 *                                merge → two-stage review
 *                                (structural + subjective critic).
 *
 * Plus the LLM-callable `research` tool, which drives the same
 * pipeline mid-conversation. A single-active-run session flag
 * shared by the slash command and the tool prevents overlap.
 *
 * Phase-5 observability: every macro-phase transition feeds a
 * pure state machine (`deep-research-statusline`) that is
 * rendered into `ctx.ui.setWidget("deep-research", [...])`. A
 * terminal `ctx.ui.notify` fires on pipeline completion or
 * failure with the report path.
 *
 * The heavy lifting (stage orchestration, quarantine decisions,
 * schema validation) lives in `lib/node/pi/deep-research-*.ts`
 * modules. This file is the thin pi-coupled wiring layer: build
 * the parent `AgentSession`, wire `runOneShotAgent` as both the
 * planning-critic runner and the fanout spawner (sync mode for
 * now — background fanout lands in a follow-up once the
 * extension exposes the right subagent handle surface), forward
 * status notifications, and delegate command parsing + summary
 * rendering to the pure helpers in
 * `lib/node/pi/research-runs.ts` and
 * `lib/node/pi/deep-research-tool.ts`.
 *
 * Environment:
 *
 *   PI_DEEP_RESEARCH_DISABLED=1   skip the extension entirely.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  runResearchPipeline,
  type PipelineDeps,
  type PipelineOutcome,
  type ResearchSessionLikeWithLifecycle,
} from '../../../lib/node/pi/deep-research-pipeline.ts';
import { refineReport as refineReportRunner } from '../../../lib/node/pi/deep-research-refine.ts';
import {
  type CriticRunner,
  type RefinementRunner,
  type StructuralRunner,
} from '../../../lib/node/pi/deep-research-review-loop.ts';
import { runDeepResearchReview, type ReviewWireResult } from '../../../lib/node/pi/deep-research-review-wire.ts';
import {
  initialStatuslineState,
  type PhaseEvent,
  reduceStatusline,
  renderStatuslineWidget,
  type StatuslineState,
} from '../../../lib/node/pi/deep-research-statusline.ts';
import { checkReportStructure } from '../../../lib/node/pi/deep-research-structural-check.ts';
import {
  createResearchSessionFlag,
  createResearchToolExecutor,
  type NotifyFn,
  type ResearchSessionFlag,
  type ResearchToolRunOutcome,
} from '../../../lib/node/pi/deep-research-tool.ts';
import { withTransientRetry } from '../../../lib/node/pi/fanout-retry.ts';
import { buildCriticTask, parseVerdict } from '../../../lib/node/pi/iteration-loop-check-critic.ts';
import { type Verdict } from '../../../lib/node/pi/iteration-loop-schema.ts';
import { createAiFetchWebCliClientFromEnv } from '../../../lib/node/pi/research-ai-fetch-web-cli-client.ts';
import { createLiveBudget, DEFAULT_BUDGET_PHASES, type LiveBudget } from '../../../lib/node/pi/research-budget-live.ts';
import { createRunBudget } from '../../../lib/node/pi/research-budget.ts';
import {
  formatOverridesSummary,
  parseResearchCommandArgs,
  type ResearchOverrides,
  type ResumeOverrides,
  type ResumeStage,
  validateToolOverrides,
} from '../../../lib/node/pi/research-command-args.ts';
import { createCostHook } from '../../../lib/node/pi/research-cost-hook.ts';
import {
  type FanoutHandleLike,
  type FanoutHandleResult,
  type FanoutSpawner,
  type FanoutSpawnArgs,
} from '../../../lib/node/pi/research-fanout.ts';
import { appendJournal, sumJournalCostUsd } from '../../../lib/node/pi/research-journal.ts';
import { paths } from '../../../lib/node/pi/research-paths.ts';
import { readPlan } from '../../../lib/node/pi/research-plan.ts';
import {
  countPriorReviewIterations,
  detectProvenanceDrift,
  detectResumeStage,
  formatProvenanceDrift,
  invalidateIncompleteFanoutTasks,
  listRecentRuns,
  scopeFanoutDeficit,
  sumFanoutDeficit,
  validateRunRoot,
} from '../../../lib/node/pi/research-resume.ts';
import {
  type CommandNotify,
  type CommandNotifyLevel,
  findExistingRun,
  runListCommand,
  runSelftestCommand,
} from '../../../lib/node/pi/research-runs.ts';
import { selftestDeepResearch } from '../../../lib/node/pi/research-selftest.ts';
import { formatStubHint } from '../../../lib/node/pi/research-stub-hint.ts';
import {
  type AgentLoadResult,
  type AgentDef,
  defaultAgentLayers,
  loadAgents,
  type ReadLayer,
} from '../../../lib/node/pi/subagent-loader.ts';
import { resolveChildModel, runOneShotAgent, type AgentSessionLike } from '../../../lib/node/pi/subagent-spawn.ts';

/** Usage string shown on a bare `/research` invocation. */
const USAGE =
  'Usage:\n' +
  '  /research <question>                 — run the planner → synth pipeline; writes report.md\n' +
  '  /research --list                     — list runs under ./research/\n' +
  '  /research --selftest                 — run the research-core self-test fixture\n' +
  '  /research --resume [flags]           — resume an existing run; auto-detects stage from\n' +
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

/**
 * Statusline widget key, shared between the command handler and
 * the `research` tool so they both write into the same slot.
 */
const STATUSLINE_KEY = 'deep-research';

/**
 * TypeBox schema for the LLM-callable `research` tool.
 *
 *   - `question`         required — the research question itself.
 *   - `model`            optional — parent-model override in
 *                        `provider/id` form. inherit-mode subagents
 *                        (web-researcher, plan-crit, critic)
 *                        inherit it.
 *   - `fanoutMaxTurns`   optional — maxTurns cap for every
 *                        web-researcher fanout spawn.
 *   - `criticMaxTurns`   optional — maxTurns cap for the
 *                        research-planning-critic and the
 *                        subjective critic spawns.
 *   - `fanoutParallel`   optional — cap on simultaneous fanout
 *                        workers (overrides plan.budget.maxSubagents).
 *                        Set to 1 for serial fanout against a single
 *                        local model.
 *   - `wallClockSec`     optional — wall-clock override in seconds
 *                        (overrides plan.budget.wallClockSec).
 */
const ResearchToolParams = Type.Object({
  question: Type.String({
    description:
      'Research question. Runs the full deep-research pipeline (plan → fanout → synth → two-stage review) and returns a summary + report path.',
  }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional parent-model override in "provider/id" form (e.g. "openai/gpt-5"). Replaces the parent research session’s model; inherit-mode subagents inherit it unless they also have their own per-agent override below. Agents that pin a specific model in their .md stay pinned.',
    }),
  ),
  planCritModel: Type.Optional(
    Type.String({
      description:
        'Optional model override ("provider/id") for the research-planning-critic subagent only. Takes precedence over `model`.',
    }),
  ),
  fanoutModel: Type.Optional(
    Type.String({
      description:
        'Optional model override ("provider/id") for every web-researcher fanout spawn only. Takes precedence over `model`. Useful for running fanout on a cheap model while keeping a stronger parent model.',
    }),
  ),
  criticModel: Type.Optional(
    Type.String({
      description:
        'Optional model override ("provider/id") for the subjective critic subagent only. Takes precedence over `model`.',
    }),
  ),
  fanoutMaxTurns: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description:
        'Optional maxTurns cap for every web-researcher fanout spawn. Default is whatever the agent’s .md declares (20 as of today).',
    }),
  ),
  criticMaxTurns: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description: 'Optional maxTurns cap for the research-planning-critic + subjective critic spawns.',
    }),
  ),
  reviewMaxIter: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description:
        "Optional cap on cross-stage review iterations (default 4). Raise when the review loop previously hit `budget-exhausted` on fixable issues (e.g. missing citations). On budget exhaustion the returned tool summary carries a closeness verdict (`Near-pass:` / `Stuck:`) and a ready-to-invoke `/research --resume --from=review --review-max-iter <N+2>` command — read the summary before deciding to call the tool again so a `Stuck:` outcome doesn't silently retry against an unsolvable report.",
    }),
  ),
  fanoutParallel: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 64,
      description:
        'Optional cap on simultaneous web-researcher fanout workers. Overrides the planner’s `maxSubagents` for this run only. Set to `1` when pointing fanout at a single local model (llama.cpp / Ollama) that can’t handle concurrent requests.',
    }),
  ),
  wallClockSec: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 86_400,
      description:
        'Optional wall-clock override for the fanout, in seconds. Replaces the planner’s `wallClockSec` for this run only. Use when a local-model run legitimately needs 2h+ and the planner’s default is too tight. Clamp is 86_400 (24h).',
    }),
  ),
});

export default function deepResearchExtension(pi: ExtensionAPI): void {
  if (process.env.PI_DEEP_RESEARCH_DISABLED === '1') return;

  // Load agent definitions once per session_start — we need
  // `web-researcher` and `research-planning-critic` agents to
  // dispatch their respective roles.
  const extDir = dirname(fileURLToPath(import.meta.url));
  const userPiDir = `${homedir()}/.pi`;
  let agentLoad: AgentLoadResult = { agents: new Map(), nameOrder: [], warnings: [] };

  const readLayer: ReadLayer = {
    listMarkdownFiles: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return null;
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };

  const reloadAgents = (cwd: string): void => {
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const layers = defaultAgentLayers({ extensionDir: extDir, userPiDir, cwd });
    agentLoad = loadAgents({
      layers,
      knownToolNames,
      fs: readLayer,
      parseFrontmatter,
    });
  };

  pi.on('session_start', (_event, ctx) => {
    try {
      reloadAgents(ctx.cwd);
    } catch {
      /* swallow — command handler surfaces a friendlier error */
    }
    // Clear any stale widget from a prior session.
    try {
      ctx.ui.setWidget(STATUSLINE_KEY, undefined);
    } catch {
      /* swallow */
    }
  });

  // Module-scope session flag: enforces one active research run
  // at a time. Shared by the slash command and the `research`
  // tool so neither can overlap the other.
  const researchFlag: ResearchSessionFlag = createResearchSessionFlag();

  pi.registerCommand('research', {
    description: 'Long-horizon web research: plan → fanout → synth → review. Writes ./research/<slug>/report.md.',
    handler: async (rawArgs, ctx) => {
      const notify: CommandNotify = (message: string, level: CommandNotifyLevel) => {
        ctx.ui.notify(message, level);
      };

      const parsed = parseResearchCommandArgs(rawArgs);

      if (parsed.kind === 'help') {
        notify(USAGE, 'info');
        return;
      }
      if (parsed.kind === 'list') {
        if (parsed.trailing)
          notify(`/research --list: ignoring trailing args: ${JSON.stringify(parsed.trailing)}`, 'warning');
        runListCommand({ cwd: ctx.cwd, notify });
        return;
      }
      if (parsed.kind === 'selftest') {
        if (parsed.trailing)
          notify(`/research --selftest: ignoring trailing args: ${JSON.stringify(parsed.trailing)}`, 'warning');
        await runSelftestCommand({ cwd: ctx.cwd, selftest: selftestDeepResearch, notify });
        return;
      }
      if (parsed.kind === 'resume') {
        try {
          reloadAgents(ctx.cwd);
        } catch (e) {
          notify(`/research: failed to load agent definitions: ${(e as Error).message}`, 'error');
          return;
        }
        if (researchFlag.active) {
          notify(
            '/research: another research run is already active in this session. Wait for it to finish before starting a new one.',
            'warning',
          );
          return;
        }
        researchFlag.active = true;
        try {
          await runResumeFlow({
            ctx,
            agentLoad,
            notify,
            resume: parsed.resume,
            overrides: parsed.overrides,
          });
        } finally {
          researchFlag.active = false;
        }
        return;
      }
      if (parsed.kind === 'error') {
        notify(`/research: ${parsed.error}`, 'error');
        return;
      }

      // parsed.kind === 'question' — run the pipeline.
      try {
        reloadAgents(ctx.cwd);
      } catch (e) {
        notify(`/research: failed to load agent definitions: ${(e as Error).message}`, 'error');
        return;
      }

      if (researchFlag.active) {
        notify(
          '/research: another research run is already active in this session. Wait for it to finish before starting a new one.',
          'warning',
        );
        return;
      }

      // Phase-5 collision prompt: if the slugified question
      // already maps to a run on disk, either resume (interactive
      // mode) or error out (print / RPC mode). This prevents the
      // "spawn a sibling run with the same question" anti-pattern
      // that wastes replanning + review budget. `continueFreshRun`
      // is set when the user explicitly picks the fresh-run path;
      // a cancel / undismissed dialog returns without running
      // anything.
      const continueFreshRun = await handleSlugCollision({
        ctx,
        notify,
        question: parsed.question,
        agentLoad,
        overrides: parsed.overrides,
        researchFlag,
      });
      if (!continueFreshRun) return;

      notify(
        `/research: starting pipeline — planner → self-critic → planning-critic → fanout → synth → report${formatOverridesSummary(parsed.overrides)}`,
        'info',
      );
      researchFlag.active = true;
      try {
        await runResearchFlow({
          ctx,
          agentLoad,
          question: parsed.question,
          notify,
          surfacePipelineOutcome: true,
          overrides: parsed.overrides,
        });
      } finally {
        researchFlag.active = false;
      }
    },
  });

  // ──────────────────────────────────────────────────────────────────
  // `research` tool — LLM-callable version of the same pipeline.
  // ──────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'research',
    label: 'Research',
    description:
      'Run the deep-research pipeline on a question: plans sub-questions, spawns parallel web-researcher subagents via MCP fetch_web, synthesizes a fully-cited markdown report at `./research/<slug>/report.md`, and runs a two-stage structural+subjective review. Blocks until the report is ready; a second concurrent `research` call is rejected. Returns a one-screen summary including the report path.',
    promptSnippet:
      'For long-horizon research questions that warrant a fully-cited report, call `research` instead of an ad-hoc web fetch.',
    promptGuidelines: [
      'Use `research` only when the user asked for a written research report, not for a single-fact lookup — it takes minutes and spends real model budget.',
      'Only one `research` tool call may be in flight per session; do not issue a second call before the first has returned.',
      'Only set `model`, `fanoutMaxTurns`, or `criticMaxTurns` when the user explicitly asks for one; the defaults (parent session’s model, agent-declared maxTurns) are correct for typical runs. Bump `fanoutMaxTurns` when sub-questions keep hitting max_turns on the web-researcher.',
      'Set `fanoutParallel` to 1 when fanout points at a single local model (llama.cpp / Ollama) that cannot handle concurrent requests; otherwise leave it unset so the planner’s `maxSubagents` applies.',
      'Set `wallClockSec` only when the user asks for a longer budget than the planner defaults to — local-model runs regularly need 2h+ (`wallClockSec: 7200`), while hosted-model runs should stick with the planner default.',
      'Bump `reviewMaxIter` (default 4) when the structural/subjective review loop has previously hit `budget-exhausted` on fixable issues — e.g. missing `[^n]` citations — and you want more refinement passes.',
    ],
    parameters: ResearchToolParams,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as unknown as {
        question?: unknown;
        model?: unknown;
        planCritModel?: unknown;
        fanoutModel?: unknown;
        criticModel?: unknown;
        fanoutMaxTurns?: unknown;
        criticMaxTurns?: unknown;
        reviewMaxIter?: unknown;
        fanoutParallel?: unknown;
        wallClockSec?: unknown;
      };
      const question = typeof params.question === 'string' ? params.question.trim() : '';
      if (!question) {
        throw new Error('research: `question` is empty');
      }

      // Validate the optional overrides the LLM may have passed
      // (`model` / per-agent model overrides / maxTurns). Invalid
      // input throws before we burn any model budget.
      const validated = validateToolOverrides({
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.planCritModel !== undefined ? { planCritModel: params.planCritModel } : {}),
        ...(params.fanoutModel !== undefined ? { fanoutModel: params.fanoutModel } : {}),
        ...(params.criticModel !== undefined ? { criticModel: params.criticModel } : {}),
        ...(params.fanoutMaxTurns !== undefined ? { fanoutMaxTurns: params.fanoutMaxTurns } : {}),
        ...(params.criticMaxTurns !== undefined ? { criticMaxTurns: params.criticMaxTurns } : {}),
        ...(params.reviewMaxIter !== undefined ? { reviewMaxIter: params.reviewMaxIter } : {}),
        ...(params.fanoutParallel !== undefined ? { fanoutParallel: params.fanoutParallel } : {}),
        ...(params.wallClockSec !== undefined ? { wallClockSec: params.wallClockSec } : {}),
      });
      if (!validated.ok) {
        throw new Error(`research: ${validated.error}`);
      }
      const overrides = validated.overrides;

      // Reload agent definitions so a brand-new session picks up
      // the `web-researcher` / `research-planning-critic` agents
      // even if session_start raced the tool invocation.
      try {
        reloadAgents(ctx.cwd);
      } catch (e) {
        throw new Error(`research: failed to load agent definitions: ${(e as Error).message}`);
      }

      const notifyUi: NotifyFn = (message, level) => {
        try {
          ctx.ui.notify(message, level);
        } catch {
          /* swallow — notify is best-effort */
        }
      };

      const executor = createResearchToolExecutor({
        flag: researchFlag,
        notify: notifyUi,
        runPipeline: async (q, sig) => {
          const merged = mergeSignals(signal, sig);
          return runResearchFlow({
            ctx,
            agentLoad,
            question: q,
            notify: notifyUi,
            ...(merged ? { signal: merged } : {}),
            surfacePipelineOutcome: false,
            overrides,
          });
        },
      });

      const result = await executor(question, signal);
      return {
        content: [{ type: 'text', text: result.summary }],
        details: {
          outcome: result.outcome,
        },
      };
    },
    renderCall(args, theme, _context) {
      const typed = args as {
        question?: unknown;
        model?: unknown;
        planCritModel?: unknown;
        fanoutModel?: unknown;
        criticModel?: unknown;
        fanoutMaxTurns?: unknown;
        criticMaxTurns?: unknown;
        reviewMaxIter?: unknown;
        fanoutParallel?: unknown;
        wallClockSec?: unknown;
      };
      const q = typeof typed.question === 'string' ? typed.question : '';
      const overrideBits: string[] = [];
      if (typeof typed.model === 'string' && typed.model.length > 0) overrideBits.push(`model=${typed.model}`);
      if (typeof typed.planCritModel === 'string' && typed.planCritModel.length > 0)
        overrideBits.push(`plan-crit-model=${typed.planCritModel}`);
      if (typeof typed.fanoutModel === 'string' && typed.fanoutModel.length > 0)
        overrideBits.push(`fanout-model=${typed.fanoutModel}`);
      if (typeof typed.criticModel === 'string' && typed.criticModel.length > 0)
        overrideBits.push(`critic-model=${typed.criticModel}`);
      if (typeof typed.fanoutMaxTurns === 'number') overrideBits.push(`fanout-max-turns=${typed.fanoutMaxTurns}`);
      if (typeof typed.criticMaxTurns === 'number') overrideBits.push(`critic-max-turns=${typed.criticMaxTurns}`);
      if (typeof typed.reviewMaxIter === 'number') overrideBits.push(`review-max-iter=${typed.reviewMaxIter}`);
      if (typeof typed.fanoutParallel === 'number') overrideBits.push(`fanout-parallel=${typed.fanoutParallel}`);
      if (typeof typed.wallClockSec === 'number') overrideBits.push(`wall-clock=${typed.wallClockSec}s`);
      const overrides = overrideBits.length > 0 ? ` [${overrideBits.join(' ')}]` : '';
      const label =
        theme.fg('toolTitle', theme.bold('research')) + ' ' + theme.fg('muted', truncateTool(q, 80) + overrides);
      return new Text(label, 0, 0);
    },
    renderResult(result, _opts, theme, _context) {
      const details = (result.details ?? {}) as { outcome?: ResearchToolRunOutcome };
      const outcome = details.outcome;
      if (!outcome) {
        return new Text(theme.fg('dim', 'research: no outcome recorded'), 0, 0);
      }
      if (outcome.kind === 'report-complete') {
        return new Text(theme.fg('success', `✓ report → ${outcome.reportPath}`), 0, 0);
      }
      if (outcome.kind === 'fanout-complete') {
        return new Text(theme.fg('warning', `· fanout complete (no report yet): ${outcome.runRoot}`), 0, 0);
      }
      if (outcome.kind === 'error') {
        return new Text(theme.fg('error', `✗ ${outcome.error}`), 0, 0);
      }
      return new Text(theme.fg('warning', `· ${outcome.kind}: ${'reason' in outcome ? outcome.reason : ''}`), 0, 0);
    },
  });
}

function truncateTool(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Merge two optional AbortSignals into one. Returns `undefined`
 * if neither is supplied. Callers thread the resulting signal
 * into spawners / runners so a hard cancel from either path tears
 * down the research flow promptly.
 */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ac = new AbortController();
  const onAbort = (reason: unknown): void => {
    if (!ac.signal.aborted) ac.abort(reason);
  };
  if (a.aborted) onAbort(a.reason);
  else a.addEventListener('abort', () => onAbort(a.reason), { once: true });
  if (b.aborted) onAbort(b.reason);
  else b.addEventListener('abort', () => onAbort(b.reason), { once: true });
  return ac.signal;
}

// ──────────────────────────────────────────────────────────────────────
// Wiring.
// ──────────────────────────────────────────────────────────────────────

interface BuildDepsOk<M> {
  ok: true;
  deps: PipelineDeps<M>;
  /**
   * The resolved parent model the pipeline is using. Same as
   * `ctx.model` unless `extras.overrides.model` requested an
   * override, in which case this is the Model<any> looked up from
   * the registry. Threaded to the review phase so inherit-mode
   * critic subagents see the same model the rest of the pipeline
   * does.
   */
  parentModel: unknown;
}
interface BuildDepsErr {
  ok: false;
  error: string;
}

/**
 * Statusline controller — wraps the pure reducer from
 * `deep-research-statusline.ts` with the mutable state +
 * `ctx.ui.setWidget` side-effects the extension needs to keep the
 * widget in sync with pipeline phase transitions.
 *
 * Exposed as a small object so the command handler and the
 * `research` tool can both drive one instance per run.
 */
interface StatuslineController {
  emit: (event: PhaseEvent) => void;
  current: () => StatuslineState;
  clear: () => void;
}

function buildStatuslineController(ctx: {
  ui: { setWidget: (key: string, body: string[] | undefined) => void };
}): StatuslineController {
  let state = initialStatuslineState(Date.now());
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Auto-dismiss: after a terminal `done` / `error` event we leave
  // the widget on screen for a few seconds so the user sees the
  // final label + cost, then clear it. A fresh `start` (second
  // research run in the same session) cancels any pending
  // dismissal so the new run's widget isn't nuked early.
  let autoClearTimer: ReturnType<typeof setTimeout> | null = null;
  const AUTO_CLEAR_MS = 8_000;

  const render = (): void => {
    try {
      ctx.ui.setWidget(STATUSLINE_KEY, renderStatuslineWidget(state, Date.now(), { frame }));
    } catch {
      /* swallow — widget failures must never break the pipeline */
    }
  };

  const startTimer = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      // Frames wrap naturally via the spinner modulo; we just
      // need a monotonically-bumping counter. Cap it so long
      // runs don't overflow after ~years, which is absurd but
      // keeps the value bounded without a branch.
      frame = (frame + 1) & 0x3fffffff;
      render();
    }, 80);
    // Never block process exit on the spinner timer.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };

  const stopTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const cancelAutoClear = (): void => {
    if (autoClearTimer) {
      clearTimeout(autoClearTimer);
      autoClearTimer = null;
    }
  };

  const scheduleAutoClear = (): void => {
    cancelAutoClear();
    autoClearTimer = setTimeout(() => {
      autoClearTimer = null;
      try {
        ctx.ui.setWidget(STATUSLINE_KEY, undefined);
      } catch {
        /* swallow */
      }
    }, AUTO_CLEAR_MS);
    if (typeof (autoClearTimer as { unref?: () => void }).unref === 'function') {
      (autoClearTimer as { unref: () => void }).unref();
    }
  };

  const emit = (event: PhaseEvent): void => {
    if (event.kind === 'start') {
      // Re-anchor the elapsed clock on explicit start so a second
      // research run in the same session doesn't show the prior
      // run's wall-clock.
      state = initialStatuslineState(Date.now());
      // A new run cancels any pending dismissal from the previous
      // terminal state — the spinner will be driving the widget
      // again in a moment.
      cancelAutoClear();
    } else {
      state = reduceStatusline(state, event);
    }
    // Terminal states freeze the spinner and schedule a dismissal;
    // active work animates and cancels any pending dismissal.
    if (state.phase === 'idle' || state.phase === 'done' || state.phase === 'error') {
      stopTimer();
      if (state.phase === 'done' || state.phase === 'error') {
        scheduleAutoClear();
      }
    } else {
      cancelAutoClear();
      startTimer();
    }
    render();
  };
  const clear = (): void => {
    stopTimer();
    cancelAutoClear();
    try {
      ctx.ui.setWidget(STATUSLINE_KEY, undefined);
    } catch {
      /* swallow */
    }
  };
  return {
    emit,
    current: () => state,
    clear,
  };
}

/**
 * End-to-end pipeline + review driver. Shared by the `/research
 * <question>` command and the `research` tool. Owns:
 *
 *   - the statusline controller (setWidget on every transition),
 *   - the fanout-spawner wrapper that counts per-task completions
 *     and folds them into the state machine as `fanout-progress`
 *     events,
 *   - the review phase (Phase-4 two-stage structural+subjective),
 *   - translating the pipeline outcome + optional review verdict
 *     into a {@link ResearchToolRunOutcome} the tool factory can
 *     format for the LLM.
 *
 * `surfacePipelineOutcome` controls whether this helper also emits
 * the legacy human-readable block (fanout counts, next-step hint)
 * via `notify`. The slash command keeps that block for the user;
 * the tool path suppresses it to keep the tool result tight (the
 * `research-tool` summary already says everything).
 */
async function runResearchFlow(args: {
  ctx: ExtensionCommandContext;
  agentLoad: AgentLoadResult;
  question: string;
  notify: CommandNotify;
  surfacePipelineOutcome: boolean;
  signal?: AbortSignal;
  /**
   * Test-inject a pre-built statusline controller. Production
   * always gets a fresh one bound to `ctx.ui.setWidget`.
   */
  statusline?: StatuslineController;
  /**
   * Per-run overrides produced by the slash-command parser or the
   * `research` tool's schema validator. Pre-validated: `model` is
   * already a well-formed `provider/id` string, `*MaxTurns` are
   * already positive integers. See
   * `lib/node/pi/research-command-args.ts`.
   */
  overrides?: ResearchOverrides;
}): Promise<ResearchToolRunOutcome> {
  const { ctx, agentLoad, question, notify, surfacePipelineOutcome } = args;
  const overrides = args.overrides ?? {};
  const statusline = args.statusline ?? buildStatuslineController(ctx);
  statusline.emit({ kind: 'start' });

  // Live-updating RunBudget: accumulates per-phase cost +
  // wall-clock by watching the same PhaseEvent stream the
  // statusline consumes, and exposes PhaseTrackers the cost
  // hooks route assistant-turn USD deltas into. A single
  // `cost report` entry lands in the run's journal.md on exit.
  const liveBudget = createLiveBudget({
    budget: createRunBudget(DEFAULT_BUDGET_PHASES.map((p) => ({ ...p }))),
  });
  const onPhase = (event: PhaseEvent): void => {
    statusline.emit(event);
    try {
      liveBudget.observePhaseEvent(event);
    } catch {
      /* swallow — budget observation must never break the run */
    }
  };

  const built = buildPipelineDeps(ctx, agentLoad, {
    onPhase,
    liveBudget,
    overrides,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!built.ok) {
    onPhase({ kind: 'error', message: built.error });
    return { kind: 'error', error: built.error };
  }

  let outcome: PipelineOutcome;
  try {
    outcome = await runResearchPipeline(question, built.deps);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    onPhase({ kind: 'error', message });
    liveBudget.appendSummary();
    return { kind: 'error', error: `pipeline threw: ${message}` };
  }

  // From here on the pipeline has returned a runRoot (every
  // outcome kind carries one) so the live budget can emit its
  // overrun warnings into the run's journal as phases close. The
  // final `cost report` summary lands on the terminal done/error
  // path below so review-phase cost is included.
  if (outcome.runRoot) {
    try {
      liveBudget.setJournalPath(paths(outcome.runRoot).journal);
    } catch {
      /* swallow — journal wiring must never break the run */
    }
  }

  if (surfacePipelineOutcome) {
    surfaceOutcome(outcome, notify);
  }

  // Non-report terminal states: emit done / error and bail.
  if (outcome.kind === 'planner-stuck') {
    onPhase({ kind: 'error', message: `planner stuck: ${outcome.reason}` });
    liveBudget.appendSummary();
    return { kind: 'planner-stuck', runRoot: outcome.runRoot, reason: outcome.reason };
  }
  if (outcome.kind === 'checkpoint') {
    onPhase({ kind: 'error', message: `plan-crit checkpoint (${outcome.outcome.kind})` });
    liveBudget.appendSummary();
    return { kind: 'checkpoint', runRoot: outcome.runRoot, reason: outcome.outcome.kind };
  }
  if (outcome.kind === 'error') {
    onPhase({ kind: 'error', message: outcome.error });
    liveBudget.appendSummary();
    return { kind: 'error', runRoot: outcome.runRoot, error: outcome.error };
  }
  if (outcome.kind === 'fanout-complete') {
    onPhase({ kind: 'done', message: 'fanout complete (no synth)' });
    liveBudget.appendSummary();
    return {
      kind: 'fanout-complete',
      runRoot: outcome.runRoot,
      completed: outcome.fanout.completed.length,
      failed: outcome.fanout.failed.length,
      aborted: outcome.fanout.aborted.length,
    };
  }

  // report-complete — run the review phase.
  let review: ReviewWireResult | null = null;
  try {
    review = await runReviewPhase({
      ctx,
      runRoot: outcome.runRoot,
      notify,
      agentLoad,
      pipelineDeps: built.deps,
      parentModel: built.parentModel,
      emitPhase: onPhase,
      liveBudget,
      ...(overrides.criticModel ? { criticModel: overrides.criticModel } : {}),
      ...(overrides.criticMaxTurns !== undefined ? { criticMaxTurns: overrides.criticMaxTurns } : {}),
      ...(overrides.reviewMaxIter !== undefined ? { reviewMaxIter: overrides.reviewMaxIter } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    onPhase({ kind: 'error', message });
    liveBudget.appendSummary();
    return {
      kind: 'report-complete',
      reportPath: outcome.merge.reportPath,
      runRoot: outcome.runRoot,
      subjectiveApproved: false,
      summary: `review phase threw: ${message}`,
    };
  }

  const reviewApproved = review?.outcome.kind === 'passed';
  const doneMessage = reviewApproved
    ? 'review passed'
    : review?.level === 'error'
      ? 'review failed'
      : 'review complete';
  onPhase({ kind: 'done', message: doneMessage });
  liveBudget.appendSummary();

  // Phase-4 guardrail: if the final report still has
  // `[section unavailable: …]` stubs the review loop exempts from
  // the citation rule, the user needs to re-fetch those sub-
  // questions — refinement cannot fix them. Surface a targeted
  // resume hint and fold it into the tool summary so the LLM sees
  // it too.
  //
  // The review-wire now short-circuits on stubbed reports and
  // emits an equivalent "review skipped" notify before returning
  // `kind: 'stubbed'`. Skip the post-loop hint on that path to
  // avoid a double-emit — `review.summary` already carries the
  // recovery command for the tool-summary fold below.
  const stubHint = review?.outcome.kind === 'stubbed' ? null : formatStubHint(outcome.runRoot);
  if (stubHint) notify(stubHint, 'warning');

  return {
    kind: 'report-complete',
    reportPath: outcome.merge.reportPath,
    runRoot: outcome.runRoot,
    subjectiveApproved: reviewApproved,
    ...(review ? { summary: stubHint ? `${review.summary}\n\n${stubHint}` : review.summary } : {}),
  };
}

/**
 * Phase-5 collision handler. Called at `/research <question>`
 * entry time after `parsed.kind === 'question'` and before the
 * pipeline spins up. Returns `true` when the caller should
 * proceed with a fresh run, `false` when the caller should
 * return without running anything (because we either resumed,
 * errored, or the user cancelled).
 *
 * Interactive mode (`ctx.hasUI === true`):
 *   1. `findExistingRun` matches the slugified question against
 *      a `plan.json` on disk.
 *   2. `ctx.ui.select` prompts: resume / fresh / cancel. The
 *      resume option's label carries the run's live
 *      resumability verdict + cumulative cost so the user can
 *      decide at a glance.
 *   3. "Resume existing run" → delegate to {@link runResumeFlow}
 *      with the existing `runRoot` and no `--from` (so auto-
 *      detection picks the earliest incomplete stage).
 *   4. "Start a fresh run anyway" → return `true`; pipeline
 *      proceeds. The planner picks its own slug after running,
 *      so a collision here does not necessarily re-collide.
 *   5. "Cancel" / dismissed dialog → return `false` with an
 *      info notify so the user isn't left wondering.
 *
 * Non-interactive mode (`ctx.hasUI === false`, i.e. print/RPC
 * or the LLM-invoked `research` tool): emit an error notify
 * naming the existing run's resumability verdict and pointing
 * the user at `/research --resume --run-root <path>`. No
 * prompt path because there's no one to prompt.
 *
 * No existing run → return `true` unchanged. The slug-collision
 * detection itself is cheap (one `statSync` + one plan.json
 * parse) so it's safe to run for every `/research <question>`.
 */
async function handleSlugCollision(args: {
  ctx: ExtensionCommandContext;
  notify: CommandNotify;
  question: string;
  agentLoad: AgentLoadResult;
  overrides: ResearchOverrides;
  researchFlag: ResearchSessionFlag;
}): Promise<boolean> {
  const { ctx, notify, question, agentLoad, overrides, researchFlag } = args;
  const existing = findExistingRun(ctx.cwd, question);
  if (!existing) return true;

  const runRootPath = join(ctx.cwd, 'research', existing.slug);
  const resumeLabel = existing.resumability ?? 'unknown';
  const costLabel = existing.costUsd === null ? 'no cost recorded' : `cost so far $${existing.costUsd.toFixed(3)}`;

  if (!ctx.hasUI) {
    notify(
      [
        `/research: a prior run for this question exists at ${runRootPath} (resumability=${resumeLabel}, ${costLabel}).`,
        `  Resume it with \`/research --resume --run-root ${runRootPath}\` or pick a different question to start fresh.`,
      ].join('\n'),
      'error',
    );
    return false;
  }

  const resumeOption = `Resume existing run (${resumeLabel}, ${costLabel})`;
  const freshOption = 'Start a fresh run anyway';
  const cancelOption = 'Cancel';
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(
      `/research: existing run at ${existing.slug}`,
      [resumeOption, freshOption, cancelOption],
      ctx.signal ? { signal: ctx.signal } : {},
    );
  } catch (e) {
    notify(`/research: collision prompt failed (${(e as Error).message}); cancelling.`, 'error');
    return false;
  }

  if (choice === undefined || choice === cancelOption) {
    notify('/research: cancelled (existing run left untouched).', 'info');
    return false;
  }

  if (choice === resumeOption) {
    if (researchFlag.active) {
      notify(
        '/research: another research run is already active in this session. Wait for it to finish before resuming.',
        'warning',
      );
      return false;
    }
    researchFlag.active = true;
    try {
      await runResumeFlow({
        ctx,
        agentLoad,
        notify,
        resume: { runRoot: runRootPath },
        overrides,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } finally {
      researchFlag.active = false;
    }
    return false;
  }

  // choice === freshOption — fall through to the pipeline.
  notify(`/research: starting a fresh run; existing ${existing.slug} left untouched.`, 'info');
  return true;
}

/**
 * Resume-mode entry point for `/research --resume`. Validates the
 * requested runRoot (default: most-recent run under `./research/`),
 * detects or honors the pinned stage, and dispatches accordingly.
 *
 * Phase-1 scope (shipping):
 *   - `--from=review` (default when `report.md` exists on disk):
 *     re-enters the review loop with `startIteration = priorSnapshots + 1`
 *     and `maxIter = overrides.reviewMaxIter ?? 4`. Fully wired.
 *
 * Phase-2 scope (shipping):
 *   - `--from=plan-crit`, `--from=fanout`, `--from=synth`: dispatch
 *     to {@link runResumePipelineStage}, which threads `resumeFrom`
 *     + `resumeRunRoot` into `runResearchPipeline` so earlier
 *     stages read their outputs from disk instead of re-running.
 */
async function runResumeFlow(args: {
  ctx: ExtensionCommandContext;
  agentLoad: AgentLoadResult;
  notify: CommandNotify;
  resume: ResumeOverrides;
  overrides: ResearchOverrides;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, notify, resume, overrides } = args;

  // ── 1. Resolve runRoot ──────────────────────────────────────
  let runRoot: string;
  let slug: string;
  if (resume.runRoot) {
    const validated = validateRunRoot(ctx.cwd, resume.runRoot);
    if (!validated.ok) {
      notify(`/research --resume: ${validated.error}`, 'error');
      return;
    }
    runRoot = validated.runRoot;
    slug = validated.slug;
  } else {
    const recent = listRecentRuns(ctx.cwd);
    if (recent.length === 0) {
      notify(
        '/research --resume: no prior runs found under ./research/ — start a fresh run with `/research <question>`',
        'error',
      );
      return;
    }
    runRoot = recent[0].runRoot;
    slug = recent[0].slug;
    notify(`/research --resume: using most-recent run — ${slug}`, 'info');
  }

  // ── 2. Decide stage ─────────────────────────────────────────
  //
  // `--sq` targets the fanout stage specifically: the caller has
  // picked sub-question ids to reset, so auto-detection is
  // meaningless and `--from=<not-fanout>` is a contradiction. We
  // surface both cases up-front with clear errors instead of a
  // silent promotion.
  const filterIds = resume.subQuestionIds ?? [];
  if (filterIds.length > 0 && resume.from !== undefined && resume.from !== 'fanout') {
    notify(
      `/research --resume: --sq is only meaningful with --from=fanout (got --from=${resume.from}). ` +
        `Drop the --from or set --from=fanout.`,
      'error',
    );
    return;
  }

  let stage: ResumeStage;
  let stageReason: string;
  let needsRefanout: string[] = [];
  if (resume.from || filterIds.length > 0) {
    // `--sq` without `--from` defaults to fanout — the only stage
    // where a sub-question filter is meaningful.
    stage = resume.from ?? 'fanout';
    stageReason = resume.from ? `--from=${resume.from} (user override)` : `--sq supplied — defaulting stage to fanout`;
    if (stage === 'fanout') {
      let planSubQuestionIds: string[] = [];
      try {
        const plan = readPlan(paths(runRoot).plan);
        if (plan.kind === 'deep-research') {
          planSubQuestionIds = plan.subQuestions.map((sq) => sq.id);
        }
      } catch {
        /* ignore — error already surfaced by validateRunRoot */
      }
      if (filterIds.length > 0) {
        const scoped = scopeFanoutDeficit(runRoot, planSubQuestionIds, filterIds);
        if (scoped.unknown.length > 0) {
          notify(
            `/research --resume: --sq ids not present in plan.json: ${scoped.unknown.join(', ')}. ` +
              `Valid ids: ${planSubQuestionIds.length > 0 ? planSubQuestionIds.join(', ') : '<none>'}.`,
            'error',
          );
          return;
        }
        if (scoped.ids.length === 0) {
          notify(
            `/research --resume: nothing to re-fanout — ${filterIds.join(', ')} already complete on disk.`,
            'info',
          );
          return;
        }
        needsRefanout = scoped.ids;
      } else {
        needsRefanout = sumFanoutDeficit(runRoot, planSubQuestionIds);
      }
    }
  } else {
    const detected = detectResumeStage(runRoot);
    if (!detected.ok) {
      notify(`/research --resume: ${detected.error}`, 'error');
      return;
    }
    stage = detected.stage;
    stageReason = detected.reason;
    needsRefanout = detected.needsRefanout;
  }

  notify(`/research --resume: stage=${stage} — ${stageReason}${formatOverridesSummary(overrides, resume)}`, 'info');

  // Advisory: surface any drift between the pending overrides and
  // the original run's `plan.json.provenance.json`. v1 compares
  // only the parent `--model`; other overrides aren't persisted.
  // Never blocks the resume.
  const drift = detectProvenanceDrift(runRoot, overrides);
  const driftHint = formatProvenanceDrift(drift);
  if (driftHint) notify(driftHint, 'warning');

  // Journal the cumulative cost accrued across prior runs on this
  // slug before handing off to the pipeline. Downstream cost-hook
  // entries keep appending, so `sumJournalCostUsd` on completion
  // will keep climbing — exactly the behavior `/research --list`
  // already relies on. The journal line is advisory; swallow any
  // write failure so a broken journal can't break the resume.
  try {
    const priorCostUsd = sumJournalCostUsd(paths(runRoot).journal);
    appendJournal(paths(runRoot).journal, {
      level: 'step',
      heading: `resume stage=${stage} · prior cumulative cost · ${priorCostUsd.toFixed(6)} USD`,
    });
  } catch {
    /* swallow — journal is advisory */
  }

  // ── 3. Dispatch by stage ────────────────────────────────────
  if (stage === 'review') {
    await runResumeReviewStage({
      ctx,
      runRoot,
      agentLoad: args.agentLoad,
      notify,
      overrides,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    return;
  }

  // Phase-2: dispatch plan-crit / fanout / synth through the
  // real pipeline with `resumeFrom` + `resumeRunRoot` pinned.
  await runResumePipelineStage({
    ctx,
    agentLoad: args.agentLoad,
    notify,
    runRoot,
    stage,
    needsRefanout,
    overrides,
    ...(filterIds.length > 0 ? { synthSubQuestionIds: filterIds } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

/**
 * Phase-1 handler: re-enter the review loop against an existing
 * run. No planner / fanout / synth work — reads `report.md` and
 * rubrics from disk, counts prior review iterations, and drives
 * `runReviewPhase` with `startIteration = N+1`.
 */
async function runResumeReviewStage(args: {
  ctx: ExtensionCommandContext;
  runRoot: string;
  agentLoad: AgentLoadResult;
  notify: CommandNotify;
  overrides: ResearchOverrides;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, runRoot, agentLoad, notify, overrides } = args;
  const p = paths(runRoot);
  if (!existsSync(p.report)) {
    notify(
      `/research --resume --from=review: no report.md under ${runRoot} — cannot resume review. ` +
        `Use \`/research <original-question>\` to drive the pipeline from the start.`,
      'error',
    );
    return;
  }
  if (!existsSync(p.rubricSubjective) || !existsSync(p.rubricStructural)) {
    notify(
      `/research --resume --from=review: rubric files missing under ${runRoot}. ` +
        `Expected ${p.rubricStructural} and ${p.rubricSubjective}.`,
      'error',
    );
    return;
  }

  const priorIter = countPriorReviewIterations(runRoot);
  const startIteration = priorIter + 1;
  const reviewMaxIter = overrides.reviewMaxIter ?? 4;
  notify(
    `/research --resume --from=review: ${priorIter} prior review iteration(s) on disk; running iters ${startIteration}–${startIteration + reviewMaxIter - 1}`,
    'info',
  );

  const statusline = buildStatuslineController(ctx);
  statusline.emit({ kind: 'start' });
  const liveBudget = createLiveBudget({
    budget: createRunBudget(DEFAULT_BUDGET_PHASES.map((p2) => ({ ...p2 }))),
  });
  const onPhase = (event: PhaseEvent): void => {
    statusline.emit(event);
    try {
      liveBudget.observePhaseEvent(event);
    } catch {
      /* swallow */
    }
  };
  try {
    liveBudget.setJournalPath(p.journal);
  } catch {
    /* swallow */
  }

  const built = buildPipelineDeps(ctx, agentLoad, {
    onPhase,
    liveBudget,
    overrides,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!built.ok) {
    onPhase({ kind: 'error', message: built.error });
    liveBudget.appendSummary();
    notify(`/research --resume --from=review: ${built.error}`, 'error');
    return;
  }

  let review: ReviewWireResult | null = null;
  try {
    review = await runReviewPhase({
      ctx,
      runRoot,
      notify,
      agentLoad,
      pipelineDeps: built.deps,
      parentModel: built.parentModel,
      emitPhase: onPhase,
      liveBudget,
      reviewMaxIter,
      startIteration,
      ...(overrides.criticModel ? { criticModel: overrides.criticModel } : {}),
      ...(overrides.criticMaxTurns !== undefined ? { criticMaxTurns: overrides.criticMaxTurns } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    onPhase({ kind: 'error', message });
    liveBudget.appendSummary();
    notify(`/research --resume --from=review: review phase threw: ${message}`, 'error');
    return;
  }

  const reviewApproved = review?.outcome.kind === 'passed';
  const doneMessage = reviewApproved
    ? 'review passed'
    : review?.level === 'error'
      ? 'review failed'
      : 'review complete';
  onPhase({ kind: 'done', message: doneMessage });
  liveBudget.appendSummary();

  // Stubbed-report short-circuit already notified via
  // `runDeepResearchReview`; skip the post-loop hint to avoid a
  // duplicate "review skipped" message.
  const stubHint = review?.outcome.kind === 'stubbed' ? null : formatStubHint(runRoot);
  if (stubHint) notify(stubHint, 'warning');
}

/**
 * Phase-2 dispatcher: resume the real pipeline at `plan-crit`,
 * `fanout`, or `synth`. Reads the original question from the
 * on-disk `plan.json` (so the pipeline's planner phase — always
 * called but skipped via `resumeFrom` — has a stable argument),
 * invalidates failed/aborted/pending fanout tasks when resuming
 * from `fanout`, and then calls {@link runResearchPipeline} with
 * `resumeFrom` + `resumeRunRoot` pinned. The review phase runs
 * after a `report-complete` outcome, same as
 * {@link runResearchFlow}.
 *
 * Mirrors the shape of `runResearchFlow` deliberately: both build
 * the same statusline + liveBudget wiring, both drive
 * `runReviewPhase` on `report-complete`, both emit a terminal
 * `done` / `error` event. The two functions share
 * {@link buildPipelineDeps} so model / maxTurns overrides behave
 * identically between fresh and resumed runs.
 */
async function runResumePipelineStage(args: {
  ctx: ExtensionCommandContext;
  agentLoad: AgentLoadResult;
  notify: CommandNotify;
  runRoot: string;
  stage: 'plan-crit' | 'fanout' | 'synth';
  needsRefanout: string[];
  /**
   * Optional sub-question filter fed through to the pipeline's
   * synth stage. Populated on the `--sq` targeted-fanout path so
   * re-synth only re-renders the listed ids; unaffected sections
   * re-use their existing `snapshots/sections/<id>.md` snapshots.
   */
  synthSubQuestionIds?: readonly string[];
  overrides: ResearchOverrides;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, agentLoad, notify, runRoot, stage, needsRefanout, synthSubQuestionIds, overrides } = args;
  const p = paths(runRoot);

  // Read the question + plan from disk. Cannot proceed without it
  // — `validateRunRoot` upstream already confirmed the file is
  // parseable, but defend against a race / hand-edit that broke it.
  let question: string;
  try {
    const plan = readPlan(p.plan);
    if (plan.kind !== 'deep-research') {
      notify(
        `/research --resume --from=${stage}: plan.json under ${runRoot} is kind=${plan.kind}; expected deep-research`,
        'error',
      );
      return;
    }
    question = plan.question;
  } catch (e) {
    notify(`/research --resume --from=${stage}: failed to read plan.json: ${(e as Error).message}`, 'error');
    return;
  }

  // Fanout resume: flip failed/aborted/pending tasks back to
  // 'pending' so the idempotent fanout dispatcher re-spawns only
  // the ones that need it. No-op when needsRefanout is empty (all
  // findings present and marked completed on disk).
  if (stage === 'fanout' && needsRefanout.length > 0) {
    const result = invalidateIncompleteFanoutTasks(runRoot, needsRefanout);
    if (!result.ok) {
      notify(
        `/research --resume --from=fanout: fanout.json invalidation failed: ${result.error ?? '<unknown>'}`,
        'error',
      );
      return;
    }
    if (result.reset.length > 0) {
      notify(`/research --resume --from=fanout: re-dispatching ${result.reset.join(', ')}`, 'info');
    }
  }

  const statusline = buildStatuslineController(ctx);
  statusline.emit({ kind: 'start' });
  const liveBudget = createLiveBudget({
    budget: createRunBudget(DEFAULT_BUDGET_PHASES.map((phase) => ({ ...phase }))),
  });
  const onPhase = (event: PhaseEvent): void => {
    statusline.emit(event);
    try {
      liveBudget.observePhaseEvent(event);
    } catch {
      /* swallow — budget observation must never break the run */
    }
  };
  try {
    liveBudget.setJournalPath(p.journal);
  } catch {
    /* swallow */
  }

  const built = buildPipelineDeps(ctx, agentLoad, {
    onPhase,
    liveBudget,
    overrides,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!built.ok) {
    onPhase({ kind: 'error', message: built.error });
    liveBudget.appendSummary();
    notify(`/research --resume --from=${stage}: ${built.error}`, 'error');
    return;
  }

  // Thread the resume flags into the pipeline deps. Cloning via
  // spread is intentional — `built.deps` is shared with the review
  // path below, and that path must NOT see resumeFrom set (review
  // re-uses the same deps to spin up its refinement sessions).
  const resumeDeps: PipelineDeps<unknown> = {
    ...built.deps,
    resumeFrom: stage,
    resumeRunRoot: runRoot,
    ...(synthSubQuestionIds && synthSubQuestionIds.length > 0 ? { synthSubQuestionIds } : {}),
  };

  let outcome: PipelineOutcome;
  try {
    outcome = await runResearchPipeline(question, resumeDeps);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    onPhase({ kind: 'error', message });
    liveBudget.appendSummary();
    notify(`/research --resume --from=${stage}: pipeline threw: ${message}`, 'error');
    return;
  }

  surfaceOutcome(outcome, notify);

  if (outcome.kind === 'planner-stuck') {
    onPhase({ kind: 'error', message: `planner stuck: ${outcome.reason}` });
    liveBudget.appendSummary();
    return;
  }
  if (outcome.kind === 'checkpoint') {
    onPhase({ kind: 'error', message: `plan-crit checkpoint (${outcome.outcome.kind})` });
    liveBudget.appendSummary();
    return;
  }
  if (outcome.kind === 'error') {
    onPhase({ kind: 'error', message: outcome.error });
    liveBudget.appendSummary();
    return;
  }
  if (outcome.kind === 'fanout-complete') {
    onPhase({ kind: 'done', message: 'fanout complete (no synth)' });
    liveBudget.appendSummary();
    return;
  }

  // report-complete — drive the review phase against the (re-)rendered
  // report. Same shape as runResearchFlow's post-synth branch.
  let review: ReviewWireResult | null = null;
  try {
    review = await runReviewPhase({
      ctx,
      runRoot: outcome.runRoot,
      notify,
      agentLoad,
      pipelineDeps: built.deps,
      parentModel: built.parentModel,
      emitPhase: onPhase,
      liveBudget,
      ...(overrides.criticModel ? { criticModel: overrides.criticModel } : {}),
      ...(overrides.criticMaxTurns !== undefined ? { criticMaxTurns: overrides.criticMaxTurns } : {}),
      ...(overrides.reviewMaxIter !== undefined ? { reviewMaxIter: overrides.reviewMaxIter } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    onPhase({ kind: 'error', message });
    liveBudget.appendSummary();
    notify(`/research --resume --from=${stage}: review phase threw: ${message}`, 'error');
    return;
  }

  const reviewApproved = review?.outcome.kind === 'passed';
  const doneMessage = reviewApproved
    ? 'review passed'
    : review?.level === 'error'
      ? 'review failed'
      : 'review complete';
  onPhase({ kind: 'done', message: doneMessage });
  liveBudget.appendSummary();

  // Stubbed-report short-circuit already notified via
  // `runDeepResearchReview`; skip the post-loop hint on the
  // resume pipeline path too so fresh-run and resume paths stay
  // symmetric.
  const stubHint = review?.outcome.kind === 'stubbed' ? null : formatStubHint(outcome.runRoot);
  if (stubHint) notify(stubHint, 'warning');
}

/**
 * Options threaded into `buildPipelineDeps` to wire up Phase-5
 * observability (statusline widget) without touching the core
 * pipeline deps shape.
 */
interface PipelineDepsExtras {
  /** Statusline/journal phase emitter. */
  onPhase?: (event: PhaseEvent) => void;
  /** Additional abort signal merged into the pipeline's own. */
  signal?: AbortSignal;
  /**
   * Live-budget wrapper. When set, cost hooks for the parent
   * session + each subagent spawn route their USD deltas into
   * the budget's phase trackers. Wall-clock + overrun warnings
   * are driven by `observePhaseEvent` wired through `onPhase`
   * in the caller.
   */
  liveBudget?: LiveBudget;
  /**
   * Per-run overrides (model / maxTurns). Pre-validated by the
   * caller. See `lib/node/pi/research-command-args.ts`.
   */
  overrides?: ResearchOverrides;
}

function buildPipelineDeps(
  ctx: ExtensionCommandContext,
  agentLoad: AgentLoadResult,
  extras: PipelineDepsExtras = {},
): BuildDepsOk<unknown> | BuildDepsErr {
  const webAgent = agentLoad.agents.get('web-researcher');
  if (!webAgent) {
    return { ok: false, error: 'agent "web-researcher" not loaded (is config/pi/agents/web-researcher.md shipped?)' };
  }
  const criticAgent = agentLoad.agents.get('research-planning-critic');
  if (!criticAgent) {
    return {
      ok: false,
      error: 'agent "research-planning-critic" not loaded (ship research-core Phase 5 first)',
    };
  }

  const modelRegistry = ctx.modelRegistry;
  // Resolve the parent-model override (if any) once, up front.
  // `parseResearchCommandArgs` / `validateToolOverrides` have
  // already validated the shape — all we do here is look up the
  // Model<any> via the same registry `runOneShotAgent` uses.
  let parentModel = ctx.model;
  if (extras.overrides?.model) {
    const slash = extras.overrides.model.indexOf('/');
    const provider = extras.overrides.model.slice(0, slash);
    const modelId = extras.overrides.model.slice(slash + 1);
    const resolved = modelRegistry.find(provider, modelId);
    if (!resolved) {
      return {
        ok: false,
        error: `--model ${extras.overrides.model} not registered in this pi session’s model registry (run /login or /models to inspect available models)`,
      };
    }
    parentModel = resolved as typeof ctx.model;
  }
  const modelLabel = describeModel(parentModel);
  // ExtensionCommandContext does not expose thinkingLevel; the
  // parent ExtensionAPI does, but capturing it requires a closure
  // here. Record `null` — the provenance module accepts null as
  // an explicit "not recorded" signal (see research-provenance).
  const thinkingLabel: string | null = null;

  const mergedSignal = extras.signal ?? ctx.signal;

  const deps: PipelineDeps<unknown> = {
    cwd: ctx.cwd,
    model: modelLabel,
    thinkingLevel: thinkingLabel,
    fanoutMode: 'sync', // Sync fanout via runOneShotAgent per task; background fanout is a follow-up.
    runSynth: true, // Run full synth-sections + merge into report.md.
    ...(mergedSignal ? { signal: mergedSignal } : {}),
    ...(extras.onPhase ? { onPhase: extras.onPhase } : {}),
    ...(extras.overrides?.fanoutParallel !== undefined ? { maxConcurrent: extras.overrides.fanoutParallel } : {}),
    ...(extras.overrides?.wallClockSec !== undefined ? { wallClockSecOverride: extras.overrides.wallClockSec } : {}),
    createSession: async (): Promise<ResearchSessionLikeWithLifecycle> => {
      // Build a parent session for the planner / self-critic /
      // rewrite turns. Same shape runOneShotAgent uses, minus the
      // single-prompt constraint.
      const resource = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        settingsManager: undefined,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
      });
      await resource.reload();
      // Persist this session under `<sessionDir>/subagents/<parentId>/`
      // so `pi session-usage` / `ai-tool-usage` can attribute its
      // usage + cost back to the parent pi session — same layout
      // the harness's built-in `subagent` tool uses. Falls back to
      // an in-memory manager when the parent session id is
      // unavailable (tests, resume flows).
      const manager = makeSubagentSessionManager(ctx);
      if (!parentModel) {
        throw new Error('no parent model available (use /login or set a default)');
      }
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: parentModel,
        thinkingLevel: 'off',
        tools: [],
        modelRegistry,
        authStorage: modelRegistry.authStorage,
        resourceLoader: resource,
        sessionManager: manager,
      });
      // Subscribe the cost hook so every assistant turn in the
      // parent session (planner / self-critic / rewrite / synth /
      // merge / refine) emits a `{kind:'cost', deltaUsd}` into the
      // statusline reducer AND lands on the currently-open phase
      // bucket in the LiveBudget (parent-session phases switch
      // over the session's lifetime, so we use the live tracker).
      if (extras.onPhase || extras.liveBudget) {
        const hook = createCostHook({
          ...(extras.onPhase ? { emit: extras.onPhase } : {}),
          ...(extras.liveBudget ? { tracker: extras.liveBudget.currentPhaseTracker } : {}),
        });
        session.subscribe(hook.subscribe);
      }
      return wrapSession(session);
    },
    runPlanningCritic: async ({ task, signal }) => {
      const resolution = resolveChildModel({
        agent: criticAgent,
        parent: parentModel,
        modelRegistry,
        ...(extras.overrides?.planCritModel ? { override: extras.overrides.planCritModel } : {}),
      });
      if (!resolution.ok) return { rawText: '', error: resolution.error };
      try {
        const costHook =
          extras.onPhase || extras.liveBudget
            ? createCostHook({
                ...(extras.onPhase ? { emit: extras.onPhase } : {}),
                ...(extras.liveBudget ? { tracker: extras.liveBudget.trackerFor('plan-crit') } : {}),
              })
            : undefined;
        const result = await runOneShotAgent({
          deps: { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
          cwd: ctx.cwd,
          agent: criticAgent,
          model: resolution.model,
          task,
          modelRegistry,
          agentDir: getAgentDir(),
          sessionManager: makeSubagentSessionManager(ctx),
          ...(costHook ? { onEvent: costHook.onEvent } : {}),
          ...(signal ? { signal } : {}),
          ...(extras.overrides?.criticMaxTurns !== undefined ? { maxTurns: extras.overrides.criticMaxTurns } : {}),
        });
        if (result.stopReason !== 'completed') {
          return { rawText: result.finalText, error: result.errorMessage ?? `critic stop=${result.stopReason}` };
        }
        return { rawText: result.finalText };
      } catch (e) {
        return { rawText: '', error: (e as Error).message };
      }
    },
    fanoutSpawn: wrapFanoutForProgress(
      buildSyncFanoutSpawner(
        ctx,
        webAgent,
        modelRegistry,
        parentModel,
        extras.onPhase,
        extras.liveBudget,
        extras.overrides?.fanoutMaxTurns,
        extras.overrides?.fanoutModel,
      ),
      extras.onPhase,
    ),
    mcpClient: createAiFetchWebCliClientFromEnv() ?? undefined,
    onCriticCheckpoint: (outcome) => {
      ctx.ui.notify(
        `/research: planning-critic rejected the plan (${outcome.kind}). Plan is on disk — edit ./research/<slug>/plan.json and rerun \`/research <question>\` to retry. Pipeline halted before fanout.`,
        'warning',
      );
      return { continue: false };
    },
  };

  return { ok: true, deps, parentModel };
}

function describeModel(m: unknown): string {
  if (!m || typeof m !== 'object') return 'unknown';
  const obj = m as { provider?: unknown; id?: unknown };
  if (typeof obj.provider === 'string' && typeof obj.id === 'string') return `${obj.provider}/${obj.id}`;
  return 'unknown';
}

/**
 * Wrap a fanout spawner so each task's `wait()` resolution
 * advances a cumulative `fanout-progress` event on `onPhase`.
 * The pipeline emits `fanout-start { total }` right before
 * invoking the fanout, so the statusline reducer can inherit
 * `total` from its own state when we omit it here.
 *
 * Returns the inner spawner unchanged when `onPhase` is undefined.
 */
function wrapFanoutForProgress(
  inner: FanoutSpawner,
  onPhase: ((event: PhaseEvent) => void) | undefined,
): FanoutSpawner {
  if (!onPhase) return inner;
  let done = 0;
  return async (args: FanoutSpawnArgs): Promise<FanoutHandleLike> => {
    const handle = await inner(args);
    const originalWait = handle.wait.bind(handle);
    handle.wait = async (): Promise<FanoutHandleResult> => {
      try {
        const res = await originalWait();
        done += 1;
        try {
          onPhase({ kind: 'fanout-progress', done });
        } catch {
          /* swallow — observability must never break fanout */
        }
        return res;
      } catch (e) {
        done += 1;
        try {
          onPhase({ kind: 'fanout-progress', done });
        } catch {
          /* swallow */
        }
        throw e;
      }
    };
    return handle;
  };
}

/**
 * Wrap an `AgentSessionLike` as a `ResearchSessionLike` usable by
 * `research-structured.callTyped`. Forwards `prompt`/`state.messages`
 * and exposes `dispose()` so the pipeline can clean up.
 */
function wrapSession(session: AgentSessionLike): ResearchSessionLikeWithLifecycle {
  return {
    prompt: (task: string) => session.prompt(task),
    get state() {
      return session.state as { messages: readonly { role: string; content?: { type: string; text?: string }[] }[] };
    },
    dispose: () => {
      try {
        session.dispose();
      } catch {
        /* best-effort */
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Sync fanout spawner.
// ──────────────────────────────────────────────────────────────────────

/**
 * Sync-mode fanout spawner: each task runs through
 * `runOneShotAgent` serially (the fanout dispatcher respects
 * `maxConcurrent`, and we set it to 1 downstream so tasks execute
 * one-at-a-time). The returned handle looks "background-like" so
 * the watchdog + fanout machinery can drive it unchanged — on
 * construction we've already run the task synchronously, so the
 * first `status()` reports `done: true` and `wait()` returns the
 * cached result.
 *
 * This keeps the pipeline shape honest (the same validation +
 * validation + quarantine + resume paths run) without requiring
 * the extension to plumb real background subagent handles yet.
 */
function buildSyncFanoutSpawner<M>(
  ctx: ExtensionCommandContext,
  agent: AgentDef,
  modelRegistry: {
    find: (provider: string, id: string) => unknown;
    authStorage: unknown;
  },
  parent: M | undefined,
  onPhase: ((event: PhaseEvent) => void) | undefined,
  liveBudget: LiveBudget | undefined,
  maxTurnsOverride: number | undefined,
  modelOverride: string | undefined,
): FanoutSpawner {
  return async (args: FanoutSpawnArgs): Promise<FanoutHandleLike> => {
    const resolution = resolveChildModel({
      agent,
      parent,
      modelRegistry: modelRegistry as never,
      ...(modelOverride ? { override: modelOverride } : {}),
    });
    if (!resolution.ok) {
      throw new Error(`fanout spawn: ${resolution.error}`);
    }
    const progressAt = Date.now();
    let result: FanoutHandleResult;
    try {
      const costHook =
        onPhase || liveBudget
          ? createCostHook({
              ...(onPhase ? { emit: onPhase } : {}),
              ...(liveBudget ? { tracker: liveBudget.trackerFor('fanout') } : {}),
            })
          : undefined;
      // Retry on transient network failures (Connection error /
      // ECONNRESET / 429 / 5xx) so a brief backend blip doesn't kill
      // the whole fanout batch. Observed failure mode: N concurrent
      // subagents against a single local-model backend all hit a
      // connection error at the same millisecond when the backend
      // overloads. Jittered backoff in `withTransientRetry` prevents
      // the retries from re-colliding at the same instant. Scoped to
      // this callSite only — the fanout's own idempotency (one
      // finding file per sub-question) + `--resume --from=fanout`
      // remain the authoritative recovery mechanism for persistent
      // failures. maxAttempts=3 means initial + 2 retries, ~4.5s
      // total worst-case wait.
      const run = await withTransientRetry(
        () =>
          runOneShotAgent({
            deps: { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
            cwd: ctx.cwd,
            agent,
            model: resolution.model,
            task: args.task.prompt,
            modelRegistry: modelRegistry as never,
            agentDir: getAgentDir(),
            sessionManager: makeSubagentSessionManager(ctx),
            ...(costHook ? { onEvent: costHook.onEvent } : {}),
            ...(args.signal ? { signal: args.signal } : {}),
            ...(maxTurnsOverride !== undefined ? { maxTurns: maxTurnsOverride } : {}),
          }),
        {
          maxAttempts: 3,
          initialDelayMs: 1500,
          maxDelayMs: 8000,
          ...(args.signal ? { signal: args.signal } : {}),
        },
      );
      if (run.stopReason === 'completed') {
        result = { ok: true, output: run.finalText };
      } else if (run.stopReason === 'aborted') {
        result = { ok: false, reason: run.errorMessage ?? 'aborted', aborted: true };
      } else {
        result = { ok: false, reason: run.errorMessage ?? `stop=${run.stopReason}` };
      }
    } catch (e) {
      result = { ok: false, reason: (e as Error).message };
    }

    return {
      id: args.task.id,
      status: () =>
        Promise.resolve({
          done: true,
          lastProgressAt: progressAt,
        }),
      abort: () => Promise.resolve(),
      wait: () => Promise.resolve(result),
    };
  };
}

// ──────────────────────────────────────────────────────────────────────
// Outcome surfacing.
// ──────────────────────────────────────────────────────────────────────

function surfaceOutcome(outcome: PipelineOutcome, notify: CommandNotify): void {
  switch (outcome.kind) {
    case 'report-complete': {
      const lines: string[] = [];
      lines.push(`/research: report written at ${outcome.merge.reportPath}`);
      lines.push(
        `  fanout: completed=${outcome.fanout.completed.length} failed=${outcome.fanout.failed.length} aborted=${outcome.fanout.aborted.length}`,
      );
      lines.push(
        `  synth: footnotes=${outcome.merge.footnoteCount} stubbed=${outcome.merge.stubbedSubQuestions.length} fallback-wrapper=${outcome.merge.usedFallback ? 'yes' : 'no'}`,
      );
      lines.push(`  two-stage review (structural + subjective critic) runs next.`);
      const level =
        outcome.merge.stubbedSubQuestions.length === 0 && outcome.quarantined.length === 0 ? 'info' : 'warning';
      notify(lines.join('\n'), level);
      return;
    }
    case 'fanout-complete': {
      const lines: string[] = [];
      lines.push(`/research: fanout complete under ${outcome.runRoot}`);
      lines.push(
        `  completed=${outcome.fanout.completed.length} failed=${outcome.fanout.failed.length} aborted=${outcome.fanout.aborted.length} quarantined=${outcome.quarantined.length}`,
      );
      lines.push(`  synth was not requested (runSynth=false); findings are on disk at ${outcome.runRoot}/findings/.`);
      notify(lines.join('\n'), outcome.quarantined.length === 0 ? 'info' : 'warning');
      return;
    }
    case 'planner-stuck':
      notify(
        `/research: planner emitted stuck — ${outcome.reason}\nPlan NOT written. Refine the question and retry.`,
        'warning',
      );
      return;
    case 'checkpoint':
      notify(
        `/research: planning-critic did not approve the plan (${outcome.outcome.kind}). Plan is at ${outcome.runRoot}/plan.json — edit it and rerun \`/research\`.`,
        'warning',
      );
      return;
    case 'error':
      notify(
        `/research: pipeline hit an error (${outcome.error}). ${outcome.runRoot}/journal.md has the details.`,
        'error',
      );
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 4 review phase — two-stage structural + subjective check.
// ─────────────────────────────────────────────────────────────────────

interface RunReviewPhaseArgs {
  ctx: ExtensionCommandContext;
  runRoot: string;
  notify: CommandNotify;
  agentLoad: AgentLoadResult;
  /**
   * Pipeline deps carrying the `createSession` factory, model
   * label, and thinkingLevel used by the refinement runner to
   * spin up a fresh synth session for each refinement iteration.
   * Optional because resume flows (which skip the pipeline run)
   * may want to drive review without a rebuild — in that case
   * `refineReport` degrades to the journal-only stub.
   */
  pipelineDeps?: PipelineDeps<unknown>;
  /** Phase-5 observability emitter. */
  emitPhase?: (event: PhaseEvent) => void;
  /**
   * Live-budget wrapper, when the caller owns one. Threads through
   * to the subjective critic's cost hook so its USD cost lands on
   * the `'review'` bucket.
   */
  liveBudget?: LiveBudget;
  /**
   * Parent model used as the `inherit` fallback for the subjective
   * critic spawn. When the caller applied a `--model` override in
   * `buildPipelineDeps`, this must carry that resolved model so
   * inherit-mode agents (the critic) honor the override rather
   * than silently falling back to `ctx.model`.
   */
  parentModel?: unknown;
  /**
   * Optional per-agent model override for the subjective critic
   * (`--critic-model` / tool `criticModel`). Takes precedence
   * over the inherit chain + `parentModel`.
   */
  criticModel?: string;
  /**
   * Optional maxTurns cap for the subjective critic spawn.
   * Comes from the slash command's `--critic-max-turns` flag or
   * the tool's `criticMaxTurns` param.
   */
  criticMaxTurns?: number;
  /**
   * Cap on cross-stage review iterations. Defaults to `4` when
   * omitted. Overridden via `--review-max-iter` /
   * `reviewMaxIter` or raised on a `/research --resume` to
   * extend a prior `budget-exhausted` run.
   */
  reviewMaxIter?: number;
  /**
   * Iteration label for the first iteration. Defaults to `1` on
   * a fresh review; resume flows compute this from the highest
   * existing `snapshots/review/iter-NNN-*.md` so new iterations
   * land as iter-(N+1), (N+2), … rather than overwriting.
   */
  startIteration?: number;
  /** Additional abort signal threaded into the review loop. */
  signal?: AbortSignal;
}

/**
 * Drive {@link runDeepResearchReview} with production deps. Wired
 * after `runResearchPipeline` returns `report-complete`.
 *
 * The structural runner calls {@link checkReportStructure} directly
 * (pure, deterministic) — identical semantics to the bash-check
 * surface the iteration-loop would spawn, without the subprocess.
 *
 * The critic runner spawns the `critic` agent via `runOneShotAgent`
 * using {@link buildCriticTask} / {@link parseVerdict}; see the
 * iteration-loop extension's own critic path for the identical
 * shape.
 *
 * The refinement runner spins up a fresh parent session per
 * refinement iteration (via the same `createSession` factory
 * `runSynthPhase` uses) and drives {@link refineReportRunner},
 * which re-invokes `runSectionSynth` for sections named by the
 * structural failures (or re-runs `runSynthMerge` with a nudge on
 * global / subjective failures), then disposes. When
 * `pipelineDeps` is unset the runner degrades to the journal-
 * only behavior so resume flows still surface a terminal
 * verdict instead of hanging.
 */
async function runReviewPhase(args: RunReviewPhaseArgs): Promise<ReviewWireResult | null> {
  const { ctx, runRoot, notify, agentLoad, emitPhase, liveBudget, criticMaxTurns, parentModel, criticModel } = args;
  // Signal used by all review-loop runners. Prefer the caller's
  // signal (threaded from `runResearchFlow`) and fall back to the
  // command's own `ctx.signal`, so Esc fires regardless of entry
  // point.
  const reviewSignal = args.signal ?? ctx.signal;
  const p = paths(runRoot);
  const rubricSubjective = safeReadFile(p.rubricSubjective) ?? '';
  const structuralBashCmd = buildStructuralBashCmd(runRoot);

  const runStructural: StructuralRunner = ({ iteration }) => {
    if (emitPhase) {
      try {
        emitPhase({ kind: 'structural', iteration });
      } catch {
        /* swallow */
      }
    }
    try {
      appendJournal(p.journal, { level: 'step', heading: `review structural iter ${iteration}` });
    } catch {
      /* swallow */
    }
    return Promise.resolve(checkReportStructure({ runRoot }));
  };

  const runCritic: CriticRunner = async ({ iteration }) => {
    if (emitPhase) {
      try {
        emitPhase({ kind: 'subjective', iteration });
      } catch {
        /* swallow */
      }
    }
    const criticAgent = agentLoad.agents.get('critic');
    if (!criticAgent) {
      // Missing agent — degrade gracefully: return a rejected
      // verdict the review loop surfaces as a refinement target.
      return {
        approved: false,
        score: 0,
        issues: [
          {
            severity: 'blocker',
            description: 'critic agent not loaded; cannot judge the report',
          },
        ],
        summary: 'critic agent missing',
      } satisfies Verdict;
    }
    const resolution = resolveChildModel({
      agent: criticAgent,
      parent: (parentModel ?? ctx.model) as never,
      modelRegistry: ctx.modelRegistry as never,
      ...(criticModel ? { override: criticModel } : {}),
    });
    if (!resolution.ok) {
      return {
        approved: false,
        score: 0,
        issues: [{ severity: 'blocker', description: `critic model resolution failed: ${resolution.error}` }],
        summary: 'critic model unavailable',
      } satisfies Verdict;
    }
    const task = buildCriticTask({
      spec: { rubric: rubricSubjective },
      artifactPath: p.report,
      iteration,
    });
    try {
      const costHook =
        emitPhase || liveBudget
          ? createCostHook({
              ...(emitPhase ? { emit: emitPhase } : {}),
              ...(liveBudget ? { tracker: liveBudget.trackerFor('review') } : {}),
            })
          : undefined;
      const run = await runOneShotAgent({
        deps: { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
        cwd: ctx.cwd,
        agent: criticAgent,
        model: resolution.model,
        task,
        modelRegistry: ctx.modelRegistry as never,
        agentDir: getAgentDir(),
        sessionManager: makeSubagentSessionManager(ctx),
        ...(costHook ? { onEvent: costHook.onEvent } : {}),
        ...(reviewSignal ? { signal: reviewSignal } : {}),
        ...(criticMaxTurns !== undefined ? { maxTurns: criticMaxTurns } : {}),
      });
      const parsed = parseVerdict(run.finalText);
      // `parseVerdict` is tolerant: on total failure it still returns
      // a synthesized `verdict` (approved: false, score 0, with the
      // parse error in `issues[0].description`) alongside a
      // `failed: true` flag. Use that verdict directly — surfacing
      // the real failure mode to the refinement nudge — and just
      // log the parse trouble for debugging. The earlier code read
      // `parsed.ok` / `parsed.error` (fields that don't exist on
      // `ParseVerdictResult`), which made every critic run look
      // unparseable regardless of model or output quality.
      if (parsed.failed) {
        try {
          appendJournal(paths(runRoot).journal, {
            level: 'warn',
            heading: `critic output tolerant-parse fallback (iter ${iteration})`,
            body: parsed.recovery ?? 'no recovery hint',
          });
        } catch {
          /* swallow — journal is best-effort here */
        }
      }
      return parsed.verdict;
    } catch (e) {
      return {
        approved: false,
        score: 0,
        issues: [{ severity: 'blocker', description: `critic runner threw: ${(e as Error).message}` }],
        summary: 'critic runner threw',
      } satisfies Verdict;
    }
  };

  const refineReport: RefinementRunner = async (req) => {
    try {
      appendJournal(p.journal, {
        level: 'warn',
        heading: `review refinement requested (${req.stage}, iter ${req.iteration})`,
        body: req.nudge,
      });
    } catch {
      /* swallow */
    }

    const pipelineDeps = args.pipelineDeps;
    if (!pipelineDeps) {
      // No pipeline deps in scope — nothing to drive a real
      // re-synth. Journal the nudge (already done above) and
      // declare success so the review loop progresses to its
      // budget-exhaustion path and the user sees a surfaced
      // verdict instead of a hang.
      return { ok: true };
    }

    // Load the current plan from disk so we have the
    // sub-question list the refiner maps structural failures
    // against. Reading on every refinement (instead of caching)
    // keeps the runner resilient to mid-loop plan edits.
    let plan: Awaited<ReturnType<typeof readPlan>>;
    try {
      plan = readPlan(p.plan);
    } catch (e) {
      return { ok: false, error: `refineReport: could not read plan.json: ${(e as Error).message}` };
    }
    if (plan.kind !== 'deep-research') {
      return { ok: false, error: `refineReport: plan is ${plan.kind}, expected deep-research` };
    }

    // Build a fresh parent session for this refinement. Same
    // shape runSynthPhase uses; dispose on exit (success or
    // failure) so the harness reclaims resources.
    let session: Awaited<ReturnType<typeof pipelineDeps.createSession>>;
    try {
      session = await pipelineDeps.createSession();
    } catch (e) {
      return { ok: false, error: `refineReport: createSession failed: ${(e as Error).message}` };
    }

    try {
      await refineReportRunner<unknown>({
        runRoot,
        plan,
        stage: req.stage,
        iteration: req.iteration,
        session,
        model: pipelineDeps.model,
        thinkingLevel: pipelineDeps.thinkingLevel,
        ...(req.structural ? { structural: req.structural } : {}),
        ...(req.critic ? { critic: req.critic } : {}),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `refineReport: runner threw: ${(e as Error).message}` };
    } finally {
      if (session.dispose) {
        try {
          await session.dispose();
        } catch {
          /* swallow — dispose is best-effort */
        }
      }
    }
  };

  try {
    return await runDeepResearchReview({
      cwd: ctx.cwd,
      runRoot,
      rubricSubjective,
      structuralBashCmd,
      runStructural,
      runCritic,
      refineReport,
      maxIter: args.reviewMaxIter ?? 4,
      ...(args.startIteration !== undefined ? { startIteration: args.startIteration } : {}),
      ...(reviewSignal ? { signal: reviewSignal } : {}),
      notify,
    });
  } catch (e) {
    notify(`/research: review phase threw: ${(e as Error).message}`, 'error');
    return null;
  }
}

/**
 * Build the bash command string we record in the structural check
 * spec. The production review path calls `checkReportStructure`
 * directly; this string is purely informational — it shows up in
 * `/check list` output so a user can see what a manual structural
 * re-run would look like.
 *
 * Each path is wrapped in POSIX single quotes and has any embedded
 * single quote escaped via `'\''` so paths containing spaces
 * (common on macOS under `~/Library/...` or WSL mounts like
 * `/mnt/c/Users/First Last/`) remain copy-pasteable.
 */
function buildStructuralBashCmd(runRoot: string): string {
  const scriptPath = fileURLToPath(new URL('../../../lib/node/pi/deep-research-structural-check.ts', import.meta.url));
  return `node ${shellQuote(scriptPath)} ${shellQuote(runRoot)}`;
}

/** Minimal POSIX shell single-quote for a single argument. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Build a fresh {@link SessionManager} that persists a child
 * session under
 * `<parentSessionDir>/subagents/<parentSessionId>/`.
 *
 * This is the same directory convention the harness's built-in
 * `subagent` tool uses, and the one
 * [`config/pi/session-usage.ts`](../session-usage.ts) walks to
 * attribute child-session usage + cost back to the parent pi
 * session. Before this helper landed, every research-pipeline
 * spawn went through `SessionManager.inMemory(ctx.cwd)` — the
 * default on
 * [`subagent-spawn.ts`](../../../lib/node/pi/subagent-spawn.ts)
 * — so child transcripts never hit disk and `pi session-usage` /
 * `ai-tool-usage` had no evidence the research runs ever ran.
 *
 * Call per spawn (every research subagent gets its own jsonl in
 * that directory). **Throws** when the parent session has no id
 * or no dir (rare — typically `pi -p --no-session` or an in-memory
 * test harness). Prior to this guard the helper silently fell back
 * to `SessionManager.inMemory(ctx.cwd)` and child transcripts were
 * dropped on the floor, which broke both cost/audit attribution
 * (`pi session-usage` / `ai-tool-usage` had no evidence the run
 * ever existed) and debuggability (no forensic trail when a fanout
 * subagent errored). Callers that genuinely need an ephemeral
 * run should surface the precondition to the user instead of
 * burying it.
 */
function makeSubagentSessionManager(ctx: ExtensionCommandContext): SessionManager {
  let parentId: string | undefined;
  let parentDir: string | undefined;
  try {
    parentId = ctx.sessionManager.getSessionId();
    parentDir = ctx.sessionManager.getSessionDir();
  } catch (e) {
    throw new Error(
      `deep-research: cannot persist subagent session — parent sessionManager threw while reading id/dir (${(e as Error).message}). ` +
        'Restart pi without --no-session (or set --session-dir) so subagent transcripts can be recorded for cost + audit tracking.',
    );
  }
  if (!parentId || !parentDir) {
    throw new Error(
      'deep-research: cannot persist subagent session — parent session has no id/dir (running pi with --no-session?). ' +
        'Restart pi without --no-session (or set --session-dir) so subagent transcripts are recorded for cost + audit tracking. ' +
        'deep-research refuses to run against an untracked parent session because every fanout/synth/critic spawn would silently drop its transcript.',
    );
  }
  return SessionManager.create(ctx.cwd, join(parentDir, 'subagents', parentId));
}
