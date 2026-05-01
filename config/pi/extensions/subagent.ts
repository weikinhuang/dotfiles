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

import { execSync } from 'node:child_process';
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
import { Box, Markdown, Text } from '@mariozechner/pi-tui';
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

interface SemaphoreState {
  active: number;
  queue: (() => void)[];
}

function createSemaphore(_limit: number): SemaphoreState {
  return { active: 0, queue: [] };
}

async function acquire(sem: SemaphoreState, limit: number): Promise<void> {
  if (sem.active < limit) {
    sem.active++;
    return;
  }
  await new Promise<void>((resolve) => sem.queue.push(resolve));
  sem.active++;
}

function release(sem: SemaphoreState): void {
  sem.active--;
  const next = sem.queue.shift();
  if (next) next();
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

function createWorktree(cwd: string): { path: string; branch: string } | { error: string } {
  const id = `pi-subagent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const tmp = mkdtempSync(join(tmpdir(), 'pi-subagent-wt-'));
  const path = join(tmp, 'checkout');
  const branch = id;
  try {
    execSync(`git worktree add -b ${branch} ${JSON.stringify(path)}`, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { path, branch };
  } catch (e) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // tmp may not have been fully created — benign.
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function removeWorktree(parentCwd: string, worktreePath: string, branch: string): void {
  try {
    execSync(`git worktree remove --force ${JSON.stringify(worktreePath)}`, {
      cwd: parentCwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    // Fallback: drop the dir manually. The branch is named after the worktree id
    // and cleaned by `git worktree prune` on the next sweep.
    try {
      rmSync(dirname(worktreePath), { recursive: true, force: true });
    } catch {
      // noop — manual cleanup is the user's problem at this point.
    }
  }
  try {
    execSync(`git branch -D ${branch}`, { cwd: parentCwd, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    // Branch deletion is best-effort.
  }
}

function sweepStaleWorktrees(parentCwd: string, debugNotify: (msg: string) => void): void {
  const stale = listStaleWorktrees(parentCwd, makeSweepFs());
  if (stale.length === 0) return;
  try {
    execSync('git worktree prune', { cwd: parentCwd, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    // prune can fail on corrupted repos — don't block the session on it.
  }
  for (const path of stale) {
    try {
      execSync(`git worktree remove --force ${JSON.stringify(path)}`, {
        cwd: parentCwd,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // manual cleanup required
      }
    }
  }
  if (stale.length > 0) debugNotify(`subagent: swept ${stale.length} stale worktree(s)`);
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
  worktreePath: string | undefined;
  worktreeBranch: string | undefined;
  parentCwd: string;
}): { content: string; details: SubagentDetails; isError: true } {
  if (args.worktreePath && args.worktreeBranch) {
    removeWorktree(args.parentCwd, args.worktreePath, args.worktreeBranch);
  }
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

  // Process-wide concurrency semaphore keyed on the env value. The limit
  // is re-read every acquire so editing the env mid-session takes effect.
  const concurrencyLimit = envConcurrency();
  const semaphore = createSemaphore(concurrencyLimit);

  // Running-child registry for the statusline aggregate rendering.
  const runningChildren = new Map<string, SubagentRunSnapshot>();
  let statusLingerTimer: ReturnType<typeof setTimeout> | undefined;

  const updateStatus = (ctx: ExtensionContext): void => {
    const entries = [...runningChildren.values()];
    if (entries.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
      return;
    }
    if (entries.length === 1) {
      ctx.ui.setStatus(STATUS_KEY, formatSubagentStatus(entries[0]!));
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, formatParallelSubagentStatus(entries));
  };

  const scheduleStatusClear = (ctx: ExtensionContext): void => {
    const lingerMs = envPositiveInt('PI_SUBAGENT_STATUS_LINGER_MS', DEFAULT_STATUS_LINGER_MS);
    if (statusLingerTimer) clearTimeout(statusLingerTimer);
    statusLingerTimer = setTimeout(() => {
      if (runningChildren.size === 0) ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
    }, lingerMs);
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
  // TUI rendering
  // ────────────────────────────────────────────────────────────────────

  pi.registerMessageRenderer<SubagentDetails>(SUBAGENT_CUSTOM_TYPE, (message, { expanded }, theme) => {
    const d = message.details;
    const prefix = theme.fg('accent', '[subagent]');
    const body = typeof message.content === 'string' ? message.content : '';
    if (!d) {
      const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));
      box.addChild(new Text(`${prefix} (no details)`, 0, 0));
      return box;
    }
    const glyph =
      d.stopReason === 'completed'
        ? theme.fg('success', '✓')
        : d.stopReason === 'max_turns'
          ? theme.fg('warning', '∎')
          : d.stopReason === 'aborted'
            ? theme.fg('warning', '⚠')
            : theme.fg('error', '✗');
    const durS = d.durationMs > 0 ? ` ${(d.durationMs / 1000).toFixed(1)}s` : '';
    const costS = d.cost > 0 ? ` $${d.cost.toFixed(4)}` : '';
    const head =
      `${prefix} ${glyph} ${theme.fg('toolTitle', theme.bold(d.agent))}` +
      theme.fg('muted', ` ${d.turns} turn${d.turns === 1 ? '' : 's'}${costS}${durS}`);
    if (!expanded) {
      const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));
      box.addChild(new Text(head, 0, 0));
      return box;
    }
    const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));
    box.addChild(new Text(head, 0, 0));
    if (d.error) box.addChild(new Text(theme.fg('error', d.error), 0, 0));
    if (body.trim()) box.addChild(new Markdown(body.trim(), 0, 0));
    return box;
  });

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
    // Happy-path sweep in case the shutdown was clean but prior runs
    // left artefacts.
    try {
      sweepStaleWorktrees(ctx.cwd, () => {
        // silent — shutdown sweep is best-effort
      });
    } catch {
      // never block shutdown
    }
    loadResult = { agents: new Map(), nameOrder: [], warnings: [] };
    surfacedWarnings.clear();
    runningChildren.clear();
    if (statusLingerTimer) {
      clearTimeout(statusLingerTimer);
      statusLingerTimer = undefined;
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
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    let workspaceIsolation: 'shared-cwd' | 'worktree' = 'shared-cwd';
    if (agent.isolation === 'worktree') {
      const wt = createWorktree(ctx.cwd);
      if ('error' in wt) {
        ctx.ui.notify(`subagent: worktree create failed, falling back to shared-cwd: ${wt.error}`, 'warning');
      } else {
        childCwd = wt.path;
        worktreePath = wt.path;
        worktreeBranch = wt.branch;
        workspaceIsolation = 'worktree';
      }
    }

    // ── Session manager selection ─────────────────────────────────────
    const noPersist = process.env.PI_SUBAGENT_NO_PERSIST === '1';
    const sessionDir = childSessionDir({
      parentCwd: ctx.cwd,
      parentSessionId: ctx.sessionManager.getSessionId(),
    });
    // SessionManager.create will mkdir the sessionDir lazily on first write.
    const childSessionManager = noPersist
      ? SessionManager.inMemory(childCwd)
      : SessionManager.create(childCwd, sessionDir);

    // ── ResourceLoader (noExtensions: true to keep child startup tight) ─
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

    // ── Create the child session ──────────────────────────────────────
    let child: AgentSession;
    try {
      const { session } = await createAgentSession({
        cwd: childCwd,
        model: childModel,
        thinkingLevel: agent.thinkingLevel,
        tools: agent.tools,
        modelRegistry: ctx.modelRegistry,
        authStorage: ctx.modelRegistry.authStorage,
        resourceLoader,
        sessionManager: childSessionManager,
      });
      child = session;
    } catch (e) {
      return cleanupAndError({
        agent,
        task,
        durationMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
        worktreePath,
        worktreeBranch,
        parentCwd: ctx.cwd,
      });
    }

    const childSessionId = childSessionManager.getSessionId();
    const childSessionFile = childSessionManager.getSessionFile();

    // ── Subscribe to child events ─────────────────────────────────────
    const maxTurns = Math.min(agent.maxTurns, envPositiveInt('PI_SUBAGENT_MAX_TURNS', Number.MAX_SAFE_INTEGER));
    let reachedMaxTurns = false;

    const pushStatus = (state: SubagentRunSnapshot['state']): void => {
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
      void child.abort();
    }, timeoutMs);
    const parentAbortHandler = (): void => {
      void child.abort();
    };
    parentSignal?.addEventListener('abort', parentAbortHandler, { once: true });

    let childError: string | undefined;
    try {
      await child.prompt(task);
    } catch (e) {
      childError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener('abort', parentAbortHandler);
      unsubscribe();
    }

    const aborted =
      parentSignal?.aborted === true ||
      (reachedMaxTurns === false && childError !== undefined ? /abort/i.test(childError) : false);
    const stopReason = classifyStopReason({
      reachedMaxTurns,
      aborted,
      error: !reachedMaxTurns && !aborted && (childError !== undefined || agg.errorFromChild !== undefined),
    });

    // ── Extract final answer text + terminate child ───────────────────
    const messages = child.state.messages as unknown as AgentMessageLike[];
    let finalText = extractFinalAssistantText(messages);
    if (stopReason === 'error' && finalText.length === 0) {
      finalText = `subagent ${agent.name}: ${agg.errorFromChild ?? childError ?? 'child session errored'}`;
    } else if (stopReason === 'max_turns' && finalText.length === 0) {
      finalText = `subagent ${agent.name} exhausted its ${maxTurns}-turn budget without producing a final answer.`;
    } else if (stopReason === 'aborted' && finalText.length === 0) {
      finalText = `subagent ${agent.name} was aborted.`;
    }

    child.dispose();

    // ── Cleanup the worktree (if any) ─────────────────────────────────
    if (worktreePath && worktreeBranch) {
      removeWorktree(ctx.cwd, worktreePath, worktreeBranch);
    }

    // ── Surface final status + schedule clear ─────────────────────────
    pushStatus(
      stopReason === 'completed'
        ? 'completed'
        : stopReason === 'max_turns'
          ? 'max_turns'
          : stopReason === 'aborted'
            ? 'aborted'
            : 'error',
    );
    const finalSnap = runningChildren.get(childSessionId);
    if (finalSnap) {
      finalSnap.durationMs = Date.now() - start;
      runningChildren.set(childSessionId, finalSnap);
      updateStatus(ctx);
    }
    // Move the completed child out of the "running" set after a short
    // linger so the parallel aggregator reflects reality.
    setTimeout(
      () => {
        runningChildren.delete(childSessionId);
        updateStatus(ctx);
      },
      envPositiveInt('PI_SUBAGENT_STATUS_LINGER_MS', DEFAULT_STATUS_LINGER_MS),
    );
    scheduleStatusClear(ctx);

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
      durationMs: Date.now() - start,
      stopReason,
      workspace: { isolation: workspaceIsolation, worktreePath },
      childSessionId,
      childSessionFile,
      error: stopReason === 'error' ? (agg.errorFromChild ?? childError) : undefined,
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

      await acquire(semaphore, concurrencyLimit);
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
        release(semaphore);
      }

      // Parent-side audit + a collapsible `subagent-run` custom message
      // in the transcript so the TUI renders the run summary inline.
      try {
        pi.appendEntry(SUBAGENT_CUSTOM_TYPE, out.details);
      } catch {
        // appendEntry can throw before the session is fully bound.
      }
      try {
        pi.sendMessage({
          customType: SUBAGENT_CUSTOM_TYPE,
          content: out.content,
          display: true,
          details: out.details,
        });
      } catch {
        // The tool result itself still reaches the parent model; the
        // custom-message entry is purely a TUI aide.
      }

      // Optional JSON parsing of the returned payload.
      if (params.returnFormat === 'json') {
        try {
          JSON.parse(out.content);
        } catch {
          // Silently fall through: the raw text still reaches the
          // parent model and the details carry the stop reason.
        }
      }

      return {
        content: [{ type: 'text', text: out.content }],
        details: out.details,
        isError: out.isError,
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
