/* Read "Internals" at the bottom — public command surface comes
 * first. The `no-use-before-define` rule is disabled at the file
 * scope because TS function declarations are hoisted and this
 * ordering reads top-down (command handler → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Deep-research extension for pi — Phase 2 shell.
 *
 * Registers the `/research` slash command with three sub-forms:
 *
 *   - `/research --list`      → walk `./research/`, print a
 *                                `slug | status | wall-clock | cost`
 *                                table via `research-runs.runListCommand`.
 *   - `/research --selftest`  → run the research-core canned fixture
 *                                via `research-selftest.selftestDeepResearch`
 *                                and report the result.
 *   - `/research <question>`  → Phase 2 scope: planner → self-critic →
 *                                planning-critic → fanout (no synth).
 *                                Wires the pure `runResearchPipeline`
 *                                orchestration from
 *                                `lib/node/pi/deep-research-pipeline.ts`
 *                                to pi's session + subagent plumbing.
 *
 * The heavy lifting (stage orchestration, quarantine decisions,
 * schema validation) lives in `lib/node/pi/deep-research-*.ts`
 * modules. This file is the thin pi-coupled wiring layer: build the
 * parent `AgentSession`, wire `runOneShotAgent` as both the
 * planning-critic runner and the fanout spawner (sync mode for
 * Phase 2 — background fanout lands in a follow-up once the
 * extension exposes the right subagent handle surface), forward
 * status notifications, and delegate command parsing to the pure
 * helpers in `lib/node/pi/research-runs.ts`.
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

import {
  runResearchPipeline,
  type PipelineDeps,
  type PipelineOutcome,
  type ResearchSessionLikeWithLifecycle,
} from '../../../lib/node/pi/deep-research-pipeline.ts';
import {
  type FanoutHandleLike,
  type FanoutHandleResult,
  type FanoutSpawner,
  type FanoutSpawnArgs,
} from '../../../lib/node/pi/research-fanout.ts';
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
  '  /research <question>   — run the planner → fanout pipeline (Phase 2)\n' +
  '  /research --list       — list runs under ./research/\n' +
  '  /research --selftest   — run the research-core self-test fixture';

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
  });

  pi.registerCommand('research', {
    description: 'Long-horizon web research (Phase 2: planner → fanout; /research <q> runs the pipeline).',
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

      const deps = buildPipelineDeps(pi, ctx, agentLoad);
      if (!deps.ok) {
        notify(`/research: ${deps.error}`, 'error');
        return;
      }

      notify(`/research: starting pipeline — planner → self-critic → planning-critic → fanout`, 'info');
      let outcome: PipelineOutcome;
      try {
        outcome = await runResearchPipeline(args, deps.deps);
      } catch (e) {
        notify(`/research: pipeline threw: ${(e as Error).message}`, 'error');
        return;
      }
      surfaceOutcome(outcome, notify);
    },
  });
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

function buildPipelineDeps(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  agentLoad: AgentLoadResult,
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

  const deps: PipelineDeps<unknown> = {
    cwd: ctx.cwd,
    model: modelLabel,
    thinkingLevel: thinkingLabel,
    fanoutMode: 'sync', // Phase 2: sync fanout via runOneShotAgent per task.
    ...(ctx.signal ? { signal: ctx.signal } : {}),
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
    fanoutSpawn: buildSyncFanoutSpawner(ctx, webAgent, modelRegistry, parentModel),
    onCriticCheckpoint: (outcome) => {
      ctx.ui.notify(
        `/research: planning-critic rejected the plan (${outcome.kind}). Plan is on disk — edit ./research/<slug>/plan.json and run \`/research --resume\` (Phase 3+). Pipeline halted before fanout.`,
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
 * This keeps Phase 2 honest about the pipeline shape (the same
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
    case 'fanout-complete': {
      const lines: string[] = [];
      lines.push(`/research: fanout complete under ${outcome.runRoot}`);
      lines.push(
        `  completed=${outcome.fanout.completed.length} failed=${outcome.fanout.failed.length} aborted=${outcome.fanout.aborted.length} quarantined=${outcome.quarantined.length}`,
      );
      lines.push(
        `  next step: Phase 3 synth lands ` +
          `./research/${outcome.plan.slug}/report.md once the synth stages ship. Inspect findings/*.md in the meantime.`,
      );
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
        `/research: planning-critic did not approve the plan (${outcome.outcome.kind}). Plan is at ${outcome.runRoot}/plan.json — edit and resume once Phase 3 is available.`,
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
