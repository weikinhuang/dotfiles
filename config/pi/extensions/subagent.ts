/**
 * Subagent — Claude Code / opencode / codex-style task delegation for pi.
 *
 * The parent LLM calls a single `subagent(agent, task)` tool; the
 * extension spawns an in-process child `AgentSession` with its own
 * context window, tool allowlist, and — optionally — a dedicated model
 * or a git-worktree sandbox. The parent only sees the final answer text;
 * all intermediate tool churn stays in the child's own session file.
 *
 * Key shape:
 *
 *   - Single tool, `executionMode: "parallel"`. Parent fans out by
 *     calling it N times; an in-process semaphore caps concurrency at
 *     `PI_SUBAGENT_CONCURRENCY` (default 4, hard ceiling 8) so fan-out
 *     can't melt the machine.
 *   - Agent definitions are Markdown files under:
 *       1. `~/.dotfiles/config/pi/agents/`   (global)
 *       2. `~/.pi/agents/`                   (user)
 *       3. `<cwd>/.pi/agents/`               (project)
 *     Higher layers override by `name`.
 *   - Collapsible renderer (mirrors subdir-agents.ts style) shows a
 *     one-liner while running, the markdown final answer on expand.
 *     Child tool calls are NEVER streamed inline.
 *   - Child sessions persist to their own files under
 *     `<root>/<parent-cwd-slug>/subagents/<parent-session-id>/` so
 *     `session-usage.ts` picks them up next to the parent's session.
 *   - Parent-side audit via `pi.appendEntry('subagent-run', details)` +
 *     `pi.sendMessage({ customType: 'subagent-run' })` so the TUI
 *     renders the collapsible summary in the parent transcript.
 *   - Statusline integration through `ctx.ui.setStatus('subagent', …)` —
 *     statusline.ts already renders extension statuses on line 3, so
 *     no changes there.
 *   - Companion `/agents` command lists loaded agents; `/agents show
 *     <name>` prints the full frontmatter + body of a single agent.
 *
 * Environment:
 *   PI_SUBAGENT_DISABLED=1              skip the extension entirely
 *   PI_SUBAGENT_DEBUG=1                 surface every child lifecycle event via ctx.ui.notify
 *   PI_SUBAGENT_CONCURRENCY=N           max concurrent children (default 4, floor 1, ceiling 8)
 *   PI_SUBAGENT_NO_PERSIST=1            use SessionManager.inMemory() instead of disk-backed sessions
 *   PI_SUBAGENT_SESSION_ROOT=<path>     override ~/.pi/agent/sessions as the session root
 *   PI_SUBAGENT_RETAIN_DAYS=N           retain child session files for N days (default 30)
 *   PI_SUBAGENT_STATUS_LINGER_MS=N      keep completed status visible for N ms (default 5000)
 *   PI_SUBAGENT_MAX_TURNS=N             global max-turns cap (wins over per-agent setting)
 *   PI_SUBAGENT_TIMEOUT_MS=N            global wall-clock cap (wins over per-agent setting)
 *   PI_SUBAGENT_MODEL=provider/id       global model override applied to every child
 *
 * Commands:
 *   /agents            list every loaded agent with its source layer
 *   /agents show <n>   print full frontmatter + body of agent <n>
 *
 * Pure helpers live under `../../../lib/node/pi/subagent-*.ts` so they
 * can be unit-tested under vitest without the pi runtime.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
} from '@mariozechner/pi-coding-agent';
import { Text } from '@mariozechner/pi-tui';
import { Type } from 'typebox';
import { parseModelSpec } from '../../../lib/node/pi/btw.ts';
import {
  formatAgentListDescription,
  formatParallelSubagentStatus,
  formatSubagentStatus,
  type SubagentRunSnapshot,
} from '../../../lib/node/pi/subagent-format.ts';
import {
  type AgentDef,
  type AgentLoadResult,
  type AgentLoadWarning,
  defaultAgentLayers,
  loadAgents,
  type ReadLayer,
} from '../../../lib/node/pi/subagent-loader.ts';
import {
  classifyStopReason,
  extractFinalAssistantText,
  type AgentMessageLike,
} from '../../../lib/node/pi/subagent-result.ts';
import {
  childSessionDir,
  listStaleWorktrees,
  subagentSessionRoot,
  sweepStaleSessions,
  type SweepFs,
} from '../../../lib/node/pi/subagent-session-paths.ts';

const SUBAGENT_CUSTOM_TYPE = 'subagent-run';
const STATUS_KEY = 'subagent';

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const DEFAULT_STATUS_LINGER_MS = 5000;
const DEFAULT_RETAIN_DAYS = 30;

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

interface SubagentParamsT {
  agent: string;
  task: string;
  modelOverride?: string;
  returnFormat?: 'text' | 'json';
}

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
  stopReason: 'completed' | 'max_turns' | 'aborted' | 'error';
  workspace?: {
    isolation: 'shared-cwd' | 'worktree';
    worktreePath?: string;
  };
  childSessionFile?: string;
  childSessionId?: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Env helpers
// ──────────────────────────────────────────────────────────────────────

function envPositiveInt(name: string, def: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return max !== undefined ? Math.min(n, max) : n;
}

function envConcurrency(): number {
  return Math.max(1, envPositiveInt('PI_SUBAGENT_CONCURRENCY', DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
}

// ──────────────────────────────────────────────────────────────────────
// Concurrency semaphore (process-wide)
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal async semaphore. `acquire` resolves only when the caller is
 * allowed to proceed (active count < limit); the caller must pair it
 * with a `release()` inside a finally. Waiters are resumed FIFO.
 *
 * The fast path increments `active` before returning; the slow path
 * parks on the queue, and the increment happens in `release()`'s
 * resumption of the waiter (since `release()` does NOT decrement
 * `active` for the waiter's sake — the waiter simply inherits the
 * released slot).
 */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // Waiter inherits the slot released by the prior holder — no
    // additional `active++` needed because `release()` intentionally
    // skipped its `active--` when a waiter was present.
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }
}

