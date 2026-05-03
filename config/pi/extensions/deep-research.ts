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

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
} from '@mariozechner/pi-coding-agent';
import { Text } from '@mariozechner/pi-tui';
import { Type } from 'typebox';

import {
  runResearchPipeline,
  type PipelineDeps,
  type PipelineOutcome,
  type ResearchSessionLikeWithLifecycle,
} from '../../../lib/node/pi/deep-research-pipeline.ts';
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
import { buildCriticTask, parseVerdict } from '../../../lib/node/pi/iteration-loop-check-critic.ts';
import { type Verdict } from '../../../lib/node/pi/iteration-loop-schema.ts';
import {
  type FanoutHandleLike,
  type FanoutHandleResult,
  type FanoutSpawner,
  type FanoutSpawnArgs,
} from '../../../lib/node/pi/research-fanout.ts';
import { appendJournal } from '../../../lib/node/pi/research-journal.ts';
import { paths } from '../../../lib/node/pi/research-paths.ts';
import {
  type CommandNotify,
  type CommandNotifyLevel,
  runListCommand,
  runSelftestCommand,
} from '../../../lib/node/pi/research-runs.ts';
import { selftestDeepResearch } from '../../../lib/node/pi/research-selftest.ts';
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
  '  /research <question>   — run the planner → synth pipeline; writes report.md\n' +
  '  /research --list       — list runs under ./research/\n' +
  '  /research --selftest   — run the research-core self-test fixture';

/**
 * Statusline widget key, shared between the command handler and
 * the `research` tool so they both write into the same slot.
 */
const STATUSLINE_KEY = 'deep-research';

/**
 * TypeBox schema for the LLM-callable `research` tool. Single
 * required field: the research question.
 */
