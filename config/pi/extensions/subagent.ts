/**
 * Subagent - Claude Code / opencode / codex-style task delegation for pi.
 *
 * The parent LLM calls a `subagent(agent, task)` tool; the extension
 * spawns an in-process child `AgentSession` with its own context
 * window, tool allowlist, and - optionally - a dedicated model or a
 * git-worktree sandbox. The parent only sees the final answer text;
 * all intermediate tool churn stays in the child's own session file.
 *
 * Key shape:
 *
 *   - Two tools: `subagent` spawns a child, `subagent_send` interacts
 *     with a background child (status/wait/abort/steer). Both run
 *     with `executionMode: "parallel"`; an in-process semaphore caps
 *     concurrent children at `PI_SUBAGENT_CONCURRENCY` (default 4,
 *     hard ceiling 8).
 *   - `subagent({ run_in_background: true })` returns a short handle
 *     (`sub_<agent>_<n>`) immediately. The child keeps running after
 *     the parent turn ends; the parent retrieves the final answer
 *     via `subagent_send({ to, action: "wait" })`.
 *   - Agent definitions are Markdown files under:
 *       1. `~/.dotfiles/config/pi/agents/`   (global)
 *       2. `<piAgentDir>/agents/`           (user, default `~/.pi/agent/agents/`)
 *       3. `<cwd>/.pi/agents/`               (project)
 *     Higher layers override by `name`.
 *   - Collapsible renderer shows a one-liner while running, the
 *     markdown final answer on expand. Child tool calls are NEVER
 *     streamed inline.
 *   - Child sessions persist to their own files under
 *     `<root>/<parent-cwd-slug>/<parent-session-id>/subagents/` so
 *     `session-usage.ts` picks them up next to the parent's session.
 *   - Parent-side audit via `pi.appendEntry('subagent-run', details)`
 *     so /fork, /tree, and session-usage can see delegated runs.
 *   - Statusline integration through `ctx.ui.setStatus('subagent', …)` -
 *     statusline.ts already renders extension statuses on line 3.
 *   - Companion `/agents` command shows active background children
 *     (`/agents`, alias `/agents running`), lists loaded agent
 *     definitions (`/agents list`), or shows one (`/agents show <name>`).
 *
 * Environment:
 *   PI_SUBAGENT_DISABLED=1              skip the extension entirely
 *   PI_SUBAGENT_DISABLE_PARENT_PROMPT=1 don't route child gate prompts to the parent UI (fall back to fail-closed)
 *   PI_SUBAGENT_DEBUG=1                 surface every child lifecycle event via ctx.ui.notify
 *   PI_SUBAGENT_CONCURRENCY=N           max concurrent children (default 4, floor 1, ceiling 8)
 *   PI_SUBAGENT_NO_PERSIST=1            use SessionManager.inMemory() instead of disk-backed sessions
 *   PI_SUBAGENT_SESSION_ROOT=<path>     override <piAgentDir>/sessions as the session root
 *   PI_SUBAGENT_RETAIN_DAYS=N           retain child session files for N days (default 30)
 *   PI_SUBAGENT_STATUS_LINGER_MS=N      keep completed status visible for N ms (default 5000)
 *   PI_SUBAGENT_MAX_TURNS=N             global max-turns cap (wins over per-agent setting)
 *   PI_SUBAGENT_TIMEOUT_MS=N            global wall-clock hard cap (wins over per-agent + per-call settings)
 *   PI_SUBAGENT_MAX_TIMEOUT_MS=N        ceiling on a per-call `timeoutMs` override (default 1 h)
 *   PI_SUBAGENT_MODEL=provider/id       global model override applied to every child
 *   PI_SUBAGENT_BG_MAX=N                max entries retained in the background registry (default 32)
 *   PI_SUBAGENT_BG_SHUTDOWN_MS=N        wall-clock cap on the shutdown abort-and-dispose loop (default 2000)
 *
 * Commands:
 *   /agents              list active background sub-agents + their snapshots (alias: /agents running)
 *   /agents list         list every loaded agent with its source layer
 *   /agents show <name>  print full frontmatter + body of agent <name>
 *   /agents reload       re-scan agent directories and report what loaded
 *
 * Pure helpers live under `../../../lib/node/pi/subagent/` so they
 * can be unit-tested under vitest without the pi runtime.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  getSessionSubagentAggregate,
  makeChildToolAggregate,
  recordToolCall,
  snapshotByTool,
  type ChildToolAggregate,
} from '../../../lib/node/pi/subagent/aggregate.ts';
import { showModal } from '../../../lib/node/pi/ext/show-modal.ts';
import {
  AgentsLoadedOverlay,
  AgentsRunningOverlay,
  RUNNING_TICK_MS,
  type RunningOverlayEntry,
} from '../../../lib/node/pi/ext/subagent-overlays.ts';
import {
  ActivityRing,
  activityPushModeFor,
  applyActivityLine,
  formatActivityLine,
  getSessionActivityRings,
  makeActivityState,
  type ActivityEvent,
} from '../../../lib/node/pi/subagent/activity.ts';
import {
  formatAgentListDescription,
  formatAgentListRowDescription,
  formatParallelSubagentStatus,
  formatRunningChildrenList,
  formatSpawnMessage,
  formatSubagentScorecard,
  formatSubagentStatus,
  formatUnknownAgentError,
  scorecardGlyph,
  subagentDetailsToSnapshot,
  type AgentPreviewSource,
  type RunningChildListItem,
  type ScorecardStopReason,
  type SubagentRunSnapshot,
} from '../../../lib/node/pi/subagent/format.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { makeHandleCounter, pruneBackgroundRegistry, resolveHandle } from '../../../lib/node/pi/subagent/handle.ts';
import { AGENTS_USAGE, agentsSubverbSpec, parseAgentsCommand } from '../../../lib/node/pi/subagent/usage.ts';
import { buildForkPrompt, RECURSIVE_TOOL_NAMES, resolveForkMode } from '../../../lib/node/pi/subagent/fork.ts';
import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import {
  type AgentDef,
  type AgentLoadResult,
  type AgentLoadWarning,
  defaultAgentLayers,
  loadAgents,
  makeNodeReadLayer,
  resolveAgentWithRescan,
  resolveKnownToolNames,
} from '../../../lib/node/pi/subagent/loader.ts';
import { formatRunResultText, formatStopSummary } from '../../../lib/node/pi/subagent/result.ts';
import {
  childSessionDir,
  subagentSessionRoot,
  sweepStaleSessions,
  sweepStaleSessionsFlat,
} from '../../../lib/node/pi/subagent/session-paths.ts';
import { makeSweepFs } from '../../../lib/node/pi/subagent/sweep-fs.ts';
import {
  createWorktree,
  formatWorktreeRecovery,
  removeWorktree,
  sweepStaleWorktrees,
  type CreatedWorktree,
  type WorktreeRemovalResult,
} from '../../../lib/node/pi/subagent/worktree.ts';
import { createChildRun, resolveChildModel } from '../../../lib/node/pi/subagent/spawn.ts';
import { resolveMaxTurns, resolveTimeoutMs } from '../../../lib/node/pi/subagent/budget.ts';
import { type SubagentConfig, loadSubagentConfig } from '../../../lib/node/pi/subagent/config.ts';
import { collectSubagentInjections } from '../../../lib/node/pi/subagent/extension-injection.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { resolveWriteRoots } from '../../../lib/node/pi/persona/resolve.ts';
import { Semaphore } from '../../../lib/node/pi/semaphore.ts';
import { setActiveAgent, clearActiveAgent } from '../../../lib/node/pi/subagent/active-agent.ts';
import {
  setParentPromptUI,
  registerChildPromptIdentity,
  unregisterChildPromptIdentity,
  clearChildPromptIdentities,
} from '../../../lib/node/pi/subagent/parent-prompt.ts';
import { createAgentGateFactory } from '../../../lib/node/pi/subagent/agent-gate.ts';

const SUBAGENT_CUSTOM_TYPE = 'subagent-run';
const STATUS_KEY = 'subagent';

// Concurrency default + clamp now live in DEFAULT_SUBAGENT_CONFIG /
// MIN_CONCURRENCY / MAX_CONCURRENCY (lib/node/pi/subagent/config.ts).
const DEFAULT_STATUS_LINGER_MS = 5000;
const DEFAULT_RETAIN_DAYS = 30;
const DEFAULT_BG_REGISTRY_CAP = 32;
const DEFAULT_BG_SHUTDOWN_MS = 2000;

// Static prose for the `subagent` tool description. The enumerated agent list is
// appended at registration time (it depends on which agents loaded), but keeping
// the prose as an inline const literal keeps it grep-able by audit walkers.
export const SUBAGENT_TOOL_DESCRIPTION = [
  'Delegate a subtask to a specialized sub-agent that runs with its own fresh context, tool allowlist, and (optionally) model.',
  "The parent sees only the child's final answer text - intermediate tool calls stay in the child's own session file.",
  'Parallel fan-out is supported: call this tool multiple times in one assistant turn and the invocations run concurrently.',
].join('\n');

export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  'Interact with a background sub-agent that was spawned by `subagent({ run_in_background: true })`.\n' +
  'Actions: `status` (current snapshot), `wait` (await final answer), `abort` (cancel a running child). Providing `text` without `action` steers the running child with a user message.\n' +
  'Background children keep running even after the parent turn that spawned them ends; use this tool to retrieve their final answer.';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

interface SubagentSendParamsT {
  to: string;
  action?: 'status' | 'wait' | 'abort';
  text?: string;
}

export type SubagentStopReason = 'completed' | 'max_turns' | 'aborted' | 'error' | 'running' | 'spawned';

export interface SubagentDetails {
  agent: string;
  agentSource?: 'global' | 'user' | 'project';
  task: string;
  model?: string;
  turns: number;
  tokens: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  };
  cost: number;
  durationMs: number;
  stopReason: SubagentStopReason;
  workspace?: {
    isolation: 'shared-cwd' | 'worktree';
    worktreePath?: string;
    worktreePreserved?: boolean;
    recoveryBranch?: string;
  };
  childSessionFile?: string;
  childSessionId?: string;
  handle?: string;
  error?: string;
  /** Cap on the child's turn count (for the `turn N/max` scorecard segment). */
  maxTurns?: number;
  /** Per-tool call counts populated from `tool_execution_start` events. */
  byTool?: Readonly<Record<string, number>>;
  /** Context-tokens snapshot at the time of the result (when available). */
  contextTokens?: number;
  /** Context window of the child's model. */
  contextWindow?: number;
  /** Effective wall-clock cap (ms) for this dispatch. */
  timeoutMs?: number;
  /** True when the wall-clock cap (not the parent) stopped the child. */
  timedOut?: boolean;
  /** Files the child tried to write via write / edit / apply_patch. */
  touchedFiles?: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Env helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Named-env wrapper around `parsePositiveInt` with an optional upper
 * clamp. Kept local because every subagent tunable is keyed off a
 * `PI_SUBAGENT_*` env var name and this shape reads better at call
 * sites than `parsePositiveInt(process.env.NAME, def)` repeated ~8x.
 */