// ──────────────────────────────────────────────────────────────────────
// File I/O glue
// ──────────────────────────────────────────────────────────────────────

function makeReadLayer(): ReadLayer {
  return {
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
}

function makeSweepFs(): SweepFs {
  return {
    readdir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
    stat: (path) => {
      try {
        const s = statSync(path);
        return { mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
      } catch {
        return null;
      }
    },
    remove: (path) => {
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Worktree helpers (stale sweep + per-call create/cleanup)
// ──────────────────────────────────────────────────────────────────────

/**
 * Shell out to `git` safely. Uses `execFileSync` so arguments are
 * passed argv-style (no shell word splitting); path and branch names
 * never reach `/bin/sh`. Returns true on exit 0, false otherwise.
 */
function runGit(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

interface CreatedWorktree {
  /** Absolute path of the checkout inside the temp dir. */
  path: string;
  /** Outer temp dir — must be `rm -rf`d after `git worktree remove`. */
  tmpDir: string;
  /** Branch name created by `git worktree add -b`. */
  branch: string;
}

function createWorktree(cwd: string): CreatedWorktree | { error: string } {
  const id = `pi-subagent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const tmp = mkdtempSync(join(tmpdir(), 'pi-subagent-wt-'));
  const path = join(tmp, 'checkout');
  const branch = id;
  if (runGit(cwd, ['worktree', 'add', '-b', branch, path])) {
    return { path, tmpDir: tmp, branch };
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // tmp may not have been fully created — benign.
  }
  return { error: `git worktree add failed for ${path}` };
}

function removeWorktree(parentCwd: string, wt: Pick<CreatedWorktree, 'path' | 'tmpDir' | 'branch'>): void {
  // `git worktree remove --force` tears down the checkout AND removes the
  // .git/worktrees/<branch>/ bookkeeping. If that fails (repo renamed,
  // moved, or corrupted), fall back to wiping the outer tmp dir so we
  // at least don't leak disk — the bookkeeping pointer can be cleaned up
  // by the next `git worktree prune` sweep.
  const removedViaGit = runGit(parentCwd, ['worktree', 'remove', '--force', wt.path]);
  if (!removedViaGit) {
    try {
      rmSync(wt.tmpDir, { recursive: true, force: true });
    } catch {
      // manual cleanup is the user's problem at this point
    }
  } else {
    // `git worktree remove` drops the `checkout` subdir but leaves our
    // `mkdtempSync` parent dir in place; clean it up so /tmp doesn't
    // accumulate empty pi-subagent-wt-* shells.
    try {
      rmSync(wt.tmpDir, { recursive: true, force: true });
    } catch {
      // benign — empty dir only
    }
  }
  // Branch deletion is best-effort; if the branch was checked out
  // elsewhere the -D still works because the worktree is gone.
  runGit(parentCwd, ['branch', '-D', wt.branch]);
}

function sweepStaleWorktrees(parentCwd: string, debugNotify: (msg: string) => void): void {
  const stale = listStaleWorktrees(parentCwd, makeSweepFs());
  if (stale.length === 0) return;
  // Prune first so .git/worktrees/ bookkeeping matches disk; otherwise
  // `worktree remove` on a dir git doesn't know about is a no-op.
  runGit(parentCwd, ['worktree', 'prune']);
  for (const path of stale) {
    if (!runGit(parentCwd, ['worktree', 'remove', '--force', path])) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // manual cleanup required
      }
    }
  }
  debugNotify(`subagent: swept ${stale.length} stale worktree(s)`);
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
  errorFromChild: string | undefined;
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
    errorFromChild: undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Error-result helpers used by the delegation path
// ──────────────────────────────────────────────────────────────────────

function toolErrorResult(args: { agent: AgentDef; task: string; durationMs: number; error: string }): {
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
      stopReason: 'error',
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
}): { content: string; details: SubagentDetails; isError: true } {
  if (args.worktree) removeWorktree(args.parentCwd, args.worktree);
  return toolErrorResult(args);
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_DISABLED === '1') return;

  const debug = process.env.PI_SUBAGENT_DEBUG === '1';

  // Directory containing this extension file — used to resolve the
  // shipped `config/pi/agents/` sibling directory without relying on
  // `DOTFILES_ROOT` or similar.
  const extDir = dirname(fileURLToPath(import.meta.url));
  const userPiDir = `${homedir()}/.pi`;

  let loadResult: AgentLoadResult = { agents: new Map(), nameOrder: [], warnings: [] };
  const surfacedWarnings = new Set<string>();

  // Process-wide concurrency semaphore. Limit is captured once at
  // session start; changing `PI_SUBAGENT_CONCURRENCY` mid-session
  // requires /reload.
  const semaphore = new Semaphore(envConcurrency());

  // Running-child registry for the statusline aggregate rendering. Each
  // child owns an entry here from acquire-time until its per-call linger
  // timer fires. Parallel children collapse into the parallel-aggregate
  // status; solo children render the single-child format.
  const runningChildren = new Map<string, SubagentRunSnapshot>();
  // Per-child linger timers kept so session_shutdown can cancel them all.
  const lingerTimers = new Set<ReturnType<typeof setTimeout>>();

  const updateStatus = (ctx: ExtensionContext): void => {
    const entries = [...runningChildren.values()];
    if (entries.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    if (entries.length === 1) {
      ctx.ui.setStatus(STATUS_KEY, formatSubagentStatus(entries[0]!));
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, formatParallelSubagentStatus(entries));
  };

  const reload = (cwd: string): void => {
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
    const layers = defaultAgentLayers({ extensionDir: extDir, userPiDir, cwd });
    loadResult = loadAgents({
      layers,
      knownToolNames,
      fs: makeReadLayer(),
      parseFrontmatter,
    });
  };

  const surfaceWarnings = (ctx: ExtensionContext, warnings: readonly AgentLoadWarning[]): void => {
    for (const w of warnings) {
      const key = `${w.path}:${w.reason}`;
      if (surfacedWarnings.has(key)) continue;
      surfacedWarnings.add(key);
      ctx.ui.notify(`subagent: ${w.path}: ${w.reason}`, 'warning');
    }
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
    reload(ctx.cwd);
    surfaceWarnings(ctx, loadResult.warnings);
    // Sweep stale worktrees + old child session files from prior (possibly
    // crashed) runs. Both helpers are best-effort and silent on failure.
    const debugNotify = (m: string): void => {
      if (debug) ctx.ui.notify(m, 'info');
    };
    sweepStaleWorktrees(ctx.cwd, debugNotify);
    const retain = envPositiveInt('PI_SUBAGENT_RETAIN_DAYS', DEFAULT_RETAIN_DAYS);
    const swept = sweepStaleSessions(subagentSessionRoot(), retain, makeSweepFs());
    if (debug && swept.removed > 0) ctx.ui.notify(`subagent: swept ${swept.removed} stale session file(s)`, 'info');
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // Happy-path sweep. Both sweeps are best-effort — shutdown must
    // not block or throw.
    try {
      sweepStaleWorktrees(ctx.cwd, () => {
        // silent — shutdown sweep is best-effort
      });
    } catch {
      // never block shutdown
    }
    try {
      const retain = envPositiveInt('PI_SUBAGENT_RETAIN_DAYS', DEFAULT_RETAIN_DAYS);
      sweepStaleSessions(subagentSessionRoot(), retain, makeSweepFs());
    } catch {
      // never block shutdown
    }
    loadResult = { agents: new Map(), nameOrder: [], warnings: [] };
    surfacedWarnings.clear();
    runningChildren.clear();
    for (const t of lingerTimers) clearTimeout(t);
    lingerTimers.clear();
  });

  // ────────────────────────────────────────────────────────────────────
  // Tool schema + description
  // ────────────────────────────────────────────────────────────────────

  const toolDescription = (): string => {
    const items = loadResult.nameOrder.map((n) => {
      const a = loadResult.agents.get(n);
      return { name: n, description: a?.description ?? '', source: a?.source };
    });
    return [
      'Delegate a subtask to a specialized sub-agent that runs with its own fresh context, tool allowlist, and (optionally) model.',
      "The parent sees only the child's final answer text — intermediate tool calls stay in the child's own session file.",
      'Parallel fan-out is supported: call this tool multiple times in one assistant turn and the invocations run concurrently.',
      '',
      formatAgentListDescription(items),
    ].join('\n');
  };

  const SubagentParams = Type.Object({
    agent: Type.String({
      description:
        'Sub-agent type name (see the tool description for the enumerated list). Must match one of the loaded agent definitions.',
    }),
    task: Type.String({
      description:
        'What the sub-agent should do. Be specific — the sub-agent starts with NO context from this conversation. ' +
        'Include paths, constraints, and the expected answer shape. One task per call.',
    }),
    modelOverride: Type.Optional(
      Type.String({
        description:
          'Override the agent definition\'s model with `provider/modelId`. Useful for "run this explore subagent against a cheaper local model" style fan-outs.',
      }),
    ),
    returnFormat: Type.Optional(
      Type.Union([Type.Literal('text'), Type.Literal('json')], {
        description:
          "Parse the child's final answer as JSON before returning. Falls back to raw text when the answer isn't valid JSON.",
      }),
    ),
  });

  // ────────────────────────────────────────────────────────────────────
  // Delegation
  // ────────────────────────────────────────────────────────────────────

  async function runChild(args: {
    agent: AgentDef;
    task: string;
    modelOverride: string | undefined;
    ctx: ExtensionContext;
    parentSignal: AbortSignal | undefined;
  }): Promise<{ content: string; details: SubagentDetails; isError?: boolean }> {
    const { agent, task, modelOverride, ctx, parentSignal } = args;
    const start = Date.now();
    const agg = makeAggregate();

    // ── Model resolution ──────────────────────────────────────────────
    const globalOverride = process.env.PI_SUBAGENT_MODEL;
    const modelSpecStr = modelOverride ?? globalOverride;
    let childModel = ctx.model;
    if (modelSpecStr) {
      const spec = parseModelSpec(modelSpecStr);
      if (!spec) {
        return toolErrorResult({
          agent,
          task,
          durationMs: Date.now() - start,
          error: `invalid modelOverride "${modelSpecStr}" (expected provider/id)`,
        });
      }
      const resolved = ctx.modelRegistry.find(spec.provider, spec.modelId);
      if (!resolved) {
        return toolErrorResult({
          agent,
          task,
          durationMs: Date.now() - start,
          error: `model ${spec.provider}/${spec.modelId} not registered`,
        });
      }
      childModel = resolved;
    } else if (agent.model !== 'inherit') {
      const resolved = ctx.modelRegistry.find(agent.model.provider, agent.model.modelId);
      if (!resolved) {
        return toolErrorResult({
          agent,
          task,
          durationMs: Date.now() - start,
          error: `agent model ${agent.model.provider}/${agent.model.modelId} not registered`,
        });
      }
      childModel = resolved;
    }
    if (!childModel) {
      return toolErrorResult({
        agent,
        task,
        durationMs: Date.now() - start,
        error: 'no model available for child session (use /login or configure a default model)',
      });
    }

    // ── Workspace (shared-cwd vs worktree) ────────────────────────────
    let childCwd = ctx.cwd;
    let worktree: CreatedWorktree | undefined;
    let workspaceIsolation: 'shared-cwd' | 'worktree' = 'shared-cwd';
    if (agent.isolation === 'worktree') {
      const wt = createWorktree(ctx.cwd);
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
    // gets cleaned up on any failure — the prior split let a
    // `resourceLoader.reload()` throw bypass the cleanup path.
    const noPersist = process.env.PI_SUBAGENT_NO_PERSIST === '1';
    const sessionDir = childSessionDir({
      parentCwd: ctx.cwd,
      parentSessionId: ctx.sessionManager.getSessionId(),
    });
    // SessionManager.create will mkdir the sessionDir lazily on first write.
    const childSessionManager = noPersist
      ? SessionManager.inMemory(childCwd)
      : SessionManager.create(childCwd, sessionDir);

    let child: AgentSession;
    try {
      const agentDir = getAgentDir();
      const appendParts: string[] = [];
      if (agent.appendSystemPrompt) appendParts.push(agent.appendSystemPrompt);
      if (agent.body.trim().length > 0) appendParts.push(agent.body.trim());
      const resourceLoader = new DefaultResourceLoader({
        cwd: childCwd,
        agentDir,
        settingsManager: undefined,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        appendSystemPrompt: appendParts.length > 0 ? appendParts : undefined,
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: childCwd,
        model: childModel,
        thinkingLevel: agent.thinkingLevel,
        tools: agent.tools,
        modelRegistry: ctx.modelRegistry,
        authStorage: ctx.modelRegistry.authStorage,
        resourceLoader,
        sessionManager: childSessionManager,
      });
      child = created.session;
    } catch (e) {
      return cleanupAndError({
        agent,
        task,
        durationMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
        worktree,
        parentCwd: ctx.cwd,
      });
    }

    const childSessionId = childSessionManager.getSessionId();
    const childSessionFile = childSessionManager.getSessionFile();

    // ── Subscribe to child events ─────────────────────────────────────
    const maxTurns = Math.min(agent.maxTurns, envPositiveInt('PI_SUBAGENT_MAX_TURNS', Number.MAX_SAFE_INTEGER));
    let reachedMaxTurns = false;
    // We trigger `child.abort()` ourselves on maxTurns, timeout, or parent
    // signal — any of those counts as an "aborted" outcome even though
    // `parentSignal.aborted` stays false for the first two.
    let abortedByUs = false;

    const pushStatus = (state: SubagentRunSnapshot['state'], opts?: { durationMs?: number }): void => {
      const snap: SubagentRunSnapshot = {
        agent: agent.name,
        state,
        model: childModel?.id,
        turns: agg.turns,
        input: agg.input,
        cacheRead: agg.cacheRead,
        output: agg.output,
        cost: agg.cost,
        contextTokens: agg.contextTokens > 0 ? agg.contextTokens : undefined,
        contextWindow: childModel?.contextWindow,
        durationMs: opts?.durationMs,
      };
      runningChildren.set(childSessionId, snap);
      updateStatus(ctx);
    };

    pushStatus('running');

    const unsubscribe = child.subscribe((event: AgentSessionEvent) => {
      if (debug) ctx.ui.notify(`subagent[${agent.name}]: ${event.type}`, 'info');
      if (event.type === 'turn_end') {
        agg.turns++;
        if (agg.turns >= maxTurns) {
          reachedMaxTurns = true;
          abortedByUs = true;
          void child.abort();
        }
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
        const err = (event.message as { errorMessage?: string }).errorMessage;
        if (err) agg.errorFromChild = err;
        pushStatus('running');
      }
    });

    // ── Abort chain (parent signal + timeout) ─────────────────────────
    const timeoutMs = Math.min(agent.timeoutMs, envPositiveInt('PI_SUBAGENT_TIMEOUT_MS', Number.MAX_SAFE_INTEGER));
    const timeoutHandle = setTimeout(() => {
      abortedByUs = true;
      void child.abort();
    }, timeoutMs);
    const parentAbortHandler = (): void => {
      abortedByUs = true;
      void child.abort();
    };
    parentSignal?.addEventListener('abort', parentAbortHandler, { once: true });

    let childError: Error | undefined;
    try {
      await child.prompt(task);
    } catch (e) {
      childError = e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener('abort', parentAbortHandler);
      unsubscribe();
    }

    // AbortError may arrive as a thrown DOMException, an Error whose
    // `name` is `AbortError`, or no throw at all (pi may swallow it).
    // `abortedByUs` covers timeout, maxTurns, and parent-signal paths;
    // `parentSignal.aborted` covers the rare case where the parent
    // aborted between our listener firing and `removeEventListener`.
    const errorIsAbort =
      childError !== undefined && (childError.name === 'AbortError' || /abort/i.test(childError.message ?? ''));
    const aborted = abortedByUs || parentSignal?.aborted === true || errorIsAbort;
    const hasRealError = childError !== undefined && !errorIsAbort;
    const stopReason = classifyStopReason({
      reachedMaxTurns,
      aborted: aborted && !reachedMaxTurns,
      error: !reachedMaxTurns && !aborted && (hasRealError || agg.errorFromChild !== undefined),
    });

    // ── Extract final answer text + terminate child ───────────────────
    const messages = child.state.messages as unknown as AgentMessageLike[];
    let finalText = extractFinalAssistantText(messages);
    if (stopReason === 'error' && finalText.length === 0) {
      finalText = `subagent ${agent.name}: ${agg.errorFromChild ?? childError?.message ?? 'child session errored'}`;
    } else if (stopReason === 'max_turns' && finalText.length === 0) {
      finalText = `subagent ${agent.name} exhausted its ${maxTurns}-turn budget without producing a final answer.`;
    } else if (stopReason === 'aborted' && finalText.length === 0) {
      finalText = `subagent ${agent.name} was aborted.`;
    }

    child.dispose();

    // ── Cleanup the worktree (if any) ─────────────────────────────────
    if (worktree) removeWorktree(ctx.cwd, worktree);

    // ── Final status with duration atomically, then schedule linger clear ─
    const durationMs = Date.now() - start;
    const finalState: SubagentRunSnapshot['state'] =
      stopReason === 'completed'
        ? 'completed'
        : stopReason === 'max_turns'
          ? 'max_turns'
          : stopReason === 'aborted'
            ? 'aborted'
            : 'error';
    pushStatus(finalState, { durationMs });
    // After a linger so the user sees the final numbers, drop this
    // child from the aggregate. Each child owns its own timer so
    // concurrent children don't stomp each other.
    const linger = envPositiveInt('PI_SUBAGENT_STATUS_LINGER_MS', DEFAULT_STATUS_LINGER_MS);
    const timer = setTimeout(() => {
      lingerTimers.delete(timer);
      runningChildren.delete(childSessionId);
      updateStatus(ctx);
    }, linger);
    lingerTimers.add(timer);

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
      workspace: { isolation: workspaceIsolation, worktreePath: worktree?.path },
      childSessionId,
      childSessionFile,
      error: stopReason === 'error' ? (agg.errorFromChild ?? childError?.message) : undefined,
    };

    return {
      content: finalText,
      details,
      isError: stopReason !== 'completed',
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Tool registration
  // ────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: toolDescription(),
    promptSnippet:
      'Delegate a subtask to a fresh sub-agent session so intermediate exploration stays out of your context.',
    promptGuidelines: [
      'Use `subagent` when the next step would read many files, run a broad `grep`, or otherwise produce intermediate noise you will not use yourself. Prefer the `explore` agent for read-only discovery and the `plan` agent for implementation planning.',
      'The sub-agent starts with no context — describe the goal, constraints, and desired output shape inside `task`.',
      'To fan out work, call `subagent` multiple times in one turn. Runs execute concurrently; the tool aggregates per-call results.',
      'Do NOT call `subagent` from inside a sub-agent. Nesting is disabled by design.',
    ],
    parameters: SubagentParams,
    executionMode: 'parallel',

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as unknown as SubagentParamsT;
      const agent: AgentDef | undefined = loadResult.agents.get(params.agent);
      if (!agent) {
        const available = loadResult.nameOrder.join(', ') || '(none loaded)';
        return {
          content: [
            {
              type: 'text',
              text: `subagent: unknown agent "${params.agent}". Available: ${available}`,
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

      await semaphore.acquire();
      let out: { content: string; details: SubagentDetails; isError?: boolean };
      try {
        out = await runChild({
          agent,
          task: params.task,
          modelOverride: params.modelOverride,
          ctx,
          parentSignal: signal,
        });
      } finally {
        semaphore.release();
      }

      // Parent-side audit entry so /fork, /tree, and session-usage can
      // see delegated runs without scanning message bodies. We do NOT
      // also call pi.sendMessage() for the run: pi's convertToLlm
      // serializes `custom` messages as synthetic `user` turns, which
      // would double the prompt tokens the parent bills for the same
      // content that's already in the tool_result. The tool_result
      // itself is what the parent model consumes.
      try {
        pi.appendEntry(SUBAGENT_CUSTOM_TYPE, out.details);
      } catch {
        // appendEntry can throw before the session is fully bound.
      }

      // `returnFormat: 'json'` asks us to validate that the child
      // produced parseable JSON. On failure we flag isError so the
      // parent LLM can retry the call — the raw text still reaches
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
      const a = args as SubagentParamsT;
      const name = a.agent || '(no agent)';
      const preview = a.task ? (a.task.length > 80 ? `${a.task.slice(0, 80)}…` : a.task) : '';
      let text = `${theme.fg('toolTitle', theme.bold('subagent '))}${theme.fg('accent', name)}`;
      if (preview) text += `\n  ${theme.fg('dim', preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<SubagentDetails>;
      const glyph =
        details.stopReason === 'completed'
          ? theme.fg('success', '✓')
          : details.stopReason === 'max_turns'
            ? theme.fg('warning', '∎')
            : details.stopReason === 'aborted'
              ? theme.fg('warning', '⚠')
              : theme.fg('error', '✗');
      const agent = details.agent ?? '(agent)';
      const source = details.agentSource ? theme.fg('muted', ` (${details.agentSource})`) : '';
      const lead = `${glyph} ${theme.fg('toolTitle', theme.bold(agent))}${source}`;
      const first = result.content.find((c) => c.type === 'text');
      const body = first && first.type === 'text' ? first.text : '';
      if (expanded && body.trim()) {
        return new Text(`${lead}\n${theme.fg('text', body)}`, 0, 0);
      }
      const preview = body.length > 240 ? `${body.slice(0, 240)}…` : body;
      return new Text(`${lead}\n${theme.fg('dim', preview)}`, 0, 0);
    },
  });

  // ────────────────────────────────────────────────────────────────────
  // /agents command
  // ────────────────────────────────────────────────────────────────────

  pi.registerCommand('agents', {
    description: 'List loaded sub-agents (`/agents`) or show one definition (`/agents show <name>`)',
    getArgumentCompletions: (prefix) => {
      const arg = prefix.trim();
      if (arg === '' || 'show'.startsWith(arg)) {
        return [{ value: 'show', label: 'show', description: 'Show full frontmatter + body for an agent' }];
      }
      const tokens = prefix.split(/\s+/);
      if (tokens[0] === 'show') {
        const needle = tokens[1] ?? '';
        return loadResult.nameOrder
          .filter((n) => n.startsWith(needle))
          .map((n) => ({ value: `show ${n}`, label: n, description: loadResult.agents.get(n)?.description ?? '' }));
      }
      return null;
    },

    handler: async (args, ctx) => {
      const raw = (args ?? '').trim();
      reload(ctx.cwd);
      surfaceWarnings(ctx, loadResult.warnings);

      if (!raw || raw === 'list') {
        if (loadResult.nameOrder.length === 0) {
          ctx.ui.notify(
            'subagent: no agents loaded. Drop Markdown definitions into ~/.pi/agents/ or .pi/agents/ in this project.',
            'info',
          );
          return;
        }
        const lines: string[] = ['Loaded sub-agents:'];
        const maxName = loadResult.nameOrder.reduce((m, n) => Math.max(m, n.length), 0);
        for (const n of loadResult.nameOrder) {
          const a = loadResult.agents.get(n);
          if (!a) continue;
          const pad = ' '.repeat(Math.max(1, maxName + 2 - n.length));
          lines.push(`  ${n}${pad}[${a.source}]  ${a.description}`);
        }
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      const match = /^show\s+(\S+)$/.exec(raw);
      if (match) {
        const name = match[1]!;
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

      ctx.ui.notify('subagent: usage: /agents [list] | /agents show <name>', 'warning');
    },
  });
}