const ResearchToolParams = Type.Object({
  question: Type.String({
    description:
      'Research question. Runs the full deep-research pipeline (plan → fanout → synth → two-stage review) and returns a summary + report path.',
  }),
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
      const args = (rawArgs ?? '').trim();
      const [firstToken = '', ...restTokens] = args.split(/\s+/);
      const rest = restTokens.join(' ').trim();
      const notify: CommandNotify = (message: string, level: CommandNotifyLevel) => {
        ctx.ui.notify(message, level);
      };

      if (args === '' || firstToken === '--help' || firstToken === '-h') {
        notify(USAGE, 'info');
        return;
      }

      if (firstToken === '--list') {
        if (rest) notify(`/research --list: ignoring trailing args: ${JSON.stringify(rest)}`, 'warning');
        runListCommand({ cwd: ctx.cwd, notify });
        return;
      }

      if (firstToken === '--selftest') {
        if (rest) notify(`/research --selftest: ignoring trailing args: ${JSON.stringify(rest)}`, 'warning');
        await runSelftestCommand({ cwd: ctx.cwd, selftest: selftestDeepResearch, notify });
        return;
      }

      // Everything else is treated as the research question.
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

      notify(
        `/research: starting pipeline — planner → self-critic → planning-critic → fanout → synth → report`,
        'info',
      );
      researchFlag.active = true;
      try {
        await runResearchFlow({
          ctx,
          agentLoad,
          question: args,
          notify,
          surfacePipelineOutcome: true,
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
    ],
    parameters: ResearchToolParams,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as unknown as { question: string };
      const question = (params.question ?? '').trim();
      if (!question) {
        throw new Error('research: `question` is empty');
      }

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
      const q =
        typeof (args as { question?: unknown }).question === 'string'
          ? ((args as { question: string }).question ?? '')
          : '';
      const label = theme.fg('toolTitle', theme.bold('research')) + ' ' + theme.fg('muted', truncateTool(q, 80));
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
  const render = (): void => {
    try {
      ctx.ui.setWidget(STATUSLINE_KEY, renderStatuslineWidget(state, Date.now()));
    } catch {
      /* swallow — widget failures must never break the pipeline */
    }
  };
  const emit = (event: PhaseEvent): void => {
    if (event.kind === 'start') {
      // Re-anchor the elapsed clock on explicit start so a second
      // research run in the same session doesn't show the prior
      // run's wall-clock.
      state = initialStatuslineState(Date.now());
    } else {
      state = reduceStatusline(state, event);
    }
    render();
  };
  const clear = (): void => {
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
}): Promise<ResearchToolRunOutcome> {
  const { ctx, agentLoad, question, notify, surfacePipelineOutcome } = args;
  const statusline = args.statusline ?? buildStatuslineController(ctx);
  statusline.emit({ kind: 'start' });

  const built = buildPipelineDeps(ctx, agentLoad, {
    onPhase: statusline.emit,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!built.ok) {
    statusline.emit({ kind: 'error', message: built.error });
    return { kind: 'error', error: built.error };
  }

  let outcome: PipelineOutcome;
  try {
    outcome = await runResearchPipeline(question, built.deps);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    statusline.emit({ kind: 'error', message });
    return { kind: 'error', error: `pipeline threw: ${message}` };
  }

  if (surfacePipelineOutcome) {
    surfaceOutcome(outcome, notify);
  }

  // Non-report terminal states: emit done / error and bail.
  if (outcome.kind === 'planner-stuck') {
    statusline.emit({ kind: 'error', message: `planner stuck: ${outcome.reason}` });
    return { kind: 'planner-stuck', runRoot: outcome.runRoot, reason: outcome.reason };
  }
  if (outcome.kind === 'checkpoint') {
    statusline.emit({ kind: 'error', message: `plan-crit checkpoint (${outcome.outcome.kind})` });
    return { kind: 'checkpoint', runRoot: outcome.runRoot, reason: outcome.outcome.kind };
  }
  if (outcome.kind === 'error') {
    statusline.emit({ kind: 'error', message: outcome.error });
    return { kind: 'error', runRoot: outcome.runRoot, error: outcome.error };
  }
  if (outcome.kind === 'fanout-complete') {
    statusline.emit({ kind: 'done', message: 'fanout complete (no synth)' });
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
      emitPhase: statusline.emit,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    statusline.emit({ kind: 'error', message });
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
  statusline.emit({ kind: 'done', message: doneMessage });

  return {
    kind: 'report-complete',
    reportPath: outcome.merge.reportPath,
    runRoot: outcome.runRoot,
    subjectiveApproved: reviewApproved,
    ...(review ? { summary: review.summary } : {}),
  };
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
  const parentModel = ctx.model;
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
      const manager = SessionManager.inMemory(ctx.cwd);
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
      return wrapSession(session);
    },
    runPlanningCritic: async ({ task, signal }) => {
      const resolution = resolveChildModel({
        agent: criticAgent,
        parent: parentModel,
        modelRegistry,
      });
      if (!resolution.ok) return { rawText: '', error: resolution.error };
      try {
        const result = await runOneShotAgent({
          deps: { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
          cwd: ctx.cwd,
          agent: criticAgent,
          model: resolution.model,
          task,
          modelRegistry,
          agentDir: getAgentDir(),
          ...(signal ? { signal } : {}),
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
      buildSyncFanoutSpawner(ctx, webAgent, modelRegistry, parentModel),
      extras.onPhase,
    ),
    onCriticCheckpoint: (outcome) => {
      ctx.ui.notify(
        `/research: planning-critic rejected the plan (${outcome.kind}). Plan is on disk — edit ./research/<slug>/plan.json and rerun \`/research <question>\` to retry. Pipeline halted before fanout.`,
        'warning',
      );
      return { continue: false };
    },
  };

  return { ok: true, deps };
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
): FanoutSpawner {
  return async (args: FanoutSpawnArgs): Promise<FanoutHandleLike> => {
    const resolution = resolveChildModel({ agent, parent, modelRegistry: modelRegistry as never });
    if (!resolution.ok) {
      throw new Error(`fanout spawn: ${resolution.error}`);
    }
    const progressAt = Date.now();
    let result: FanoutHandleResult;
    try {
      const run = await runOneShotAgent({
        deps: { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
        cwd: ctx.cwd,
        agent,
        model: resolution.model,
        task: args.task.prompt,
        modelRegistry: modelRegistry as never,
        agentDir: getAgentDir(),
        ...(args.signal ? { signal: args.signal } : {}),
      });
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
  /** Phase-5 observability emitter. */
  emitPhase?: (event: PhaseEvent) => void;
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
 * The refinement runner, for Phase 4, is a best-effort stub: it
 * journals the nudge so the next iteration has access to it but
 * does not yet re-run synth. Phase 5/6 extends this to re-drive
 * `runSynthMerge` with the nudge threaded as a prior-turn
 * message. With the stub in place, a failing first iteration
 * triggers budget exhaustion on subsequent ones — the outcome
 * returned to the user correctly reports the failure; the
 * refinement fidelity is a pure-implementation follow-up, not a
 * contract question.
 */
async function runReviewPhase(args: RunReviewPhaseArgs): Promise<ReviewWireResult | null> {
  const { ctx, runRoot, notify, agentLoad, emitPhase } = args;
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
      parent: ctx.model as never,
      modelRegistry: ctx.modelRegistry as never,
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
      const run = await runOneShotAgent({
        deps: { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
        cwd: ctx.cwd,
        agent: criticAgent,
        model: resolution.model,
        task,
        modelRegistry: ctx.modelRegistry as never,
        agentDir: getAgentDir(),
        ...(reviewSignal ? { signal: reviewSignal } : {}),
      });
      const parsed = parseVerdict(run.finalText);
      if (parsed.ok) return parsed.verdict;
      return {
        approved: false,
        score: 0,
        issues: [{ severity: 'major', description: `critic verdict unparseable: ${parsed.error}` }],
        summary: 'critic verdict unparseable',
      } satisfies Verdict;
    } catch (e) {
      return {
        approved: false,
        score: 0,
        issues: [{ severity: 'blocker', description: `critic runner threw: ${(e as Error).message}` }],
        summary: 'critic runner threw',
      } satisfies Verdict;
    }
  };

  const refineReport: RefinementRunner = (req) => {
    try {
      appendJournal(p.journal, {
        level: 'warn',
        heading: `review refinement requested (${req.stage}, iter ${req.iteration})`,
        body: req.nudge,
      });
    } catch {
      /* swallow */
    }
    // Phase-4 scope: the refinement path is structural + critic
    // nudges landing in the journal. Re-running synth with the
    // nudge threaded into the prompt is a Phase-5/6 expansion;
    // returning ok: true here is deliberate so the review loop
    // progresses to its budget-exhaustion / override paths and
    // the user sees a surfaced outcome instead of a hang.
    return Promise.resolve({ ok: true });
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
      maxIter: 4,
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