function envPositiveInt(name: string, def: number, max?: number): number {
  const n = parsePositiveInt(process.env[name], def);
  return max !== undefined ? Math.min(n, max) : n;
}

// ──────────────────────────────────────────────────────────────────────
// Child session aggregator
// ──────────────────────────────────────────────────────────────────────

interface ChildAggregate {
  turns: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
  contextTokens: number;
  /** Per-tool call counts populated from `tool_execution_start` events. */
  tools: ChildToolAggregate;
}

function makeAggregate(): ChildAggregate {
  return {
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    contextTokens: 0,
    tools: makeChildToolAggregate(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Error-result helpers used by the delegation path
// ──────────────────────────────────────────────────────────────────────

function toolErrorResult(args: {
  agent: AgentDef;
  task: string;
  durationMs: number;
  error: string;
  stopReason?: 'error' | 'aborted';
}): {
  content: string;
  details: SubagentDetails;
  isError: true;
} {
  return {
    content: `subagent: ${args.error}`,
    details: {
      agent: args.agent.name,
      agentSource: args.agent.source,
      task: args.task,
      turns: 0,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      cost: 0,
      durationMs: args.durationMs,
      stopReason: args.stopReason ?? 'error',
      error: args.error,
    },
    isError: true,
  };
}

function cleanupAndError(args: {
  agent: AgentDef;
  task: string;
  durationMs: number;
  error: string;
  worktree: CreatedWorktree | undefined;
  parentCwd: string;
  stopReason?: 'error' | 'aborted';
}): { content: string; details: SubagentDetails; isError: true } {
  const cleanup = args.worktree ? removeWorktree(args.parentCwd, args.worktree) : undefined;
  const result = toolErrorResult(args);
  if (cleanup) {
    result.details.workspace = {
      isolation: 'worktree',
      worktreePath: cleanup.path,
      worktreePreserved: !cleanup.removed,
      recoveryBranch: cleanup.branchPreserved ? cleanup.branch : undefined,
    };
    const recovery = formatWorktreeRecovery(cleanup);
    if (recovery) result.content += `\n\n${recovery}`;
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Scorecard rendering (shared by `subagent` + `subagent_send`)
// ──────────────────────────────────────────────────────────────────────

/**
 * Theme-aware wrapper around `formatScorecardLead` +
 * `formatSubagentScorecard`. Returns a single multi-line string -
 * callers wrap it in a `Text` component.
 */
function renderScorecard(args: {
  theme: Theme;
  agent: string;
  agentSource?: 'global' | 'user' | 'project';
  handle?: string;
  stopReason: ScorecardStopReason;
  snapshot: SubagentRunSnapshot;
  leadSuffix?: string;
}): string {
  const { theme, agent, agentSource, handle, stopReason, snapshot, leadSuffix } = args;
  const glyphInfo = scorecardGlyph(stopReason);
  const glyph = theme.fg(glyphInfo.themeColor, glyphInfo.glyph);
  const source = agentSource ? theme.fg('muted', ` (${agentSource})`) : '';
  const handleSeg = handle ? `   ${theme.fg('accent', handle)}` : '';
  const suffix = leadSuffix ? `   ${theme.fg('muted', leadSuffix)}` : '';
  const lead = `${glyph} ${theme.fg('toolTitle', theme.bold(agent))}${source}${handleSeg}${suffix}`;
  const card = formatSubagentScorecard(snapshot).map((l) => theme.fg('muted', l));
  return [lead, ...card].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_SUBAGENT_DISABLED)) return;

  const debug = envTruthy(process.env.PI_SUBAGENT_DEBUG);

  // Directory containing this extension file - used to resolve the
  // shipped `config/pi/agents/` sibling directory without relying on
  // `DOTFILES_ROOT` or similar.
  const extDir = dirname(fileURLToPath(import.meta.url));

  let loadResult: AgentLoadResult = { agents: new Map(), nameOrder: [], warnings: [] };
  const warnings = createNotifyOnce<AgentLoadWarning>({
    tag: 'subagent',
    keyOf: (w) => `${w.path}:${w.reason}`,
    render: (w, tag) => `${tag}: ${w.path}: ${w.reason}`,
  });

  // Resolved config (built-in -> env knob -> user -> project). Seeded at
  // registration from `process.cwd()` (no ctx yet) and re-loaded on
  // session_start from `ctx.cwd` so a project-local
  // `<cwd>/.pi/subagent.json` applies. The per-dispatch `model` /
  // `maxTurns` reads use this object; the concurrency semaphore is
  // rebuilt at session_start (changing it mid-session needs /reload).
  let subagentConfig: SubagentConfig = loadSubagentConfig(process.cwd());

  // Session-wide concurrency semaphore. Each dispatch retains its own
  // semaphore reference so late completions cannot release a new session's
  // capacity. Changing concurrency mid-session requires /reload.
  let semaphore = new Semaphore(subagentConfig.concurrency);
  let sessionController = new AbortController();
  let sessionGeneration = 0;
  const pendingSpawns = new Set<Promise<unknown>>();

  // Running-child registry for the statusline aggregate rendering. Each
  // child owns an entry here from acquire-time until its per-call linger
  // timer fires. Parallel children collapse into the parallel-aggregate
  // status; solo children render the single-child format.
  const runningChildren = new Map<string, SubagentRunSnapshot>();
  // Per-child linger timers kept so session_shutdown can cancel them all.
  const lingerTimers = new Set<ReturnType<typeof setTimeout>>();

  // Background-children registry (v2). Every spawned child lands here
  // keyed by its short handle - both synchronous and background calls.
  // Sync callers keep the entry around for subsequent `subagent_send`
  // lookups; background callers outlive the spawning turn. Pruned on
  // session_shutdown and by `pruneBackgroundRegistry` past PI_SUBAGENT_BG_MAX.
  interface RunChildResult {
    content: string;
    details: SubagentDetails;
    isError: boolean;
  }

  interface RunningChild {
    handle: string;
    agent: AgentDef;
    task: string;
    childSessionId: string;
    childSessionFile: string | undefined;
    session: AgentSession;
    snapshot: SubagentRunSnapshot;
    worktree: CreatedWorktree | undefined;
    startedAt: number;
    /** Resolves once `drive()` settles (success or failure). */
    completion: Promise<RunChildResult>;
    /** Present once `drive()` settles; repeated status/wait calls read this. */
    outcome: RunChildResult | undefined;
    /** Whether the child is still executing. */
    running: boolean;
    /** True once the process-wide semaphore slot has been released. Idempotency guard. */
    semaphoreReleased: boolean;
    /** Shared lifecycle cancellation, including explicit abort and shutdown. */
    abort(): Promise<void>;
    /** Prevent late completions from mutating a replacement session. */
    generation: number;
    releaseCapacity(): void;
    /** Files the child has tried to write so far (live, for status polls). */
    touchedFiles(): string[];
  }

  const backgroundChildren = new Map<string, RunningChild>();
  const handleCounter = makeHandleCounter();

  /**
   * Build a `SubagentDetails` for an entry that is still running (no
   * `outcome` yet). Shared between the spawn-time return value and
   * `subagent_send` status responses so both surfaces report the same
   * shape for a running child.
   */
  const entryToRunningDetails = (entry: RunningChild): SubagentDetails => {
    const snap = entry.snapshot;
    return {
      agent: entry.agent.name,
      agentSource: entry.agent.source,
      task: entry.task,
      model: snap.model,
      turns: snap.turns,
      tokens: {
        input: snap.input,
        cacheRead: snap.cacheRead,
        cacheWrite: snap.cacheWrite ?? 0,
        output: snap.output,
      },
      cost: snap.cost,
      durationMs: Date.now() - entry.startedAt,
      stopReason: 'running',
      childSessionId: entry.childSessionId,
      childSessionFile: entry.childSessionFile,
      handle: entry.handle,
      maxTurns: snap.maxTurns,
      byTool: snap.byTool,
      contextTokens: snap.contextTokens,
      contextWindow: snap.contextWindow,
      touchedFiles: entry.touchedFiles(),
    };
  };

  const pruneBackground = (): void =>
    pruneBackgroundRegistry(backgroundChildren, envPositiveInt('PI_SUBAGENT_BG_MAX', DEFAULT_BG_REGISTRY_CAP));

  // Idempotent release of the child's concurrency slot. The
  // `semaphoreReleased` guard makes a second call a no-op, so both the
  // sync path's `finally` (which must release even if drive() rejects)
  // and `finalizeChildRun` can call it without double-releasing.
  const releaseSlot = (entry: RunningChild): void => {
    if (!entry.semaphoreReleased) {
      entry.releaseCapacity();
      entry.semaphoreReleased = true;
    }
  };

  // Shared settle step for a finished child run: release the concurrency
  // slot, then write the parent-side audit entry. appendEntry can throw
  // before the session is fully bound, so it is best-effort. Used by both
  // the background IIFE and the synchronous await path.
  const finalizeChildRun = (entry: RunningChild, result: RunChildResult): void => {
    releaseSlot(entry);
    if (entry.generation !== sessionGeneration) return;
    try {
      pi.appendEntry(SUBAGENT_CUSTOM_TYPE, result.details);
    } catch {
      // appendEntry can throw before the session is fully bound.
    }
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    const entries = [...runningChildren.values()];
    if (entries.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    if (entries.length === 1) {
      ctx.ui.setStatus(STATUS_KEY, formatSubagentStatus(entries[0]));
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, formatParallelSubagentStatus(entries));
  };

  const reload = (cwd: string): void => {
    // pi.getAllTools() throws during extension loading; the helper falls
    // back to a permissive filter so the factory-time load still yields
    // agent names + descriptions for the tool schema.
    const knownToolNames = resolveKnownToolNames(() => pi.getAllTools());
    const layers = defaultAgentLayers({ extensionDir: extDir, cwd });
    loadResult = loadAgents({
      layers,
      knownToolNames,
      fs: makeNodeReadLayer(),
      parseFrontmatter,
    });
  };

  const surfaceWarnings = (ctx: ExtensionContext, list: readonly AgentLoadWarning[]): void => {
    warnings.surface(ctx.ui.notify.bind(ctx.ui), list);
  };

  // ────────────────────────────────────────────────────────────────────
  // Lifecycle + startup sweeps
  // ────────────────────────────────────────────────────────────────────

  try {
    reload(process.cwd());
  } catch {
    // session_start will retry with the canonical cwd.
  }

  pi.on('session_start', (_event, ctx) => {
    sessionController = new AbortController();
    sessionGeneration++;
    reload(ctx.cwd);
    // Publish the parent's interactive UI so a spawned subagent's
    // security gates (bash-permissions / filesystem) can route their
    // approval prompt here instead of falling through to the
    // non-interactive default. Only when the parent actually has a UI
    // (skipped in headless `pi -p`, preserving PI_*_DEFAULT semantics)
    // and the feature isn't disabled.
    if (ctx.hasUI && !envTruthy(process.env.PI_SUBAGENT_DISABLE_PARENT_PROMPT)) {
      setParentPromptUI(ctx.ui);
    } else {
      setParentPromptUI(undefined);
    }
    // Re-resolve config from the real session cwd so a project-local
    // <cwd>/.pi/subagent.json takes effect. Reset capacity for the new
    // session; old dispatches retain their previous semaphore.
    subagentConfig = loadSubagentConfig(ctx.cwd);
    semaphore = new Semaphore(subagentConfig.concurrency);
    surfaceWarnings(ctx, loadResult.warnings);
    handleCounter.reset();
    backgroundChildren.clear();
    // Drop any subagent totals from a previous session so the
    // statusline Σ(N):… segment starts fresh for this parent session.
    getSessionSubagentAggregate().reset();
    // Sweep stale worktrees + old child session files from prior (possibly
    // crashed) runs. Both helpers are best-effort and silent on failure.
    const wtSwept = sweepStaleWorktrees(ctx.cwd);
    if (debug && wtSwept.swept > 0) ctx.ui.notify(`subagent: swept ${wtSwept.swept} stale worktree(s)`, 'info');
    const retain = envPositiveInt('PI_SUBAGENT_RETAIN_DAYS', DEFAULT_RETAIN_DAYS);
    const swept = sweepStaleSessions(subagentSessionRoot(), retain, makeSweepFs());
    // Also sweep the current workspace's own session dir directly: when
    // `--session-dir` relocated it out from under the shared root, the
    // global sweep above can't see it (base moved, layout stayed).
    const flatBase = ctx.sessionManager?.getSessionDir();
    const sweptFlat = flatBase ? sweepStaleSessionsFlat(flatBase, retain, makeSweepFs()) : null;
    const removed = swept.removed + (sweptFlat?.removed ?? 0);
    if (debug && removed > 0) ctx.ui.notify(`subagent: swept ${removed} stale session file(s)`, 'info');
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    sessionController.abort();
    // Drain running background children first. We fire `abort()` on
    // each and wait up to PI_SUBAGENT_BG_SHUTDOWN_MS total for their
    // drive() loops to settle - this gives them a chance to dispose
    // cleanly + cleanup owned worktrees. The deadline bounds the wait;
    // remaining event runners are detached and late writes are guarded.
    const drainDeadlineMs = envPositiveInt('PI_SUBAGENT_BG_SHUTDOWN_MS', DEFAULT_BG_SHUTDOWN_MS);
    const pending: Promise<unknown>[] = [...pendingSpawns];
    for (const entry of backgroundChildren.values()) {
      if (!entry.running) continue;
      void entry.abort().catch(() => undefined);
      pending.push(entry.completion);
    }
    if (pending.length > 0) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, drainDeadlineMs);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    }
    // Children that ignore cancellation must not retain a live event runner.
    // Their eventual completion is generation-guarded below.
    for (const entry of backgroundChildren.values()) {
      if (!entry.running) continue;
      try {
        entry.session.dispose();
      } catch {
        // best-effort
      }
      releaseSlot(entry);
    }
    sessionGeneration++;

    // Happy-path sweep. Both sweeps are best-effort - shutdown must
    // not block or throw.
    try {
      sweepStaleWorktrees(ctx.cwd);
    } catch {
      // never block shutdown
    }
    try {
      const retain = envPositiveInt('PI_SUBAGENT_RETAIN_DAYS', DEFAULT_RETAIN_DAYS);
      sweepStaleSessions(subagentSessionRoot(), retain, makeSweepFs());
      const flatBase = ctx.sessionManager?.getSessionDir();
      if (flatBase) sweepStaleSessionsFlat(flatBase, retain, makeSweepFs());
    } catch {
      // never block shutdown
    }
    loadResult = { agents: new Map(), nameOrder: [], warnings: [] };
    warnings.reset();
    runningChildren.clear();
    setParentPromptUI(undefined);
    clearChildPromptIdentities();
    for (const t of lingerTimers) clearTimeout(t);
    lingerTimers.clear();
    backgroundChildren.clear();
    handleCounter.reset();
    getSessionActivityRings().clear();
    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch {
        // The UI may already be detached.
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Tool schema + description
  // ────────────────────────────────────────────────────────────────────

  const toolDescription = (): string => {
    const items = loadResult.nameOrder.map((n) => {
      const a = loadResult.agents.get(n);
      return { name: n, description: a?.description ?? '', source: a?.source };
    });
    return [SUBAGENT_TOOL_DESCRIPTION, '', formatAgentListDescription(items)].join('\n');
  };

  const SubagentParams = Type.Object({
    agent: Type.String({
      description:
        'Sub-agent type name (see the tool description for the enumerated list). Must match one of the loaded agent definitions.',
    }),
    task: Type.String({
      description:
        'What the sub-agent should do. Be specific - by default the sub-agent starts with NO context from this ' +
        'conversation (unless `fork: true`). Include paths, constraints, and the expected answer shape. One task per call.',
    }),
    modelOverride: Type.Optional(
      Type.String({
        description:
          "Override the agent's model with `provider/modelId` (e.g. run an explore subagent on a cheaper local model).",
      }),
    ),
    returnFormat: Type.Optional(
      Type.Union([Type.Literal('text'), Type.Literal('json')], {
        description:
          "Parse the child's final answer as JSON before returning. Falls back to raw text when the answer isn't valid JSON.",
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          'Launch the sub-agent in the background and return a handle immediately. ' +
          'Use `subagent_send` to poll, steer, or await completion. ' +
          'Defaults to false (synchronous - the parent turn blocks until the child finishes).',
      }),
    ),
    fork: Type.Optional(
      Type.Boolean({
        description:
          "Fork this conversation's full history into the sub-agent instead of starting blank. Use when the task " +
          "depends on context here that is tedious to restate. Runs on the parent model and ignores the agent's " +
          'curated tool list (for prompt-cache reuse).',
      }),
    ),
    maxTurns: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1000,
        description:
          "Optional `maxTurns` cap (default: the agent's `.md`, 20 when unset). Raise for large multi-file work. Bounded by `PI_SUBAGENT_MAX_TURNS`.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1000,
        description:
          "Optional wall-clock cap in ms for this call (default: the agent's `.md` `timeoutMs`, 180000 when unset). " +
          'Raise for long implementation work (e.g. 1200000 = 20 min). Clamped to the `maxTimeoutMs` ceiling ' +
          '(default 3600000 = 1 h) and bounded by `PI_SUBAGENT_TIMEOUT_MS`.',
      }),
    ),
  });

  const SubagentSendParams = Type.Object({
    to: Type.String({
      description: 'Handle returned by a prior `subagent` call with `run_in_background: true`.',
    }),
    action: Type.Optional(
      Type.Union([Type.Literal('status'), Type.Literal('wait'), Type.Literal('abort')], {
        description:
          'What to do with the subagent. `status` (default when `text` is omitted) returns the latest snapshot. `wait` blocks until the child completes. `abort` cancels a running child. Providing `text` without `action` steers it.',
      }),
    ),
    text: Type.Optional(
      Type.String({
        description:
          'Steer a running subagent by injecting this text as a user message. Only valid while the child is still running. Not combinable with `action: "abort"`.',
      }),
    ),
  });

  // ────────────────────────────────────────────────────────────────────
  // Delegation - `spawnChild` does the up-front setup, returns an
  // entry + a `drive()` that awaits the prompt and settles the entry.
  //
  // Synchronous callers: await `drive()` inline.
  // Background callers: fire-and-forget `drive()`, keep the handle.
  // ────────────────────────────────────────────────────────────────────

  type SpawnResult =
    | { kind: 'ok'; entry: RunningChild; drive: () => Promise<RunChildResult> }
    | { kind: 'error'; result: RunChildResult };

  async function spawnChild(args: {
    agent: AgentDef;
    task: string;
    modelOverride: string | undefined;
    maxTurnsOverride: number | undefined;
    timeoutOverride: number | undefined;
    returnFormat: 'text' | 'json' | undefined;
    ctx: ExtensionContext;
    parentSignal: AbortSignal | undefined;
    setupSignal: AbortSignal;
    generation: number;
    releaseCapacity: () => void;
    /** When true, fork the parent's conversation history into the child. */
    fork: boolean;
  }): Promise<SpawnResult> {
    const {
      agent,
      task,
      modelOverride,
      maxTurnsOverride,
      timeoutOverride,
      returnFormat,
      ctx,
      parentSignal,
      setupSignal,
      generation,
      releaseCapacity,
      fork,
    } = args;
    const start = Date.now();
    const agg = makeAggregate();
    setupSignal.throwIfAborted();
    const parentCwd = ctx.cwd;

    // ── Model resolution ──────────────────────────────────────────────
    // Shared with deep-research's child spawns via
    // lib/node/pi/subagent/spawn.ts::resolveChildModel. Both extensions
    // surface the same diagnostic strings so users see consistent
    // messages; keeping the resolver in one place prevents drift.
    // Per-call override wins, then the config layer
    // (project > user > PI_SUBAGENT_MODEL env), then inherit.
    //
    // Fork mode keeps the parent model and inherited conversation.
    // Cache reuse additionally requires matching prompts and tools and is
    // not guaranteed by inheriting history. Report ignored overrides.
    if (fork && (modelOverride || subagentConfig.model || agent.model !== 'inherit')) {
      ctx.ui.notify('subagent: fork mode uses the parent model; ignoring the configured model override', 'info');
    }
    const modelSpecStr = fork ? undefined : (modelOverride ?? subagentConfig.model);
    const modelResolution = resolveChildModel({
      override: modelSpecStr,
      agent: fork ? { ...agent, model: 'inherit' } : agent,
      parent: ctx.model,
      modelRegistry: ctx.modelRegistry,
    });
    if (!modelResolution.ok) {
      return {
        kind: 'error',
        result: toolErrorResult({
          agent,
          task,
          durationMs: Date.now() - start,
          error: modelResolution.error,
        }),
      };
    }
    const childModel = modelResolution.model;

    // ── Workspace (shared-cwd vs worktree) ────────────────────────────
    let childCwd = parentCwd;
    let worktree: CreatedWorktree | undefined;
    let workspaceIsolation: 'shared-cwd' | 'worktree' = 'shared-cwd';
    if (agent.isolation === 'worktree') {
      const wt = createWorktree(parentCwd);
      if ('error' in wt) {
        ctx.ui.notify(`subagent: worktree create failed, falling back to shared-cwd: ${wt.error}`, 'warning');
      } else {
        childCwd = wt.path;
        worktree = wt;
        workspaceIsolation = 'worktree';
      }
    }

    // ── Session + ResourceLoader + child creation ─────────────────────
    //
    // All three can throw. Wrap them in one try/catch so the worktree
    // gets cleaned up on any failure - the prior split let a
    // `resourceLoader.reload()` throw bypass the cleanup path.
    const noPersist = envTruthy(process.env.PI_SUBAGENT_NO_PERSIST);
    const sessionDir = childSessionDir({
      parentSessionDir: ctx.sessionManager.getSessionDir(),
      parentCwd,
      parentSessionId: ctx.sessionManager.getSessionId(),
    });
    // SessionManager.create will mkdir the sessionDir lazily on first write.
    //
    // Fork mode copies the parent's transcript into the child session
    // file (forkFrom seeds agent.state.messages via createAgentSession),
    // so the child boots with the parent's full history. resolveForkMode
    // already guaranteed a persisted parent session file exists before
    // setting fork=true, so getSessionFile() is non-null here.
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    let childSessionManager: SessionManager;
    let child: AgentSession | undefined;
    // Resolve the agent's writeRoots (frontmatter strings) into absolute
    // paths against the child cwd so the inline agent-gate factory has
    // a stable form to compare against.
    const resolvedAgentWriteRoots = resolveWriteRoots(agent.writeRoots, {
      cwd: childCwd,
      homedir: homedir(),
      projectSlug: basename(childCwd),
    });
    const enforceAgentWriteRoots = resolvedAgentWriteRoots.length > 0;
    // Inline ExtensionFactory installed in the child session that
    // enforces the agent's bashAllow/bashDeny/writeRoots and merges
    // requestOptions into the outgoing provider payload. This is the
    // canonical enforcement path - the parent's bash-permissions /
    // filesystem extensions don't see the child's tool calls when
    // `noExtensions: true` is set on the resourceLoader. Inline
    // extensionFactories load even with that flag.
    const agentGateFactory = createAgentGateFactory({
      config: {
        name: agent.name,
        bashAllow: agent.bashAllow,
        bashDeny: agent.bashDeny,
        resolvedWriteRoots: resolvedAgentWriteRoots,
        requestOptions: agent.requestOptions,
      },
      enforceWriteRoots: enforceAgentWriteRoots,
      resolveAbsolute: resolve,
    });
    // Pi's `ExtensionFactory` is `(pi: ExtensionAPI) => void | Promise<void>`;
    // the helper's loose typing keeps it pure-testable. The cast here is
    // the runtime adapter.
    setActiveAgent({
      name: agent.name,
      resolvedWriteRoots: resolvedAgentWriteRoots,
      bashAllow: agent.bashAllow,
      bashDeny: agent.bashDeny,
      requestOptions: agent.requestOptions,
    });
    try {
      childSessionManager =
        fork && parentSessionFile
          ? SessionManager.forkFrom(parentSessionFile, childCwd, sessionDir)
          : noPersist
            ? SessionManager.inMemory(childCwd)
            : SessionManager.create(childCwd, sessionDir);
      const agentDir = getAgentDir();
      // Fork mode injects the persona in the task message instead of
      // rebuilding the inherited conversation. The child's default system
      // prompt may differ from the parent's full extension stack.
      const appendParts: string[] = [];
      if (!fork) {
        if (agent.appendSystemPrompt) appendParts.push(agent.appendSystemPrompt);
        if (agent.body.trim().length > 0) appendParts.push(agent.body.trim());
      }
      const resourceLoader = new DefaultResourceLoader({
        cwd: childCwd,
        agentDir,
        settingsManager: undefined,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        appendSystemPrompt: appendParts.length > 0 ? appendParts : undefined,
        extensionFactories: [
          // Restrict before parent approval prompts or sandbox rewriting.
          // All gates must allow a call; one gate cannot override a deny.
          agentGateFactory,
          ...(collectSubagentInjections() as unknown as ExtensionFactory[]),
        ] satisfies ExtensionFactory[],
      });
      await resourceLoader.reload();
      setupSignal.throwIfAborted();
      const created = await createAgentSession({
        cwd: childCwd,
        model: childModel,
        // A thinking-level suffix on the model override (e.g. `:off`) wins
        // over the agent def's own thinkingLevel for this child.
        thinkingLevel: modelResolution.thinkingLevel ?? agent.thinkingLevel,
        // Fork mode leaves the tool allowlist unset so the child enables
        // pi's default tool set, not arbitrary parent extension tools.
        // Fresh mode keeps the agent's curated allowlist. Either way the
        // recursive subagent tools are excluded so a child can never fan
        // out further (the runtime depth guard backs this up).
        tools: fork ? undefined : agent.tools,
        excludeTools: [...RECURSIVE_TOOL_NAMES],
        // pi >= 0.80 builds the child's ModelRuntime from agentDir; it no
        // longer accepts a modelRegistry / authStorage. Auth resolves from
        // the same agent dir the resourceLoader above already uses.
        agentDir,
        resourceLoader,
        sessionManager: childSessionManager,
      });
      child = created.session;
      setupSignal.throwIfAborted();
      if (!fork) {
        const available = new Set(child.getAllTools().map((tool) => tool.name));
        const unavailable = agent.tools.filter((name) => !available.has(name));
        if (unavailable.length > 0) {
          throw new Error(
            `agent "${agent.name}" requests unavailable child tools: ${unavailable.join(', ')}. ` +
              'Children load built-in tools and explicit child factories, not parent extension tool handlers. ' +
              'Remove these tools from the agent definition or provide a child-safe factory.',
          );
        }
      }
    } catch (e) {
      try {
        child?.dispose();
      } catch {
        // Keep the setup error, but still clean the owned workspace.
      }
      if (generation === sessionGeneration) clearActiveAgent();
      return {
        kind: 'error',
        result: cleanupAndError({
          agent,
          task,
          durationMs: Date.now() - start,
          error: e instanceof Error ? e.message : String(e),
          worktree,
          parentCwd,
          stopReason: setupSignal.aborted ? 'aborted' : 'error',
        }),
      };
    }

    const childSessionId = childSessionManager.getSessionId();
    const childSessionFile = childSessionManager.getSessionFile();
    const handle = handleCounter.next(agent.name);

    // ── Subscribe to child events ─────────────────────────────────────
    const maxTurns = resolveMaxTurns({
      override: maxTurnsOverride,
      agentDefault: agent.maxTurns,
      // Config layer (project > user > PI_SUBAGENT_MAX_TURNS env) supplies
      // the global ceiling; absent = no cap.
      envCap: subagentConfig.maxTurns ?? Number.MAX_SAFE_INTEGER,
    });
    const makeSnapshot = (
      state: SubagentRunSnapshot['state'],
      opts?: { durationMs?: number },
    ): SubagentRunSnapshot => ({
      agent: agent.name,
      agentSource: agent.source,
      state,
      model: childModel?.id,
      turns: agg.turns,
      input: agg.input,
      cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite,
      output: agg.output,
      cost: agg.cost,
      contextTokens: agg.contextTokens > 0 ? agg.contextTokens : undefined,
      contextWindow: childModel?.contextWindow,
      durationMs: opts?.durationMs,
      task,
      handle,
      maxTurns,
      byTool: snapshotByTool(agg.tools),
    });

    const initialSnap = makeSnapshot('running');

    // The `completion` placeholder is always overwritten by the caller
    // (execute() sets it to `drive()` in the sync path or to the IIFE
    // wrapper in the background path) BEFORE the entry is added to
    // `backgroundChildren`, so `subagent_send` never observes this
    // initial value. It exists only to satisfy the object-literal
    // type contract.
    let run: ReturnType<typeof createChildRun>;
    const entry: RunningChild = {
      handle,
      agent,
      task,
      childSessionId,
      childSessionFile,
      session: child,
      snapshot: initialSnap,
      worktree,
      startedAt: start,
      completion: Promise.resolve({ content: '', details: {} as SubagentDetails, isError: false }),
      outcome: undefined,
      running: true,
      semaphoreReleased: false,
      abort: () => run.abort(),
      generation,
      releaseCapacity,
      touchedFiles: () => run.touchedFiles(),
    };

    const pushStatus = (state: SubagentRunSnapshot['state'], opts?: { durationMs?: number }): void => {
      if (generation !== sessionGeneration) return;
      const snap = makeSnapshot(state, opts);
      entry.snapshot = snap;
      runningChildren.set(childSessionId, snap);
      updateStatus(ctx);
    };

    pushStatus('running');

    // Register this child so its (UI-less) gate calls can be routed to
    // the parent UI, labelled with the agent + handle. Unregistered in
    // drive()'s finally once the child's prompt settles.
    registerChildPromptIdentity(childSessionId, {
      agent: agent.name,
      handle,
      source: agent.source,
    });

    // Per-handle activity ring + cursor state. The overlay reads the
    // ring via `getSessionActivityRings()` so it survives jiti
    // re-evaluation of this extension module. State + ring are dropped
    // in `drive()`'s finally so the registry doesn't accumulate handles
    // across long-running sessions.
    const activityRing = new ActivityRing({ capacity: 64 });
    const activityState = makeActivityState();
    getSessionActivityRings().set(handle, activityRing);

    // Per-call `timeoutMs` (clamped to the config `maxTimeoutMs` ceiling)
    // > agent frontmatter; PI_SUBAGENT_TIMEOUT_MS stays the global hard cap.
    const { timeoutMs, clampedToCeiling } = resolveTimeoutMs({
      override: timeoutOverride,
      agentDefault: agent.timeoutMs,
      maxTimeoutMs: subagentConfig.maxTimeoutMs,
      hardCap: envPositiveInt('PI_SUBAGENT_TIMEOUT_MS', Number.MAX_SAFE_INTEGER),
    });
    if (clampedToCeiling) {
      ctx.ui.notify(
        `subagent: timeoutMs ${timeoutOverride} exceeds the ${subagentConfig.maxTimeoutMs}ms ceiling (maxTimeoutMs); clamped`,
        'warning',
      );
    }
    run = createChildRun({
      session: child,
      maxTurns,
      timeoutMs,
      signal: parentSignal,
      onEvent: ({ event: rawEvent, turn }) => {
        const event = rawEvent as AgentSessionEvent;
        agg.turns = turn;
        if (generation !== sessionGeneration) return;
        if (debug) ctx.ui.notify(`subagent[${agent.name}]: ${event.type}`, 'info');

        // Activity-tail rendering. Pure formatter; safe to call before
        // / after the counter updates below. Routing through
        // `activityPushModeFor` collapses streaming assistant deltas to a
        // single cursor line in the ring rather than one row per token.
        const activityEvent = event as unknown as ActivityEvent;
        const line = formatActivityLine(activityEvent, activityState);
        if (line) applyActivityLine(activityRing, line, activityPushModeFor(activityEvent));

        if (event.type === 'tool_execution_start') {
          recordToolCall(agg.tools, event.toolName ?? '');
          pushStatus('running');
        }
        if (event.type === 'turn_end') {
          pushStatus('running');
        } else if (event.type === 'message_end' && event.message.role === 'assistant') {
          const usage = (
            event.message as {
              usage?: {
                input?: number;
                cacheRead?: number;
                cacheWrite?: number;
                output?: number;
                totalTokens?: number;
                cost?: { total?: number };
              };
            }
          ).usage;
          if (usage) {
            agg.input += usage.input ?? 0;
            agg.cacheRead += usage.cacheRead ?? 0;
            agg.cacheWrite += usage.cacheWrite ?? 0;
            agg.output += usage.output ?? 0;
            agg.cost += usage.cost?.total ?? 0;
            agg.contextTokens = usage.totalTokens ?? agg.contextTokens;
          }
          pushStatus('running');
        }
      },
    });

    const childPrompt = fork ? buildForkPrompt({ agent, task }) : task;
    const drive = async (): Promise<RunChildResult> => {
      let outcome: Awaited<ReturnType<typeof run.run>>;
      let cleanup: WorktreeRemovalResult | undefined;
      try {
        outcome = await run.run(childPrompt);
      } finally {
        unregisterChildPromptIdentity(childSessionId);
        if (generation === sessionGeneration) clearActiveAgent();
        if (worktree) cleanup = removeWorktree(parentCwd, worktree);
      }
      const stopReason = outcome.stopReason;
      const durationMs = Date.now() - start;
      // Non-completed stops lead with an explicit headline (timeout /
      // turn cap / abort / error) plus the files the child tried to
      // write; the child's last assistant text trails as "Last message".
      const finalText = formatRunResultText({
        agent: agent.name,
        stopReason,
        timedOut: outcome.timedOut,
        timeoutMs,
        durationMs,
        turns: outcome.turns,
        maxTurns,
        touchedFiles: outcome.touchedFiles,
        errorMessage: outcome.errorMessage,
        finalText: outcome.finalText,
      });

      // ── Final status with duration atomically, then schedule linger clear ─
      const finalState: SubagentRunSnapshot['state'] =
        stopReason === 'completed'
          ? 'completed'
          : stopReason === 'max_turns'
            ? 'max_turns'
            : stopReason === 'aborted'
              ? 'aborted'
              : 'error';
      pushStatus(finalState, { durationMs });
      // Contribute this run's totals to the session-wide subagent
      // aggregate so the statusline's line-2 Σ(N):… segment reflects
      // the cumulative cost of delegated work. We intentionally count
      // errored / aborted / max_turns runs too (with `failed: true`)
      // - tokens + cost were still spent and users want to see them.
      if (generation === sessionGeneration)
        getSessionSubagentAggregate().record({
          turns: agg.turns,
          input: agg.input,
          cacheRead: agg.cacheRead,
          cacheWrite: agg.cacheWrite,
          output: agg.output,
          cost: agg.cost,
          durationMs,
          failed: finalState !== 'completed',
        });
      // After a linger so the user sees the final numbers, drop this
      // child from the aggregate. Each child owns its own timer so
      // concurrent children don't stomp each other.
      const linger = envPositiveInt('PI_SUBAGENT_STATUS_LINGER_MS', DEFAULT_STATUS_LINGER_MS);
      if (generation === sessionGeneration) {
        const timer = setTimeout(() => {
          lingerTimers.delete(timer);
          runningChildren.delete(childSessionId);
          updateStatus(ctx);
        }, linger);
        lingerTimers.add(timer);
      }

      const details: SubagentDetails = {
        agent: agent.name,
        agentSource: agent.source,
        task,
        model: childModel.id,
        turns: agg.turns,
        tokens: {
          input: agg.input,
          cacheRead: agg.cacheRead,
          cacheWrite: agg.cacheWrite,
          output: agg.output,
        },
        cost: agg.cost,
        durationMs,
        stopReason,
        workspace: {
          isolation: workspaceIsolation,
          worktreePath: worktree?.path,
          worktreePreserved: cleanup ? !cleanup.removed : undefined,
          recoveryBranch: cleanup?.branchPreserved ? cleanup.branch : undefined,
        },
        childSessionId,
        childSessionFile,
        handle,
        error: outcome.errorMessage,
        maxTurns,
        byTool: snapshotByTool(agg.tools),
        contextTokens: agg.contextTokens > 0 ? agg.contextTokens : undefined,
        contextWindow: childModel?.contextWindow,
        timeoutMs,
        timedOut: outcome.timedOut || undefined,
        touchedFiles: outcome.touchedFiles.length > 0 ? outcome.touchedFiles : undefined,
      };

      const result: RunChildResult = {
        content: [finalText, cleanup && returnFormat !== 'json' ? formatWorktreeRecovery(cleanup) : undefined]
          .filter(Boolean)
          .join('\n\n'),
        details,
        isError: stopReason !== 'completed',
      };

      entry.running = false;
      entry.outcome = result;
      // Keep the per-handle activity ring around so terminal entries
      // still tail past activity in `/agents running`. The ring is
      // dropped on session_shutdown along with the rest of the
      // per-handle state.
      return result;
    };

    return { kind: 'ok', entry, drive };
  }

  // ────────────────────────────────────────────────────────────────────
  // Tool registration
  // ────────────────────────────────────────────────────────────────────

  // The description (agent list included) is built ONCE, here, from the
  // factory-time scan and never re-registered: changing a tool schema
  // mid-session would invalidate the prompt cache. Agents added later are
  // still callable via the lazy re-scan in execute(); `/reload` re-runs
  // this factory and is the only path that refreshes the description.
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: toolDescription(),
    promptSnippet:
      'Delegate a subtask to a fresh sub-agent session so intermediate exploration stays out of your context.',
    promptGuidelines: [
      'Use `subagent` when the next step would read many files, run a broad `grep`, or otherwise produce intermediate noise you will not use yourself. Prefer the `explore` agent for read-only discovery and the `plan` agent for implementation planning.',
      'To fan out work, call `subagent` multiple times in one turn. Runs execute concurrently; the tool aggregates per-call results.',
      'Do NOT call `subagent` from inside a sub-agent. Nesting is disabled by design.',
    ],
    parameters: SubagentParams,
    executionMode: 'parallel',

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams;
      // Unknown name: re-scan the agent directories once so a `.md` added
      // mid-session works without `/reload`. The tool description keeps
      // its startup snapshot (rebuilding it mid-session would bust the
      // prompt cache); the lookup itself is always live.
      const { agent } = resolveAgentWithRescan(
        params.agent,
        () => loadResult,
        () => {
          reload(ctx.cwd);
          surfaceWarnings(ctx, loadResult.warnings);
        },
      );
      if (!agent) {
        return {
          content: [
            {
              type: 'text',
              text: formatUnknownAgentError(params.agent, loadResult.nameOrder),
            },
          ],
          details: {
            agent: params.agent,
            task: params.task,
            turns: 0,
            tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
            cost: 0,
            durationMs: 0,
            stopReason: 'error',
            error: `unknown agent "${params.agent}"`,
          } satisfies SubagentDetails,
          isError: true,
        };
      }

      const background = params.run_in_background === true;

      // Fork mode: per-call `fork` overrides the agent's `context` field.
      // Downgrades to fresh (with a notify) when the parent session has
      // no on-disk file to fork from.
      const forkDecision = resolveForkMode({
        perCall: params.fork,
        agentDefault: agent.context,
        parentSessionFile: ctx.sessionManager.getSessionFile(),
      });
      if (forkDecision.reason) ctx.ui.notify(`subagent: ${forkDecision.reason}`, 'info');

      const generation = sessionGeneration;
      const runSemaphore = semaphore;
      const sessionSignal = sessionController.signal;
      const setupSignal = signal ? AbortSignal.any([signal, sessionSignal]) : sessionSignal;
      let acquired = false;
      try {
        await runSemaphore.acquire(setupSignal);
        acquired = true;
        setupSignal.throwIfAborted();
      } catch {
        if (acquired) runSemaphore.release();
        const result = toolErrorResult({
          agent,
          task: params.task,
          durationMs: 0,
          error: 'aborted before child started',
          stopReason: 'aborted',
        });
        return { content: [{ type: 'text', text: result.content }], details: result.details, isError: true };
      }

      let spawn: SpawnResult;
      try {
        const setup = spawnChild({
          agent,
          task: params.task,
          modelOverride: params.modelOverride,
          maxTurnsOverride: params.maxTurns,
          timeoutOverride: params.timeoutMs,
          returnFormat: params.returnFormat,
          ctx,
          // Background work detaches from the spawning turn, not from
          // the parent session's shutdown signal. Setup is cancellable
          // in either mode until the child has actually been launched.
          parentSignal: background ? sessionSignal : setupSignal,
          setupSignal,
          generation,
          releaseCapacity: () => runSemaphore.release(),
          fork: forkDecision.fork,
        });
        pendingSpawns.add(setup);
        try {
          spawn = await setup;
        } finally {
          pendingSpawns.delete(setup);
        }
      } catch (e) {
        runSemaphore.release();
        const err = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: `subagent: spawn failed - ${err}` }],
          details: {
            agent: agent.name,
            agentSource: agent.source,
            task: params.task,
            turns: 0,
            tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
            cost: 0,
            durationMs: 0,
            stopReason: setupSignal.aborted ? 'aborted' : 'error',
            error: err,
          } satisfies SubagentDetails,
          isError: true,
        };
      }

      if (spawn.kind === 'error') {
        runSemaphore.release();
        return {
          content: [{ type: 'text', text: spawn.result.content }],
          details: spawn.result.details,
          isError: true,
        };
      }

      const { entry, drive } = spawn;

      const spawnedDetails: SubagentDetails = {
        ...entryToRunningDetails(entry),
        stopReason: 'spawned',
      };
      // Both modes use the same completion, failure handling, slot release,
      // and audit path. Background mode changes only who awaits it.
      entry.completion = (async () => {
        let result: RunChildResult;
        try {
          result = await drive();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result = {
            content: `subagent ${agent.name}: drive failed - ${msg}`,
            details: { ...entryToRunningDetails(entry), stopReason: 'error', error: msg },
            isError: true,
          };
        }
        entry.running = false;
        entry.outcome = result;
        finalizeChildRun(entry, result);
        return result;
      })();
      // Wire completion before publishing the handle, so wait never sees
      // the initial placeholder promise.
      backgroundChildren.set(entry.handle, entry);
      pruneBackground();

      if (background) {
        return {
          content: [
            {
              type: 'text',
              text: formatSpawnMessage({ handle: entry.handle, agent: agent.name, task: params.task }),
            },
          ],
          details: spawnedDetails,
          isError: false,
        };
      }
      const out = await entry.completion;
      pruneBackground();

      // `returnFormat: 'json'` asks us to validate that the child
      // produced parseable JSON. On failure we flag isError so the
      // parent LLM can retry the call - the raw text still reaches
      // the parent via `content`, and details.stopReason preserves the
      // original outcome.
      let isError = out.isError;
      if (params.returnFormat === 'json' && !isError) {
        try {
          JSON.parse(out.content);
        } catch {
          isError = true;
        }
      }

      return {
        content: [{ type: 'text', text: out.content }],
        details: out.details,
        isError,
      };
    },

    renderCall(args, theme, _context) {
      const a = args;
      const name = a.agent || '(no agent)';
      const preview = a.task ? (a.task.length > 80 ? `${a.task.slice(0, 80)}…` : a.task) : '';
      let text = `${theme.fg('toolTitle', theme.bold('subagent '))}${theme.fg('accent', name)}`;
      if (preview) text += `\n  ${theme.fg('dim', preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<SubagentDetails>;
      const stopReason: ScorecardStopReason = details.stopReason ?? 'spawned';
      const lead = renderScorecard({
        theme,
        agent: details.agent ?? '(agent)',
        agentSource: details.agentSource,
        handle: details.handle,
        stopReason,
        snapshot: subagentDetailsToSnapshot(details, stopReason),
        // For successful background spawns we want a "spawned in background"
        // suffix so the card visually mirrors the toast text.
        leadSuffix: stopReason === 'spawned' ? 'spawned in background' : details.timedOut ? 'timed out' : undefined,
      });
      const first = result.content.find((c) => c.type === 'text');
      const body = first?.type === 'text' ? first.text : '';
      // Background spawns embed handle + task + hint into `content`; that
      // duplicates the scorecard lead, so we lean on the scorecard for
      // the visible card and only show the body when there is something
      // distinct to read (sync completion or wait response).
      if (stopReason === 'spawned') {
        const taskLine = details.task
          ? theme.fg('dim', `   task: ${details.task.length > 80 ? `${details.task.slice(0, 79)}…` : details.task}`)
          : '';
        const hint = theme.fg('muted', '   Use `subagent_send` to check status, steer, or retrieve the result.');
        return new Text([lead, taskLine, hint].filter(Boolean).join('\n'), 0, 0);
      }
      if (expanded && body.trim()) {
        return new Text(`${lead}\n${theme.fg('text', body)}`, 0, 0);
      }
      const preview = body.length > 240 ? `${body.slice(0, 240)}…` : body;
      return new Text(`${lead}\n${theme.fg('dim', preview)}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // subagent_send - resume/steer/abort/poll background children (v2)
  // ────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'subagent_send',
    label: 'Subagent send',
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    promptSnippet:
      'Poll, steer, or await a background sub-agent previously spawned with `subagent({ run_in_background: true })`.',
    promptGuidelines: ['Only the parent session can call `subagent_send` - it is not exposed to sub-agents.'],
    parameters: SubagentSendParams,
    executionMode: 'parallel',

    async execute(_toolCallId, rawParams, signal, _onUpdate, _ctx) {
      const params = rawParams;
      const rawTo = (params.to ?? '').trim();
      if (rawTo.length === 0) {
        return {
          content: [{ type: 'text', text: 'subagent_send: missing `to` handle' }],
          details: undefined,
          isError: true,
        };
      }
      const entry = resolveHandle(rawTo, backgroundChildren);
      if (!entry) {
        const active = [...backgroundChildren.keys()].join(', ') || '(none)';
        return {
          content: [
            {
              type: 'text',
              text: `subagent_send: no subagent with handle "${rawTo}". Known handles: ${active}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      const hasText = typeof params.text === 'string' && params.text.length > 0;
      const action: 'status' | 'wait' | 'abort' | 'send' = (() => {
        if (params.action === 'abort') return 'abort';
        if (params.action === 'wait') return 'wait';
        if (params.action === 'status') return 'status';
        return hasText ? 'send' : 'status';
      })();

      if (action === 'abort' && hasText) {
        return {
          content: [
            {
              type: 'text',
              text: 'subagent_send: `text` is not combinable with `action: "abort"` - pick one.',
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      if (action === 'send') {
        if (!entry.running) {
          return {
            content: [
              {
                type: 'text',
                text: `subagent_send: ${entry.handle} has already finished. Use \`action: "wait"\` to retrieve the final answer.`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        try {
          // `sendUserMessage` with `deliverAs: "steer"` queues the
          // text for the next turn boundary; pi handles the dispatch.
          await entry.session.sendUserMessage(params.text ?? '', { deliverAs: 'steer' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text', text: `subagent_send: steer failed - ${msg}` }],
            details: undefined,
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `subagent_send: steering message queued for ${entry.handle}.`,
            },
          ],
          details: entryToRunningDetails(entry),
          isError: false,
        };
      }

      if (action === 'abort') {
        if (!entry.running) {
          return {
            content: [
              {
                type: 'text',
                text: `subagent_send: ${entry.handle} already finished with stopReason=${entry.outcome?.details.stopReason ?? 'unknown'}.`,
              },
            ],
            details: entry.outcome?.details,
            isError: false,
          };
        }
        void entry.abort().catch(() => undefined);
        // Bound the entire wait, including an abort implementation that stalls.
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            entry.completion,
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, 1500);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
        return {
          content: [
            {
              type: 'text',
              text: `subagent_send: aborted ${entry.handle}.`,
            },
          ],
          details: entry.outcome?.details,
          isError: false,
        };
      }

      if (action === 'wait') {
        // Cancelling the parent tool turn (via `signal`) releases the
        // wait without aborting the child - the child keeps running
        // in the background and the parent can re-attach with another
        // `wait` call. If neither signal nor completion fires the
        // promise never resolves, so race them.
        let onAbort: (() => void) | undefined;
        let result: { kind: 'completed'; result: RunChildResult } | { kind: 'aborted' };
        try {
          result = await Promise.race<{ kind: 'completed'; result: RunChildResult } | { kind: 'aborted' }>([
            entry.completion.then((r) => ({ kind: 'completed', result: r })),
            new Promise((resolve) => {
              if (!signal) return;
              onAbort = () => resolve({ kind: 'aborted' });
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]);
        } finally {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
        if (result.kind === 'aborted') {
          return {
            content: [
              {
                type: 'text',
                text: `subagent_send: wait cancelled. ${entry.handle} is still running; call \`subagent_send\` again to re-attach.`,
              },
            ],
            details: entryToRunningDetails(entry),
            isError: false,
          };
        }
        return {
          content: [{ type: 'text', text: result.result.content }],
          details: result.result.details,
          isError: result.result.isError,
        };
      }

      // action === 'status'
      // Completed entries already carry `durationMs` in their snapshot
      // (set by the final pushStatus in drive()). For still-running
      // entries formatSubagentStatus intentionally hides elapsed time,
      // so we leave the snapshot untouched and expose wall-clock only
      // via the `details.durationMs` payload.
      // A finished child that did not complete (timeout / turn cap / abort /
      // error) gets the same explicit headline + touched-file list the
      // `wait` result leads with; a running child lists writes so far.
      const statusLines = [formatSubagentStatus(entry.snapshot)];
      const outcomeDetails = entry.outcome?.details;
      if (outcomeDetails) {
        const summary =
          outcomeDetails.stopReason === 'completed' ||
          outcomeDetails.stopReason === 'running' ||
          outcomeDetails.stopReason === 'spawned'
            ? undefined
            : formatStopSummary({
                agent: outcomeDetails.agent,
                stopReason: outcomeDetails.stopReason,
                timedOut: outcomeDetails.timedOut,
                timeoutMs: outcomeDetails.timeoutMs,
                durationMs: outcomeDetails.durationMs,
                turns: outcomeDetails.turns,
                maxTurns: outcomeDetails.maxTurns ?? entry.agent.maxTurns,
                touchedFiles: outcomeDetails.touchedFiles ?? [],
                errorMessage: outcomeDetails.error,
              });
        if (summary) statusLines.push(summary);
      } else {
        const touched = entry.touchedFiles();
        if (touched.length > 0) statusLines.push(`files written so far: ${touched.join(', ')}`);
      }
      return {
        content: [{ type: 'text', text: statusLines.join('\n') }],
        details: outcomeDetails ?? entryToRunningDetails(entry),
        isError: false,
      };
    },

    renderCall(args, theme, _context) {
      const a = args;
      const to = a.to || '(no handle)';
      const act = a.action ?? (a.text ? 'send' : 'status');
      let text = `${theme.fg('toolTitle', theme.bold('subagent_send '))}${theme.fg('accent', to)}`;
      text += ` ${theme.fg('dim', act)}`;
      if (a.text) {
        const preview = a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text;
        text += `\n  ${theme.fg('dim', preview)}`;
      }
      return new Text(text, 0, 0);
    },

    /**
     * Mirror the parent `subagent` card shape so the parent's scrollback
     * shows a consistent scorecard regardless of whether the child was
     * sync or background. The lead glyph is picked from the action +
     * the snapshot's stopReason; the body slot carries the final answer
     * (wait) or stays empty (status / abort).
     */
    renderResult(result, { expanded }, theme, context) {
      const details = (result.details ?? {}) as Partial<SubagentDetails>;
      // For `status` we treat `running` as the active state so the
      // scorecard's stop line reads `running`. For `wait` we report the
      // final stopReason. For `abort` we report `aborted` regardless of
      // whatever drive() classified - the user asked for an abort.
      const callArgs = (context.args ?? {}) as Partial<SubagentSendParamsT>;
      const action = callArgs.action ?? (callArgs.text ? 'send' : 'status');
      let stopReason: ScorecardStopReason;
      if (action === 'status') {
        stopReason =
          details.stopReason === 'running'
            ? 'running'
            : ((details.stopReason as ScorecardStopReason | undefined) ?? 'running');
      } else if (action === 'abort') {
        stopReason = 'aborted';
      } else if (action === 'wait') {
        stopReason = details.stopReason ?? 'completed';
      } else {
        // `send` (steering) keeps today's pi default rendering - mirror
        // it by collapsing to the lead line only.
        stopReason = details.stopReason ?? 'running';
      }
      const card = renderScorecard({
        theme,
        agent: details.agent ?? '(agent)',
        agentSource: details.agentSource,
        handle: details.handle,
        stopReason,
        snapshot: subagentDetailsToSnapshot(details, stopReason),
      });
      const first = result.content.find((c) => c.type === 'text');
      const body = first?.type === 'text' ? first.text : '';
      if (action === 'abort') {
        return new Text(`${card}\n${theme.fg('dim', '   (aborted by parent)')}`, 0, 0);
      }
      if (action === 'wait') {
        if (!body.trim()) return new Text(card, 0, 0);
        if (expanded) return new Text(`${card}\n\n${theme.fg('text', body)}`, 0, 0);
        const preview = body.length > 240 ? `${body.slice(0, 240)}…` : body;
        return new Text(`${card}\n\n${theme.fg('text', preview)}`, 0, 0);
      }
      // status: no body slot.
      return new Text(card, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // /agents command
  // ────────────────────────────────────────────────────────────────────

  pi.registerCommand('agents', {
    description: 'Show running sub-agents (default) or inspect loaded agent definitions',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(
        prefix,
        agentsSubverbSpec(loadResult.nameOrder, (n) => loadResult.agents.get(n)?.description ?? ''),
      ),

    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(AGENTS_USAGE, 'info');
        return;
      }
      const command = parseAgentsCommand(args);
      if (command.verb === 'invalid') {
        ctx.ui.notify(AGENTS_USAGE, 'warning');
        return;
      }
      reload(ctx.cwd);
      surfaceWarnings(ctx, loadResult.warnings);

      if (command.verb === 'reload') {
        const names = loadResult.nameOrder;
        const warnCount = loadResult.warnings.length;
        ctx.ui.notify(
          `subagent: re-scanned agent directories - ${names.length} loaded (${names.join(', ') || 'none'})` +
            (warnCount > 0 ? `; ${warnCount} warning(s)` : ''),
          'info',
        );
        return;
      }

      if (command.verb === 'running') {
        // Default view. Live overlay of background children, auto-refreshing
        // on a RUNNING_TICK_MS timer. Falls back to a flat notify when the
        // host lacks UI (print / rpc modes).
        const buildEntries = (): RunningOverlayEntry[] => {
          return [...backgroundChildren.values()]
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((e) => ({
              handle: e.handle,
              agent: e.agent.name,
              agentSource: e.agent.source,
              task: e.task,
              snapshot: e.snapshot,
              startedAt: e.startedAt,
              lastUpdateMs: e.startedAt + (e.snapshot.durationMs ?? Date.now() - e.startedAt),
              running: e.running,
              sessionFile: e.childSessionFile,
            }));
        };

        if (!ctx.hasUI) {
          const entries: RunningChildListItem[] = buildEntries().map((e) => ({
            handle: e.handle,
            snapshot: e.snapshot,
            startedAt: e.startedAt,
          }));
          ctx.ui.notify(formatRunningChildrenList(entries), 'info');
          return;
        }

        const rings = getSessionActivityRings();
        let ticker: ReturnType<typeof setInterval> | undefined;
        let overlay: AgentsRunningOverlay | undefined;
        await showModal<void>(ctx.ui, (tui, theme, _kb, done) => {
          overlay = new AgentsRunningOverlay(buildEntries, rings, theme, tui, () => {
            if (ticker) clearInterval(ticker);
            ticker = undefined;
            done();
          });
          ticker = setInterval(() => {
            overlay?.invalidate();
            tui.requestRender();
          }, RUNNING_TICK_MS);
          return overlay;
        });
        if (ticker) clearInterval(ticker);
        return;
      }

      if (command.verb === 'show') {
        const name = command.name;
        const a = loadResult.agents.get(name);
        if (!a) {
          ctx.ui.notify(
            `subagent: no agent "${name}" loaded. Available: ${loadResult.nameOrder.join(', ') || '(none)'}`,
            'warning',
          );
          return;
        }
        let body: string;
        try {
          body = readFileSync(a.path, 'utf8');
          statSync(a.path);
        } catch (e) {
          ctx.ui.notify(`subagent: cannot read ${a.path}: ${e instanceof Error ? e.message : String(e)}`, 'error');
          return;
        }
        ctx.ui.notify(`# ${a.name}  [${a.source}]\n# ${a.path}\n\n${body}`, 'info');
        return;
      }

      // command.verb === 'list': loaded-list overlay.
      // Loaded-list overlay. Fall back to a flat notify when the host
      // lacks UI (print / rpc modes) so the command stays usable.
      const agents: AgentPreviewSource[] = loadResult.nameOrder
        .map((n) => loadResult.agents.get(n))
        .filter((a): a is AgentDef => Boolean(a))
        .map((a) => ({
          name: a.name,
          description: a.description,
          source: a.source,
          path: a.path,
          tools: a.tools,
          model: a.model,
          maxTurns: a.maxTurns,
          timeoutMs: a.timeoutMs,
          isolation: a.isolation,
        }));

      if (!ctx.hasUI) {
        if (agents.length === 0) {
          ctx.ui.notify('subagent: no agents loaded.', 'info');
          return;
        }
        const lines: string[] = ['Loaded sub-agents:'];
        const maxName = agents.reduce((m, a) => Math.max(m, a.name.length), 0);
        for (const a of agents) {
          const pad = ' '.repeat(Math.max(1, maxName + 2 - a.name.length));
          lines.push(`  ${a.name}${pad}[${a.source}]  ${formatAgentListRowDescription(a.description)}`);
        }
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      await showModal<void>(
        ctx.ui,
        (tui, theme, _kb, done) => new AgentsLoadedOverlay(agents, theme, tui, () => done()),
      );
    },
  });
}
