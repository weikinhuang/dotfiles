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
 *   - Companion `/agents` command lists loaded agent definitions
 *     (`/agents`), shows one (`/agents show <name>`), or lists active
 *     background children (`/agents running`).
 *
 * Environment:
 *   PI_SUBAGENT_DISABLED=1              skip the extension entirely
 *   PI_SUBAGENT_DEBUG=1                 surface every child lifecycle event via ctx.ui.notify
 *   PI_SUBAGENT_CONCURRENCY=N           max concurrent children (default 4, floor 1, ceiling 8)
 *   PI_SUBAGENT_NO_PERSIST=1            use SessionManager.inMemory() instead of disk-backed sessions
 *   PI_SUBAGENT_SESSION_ROOT=<path>     override <piAgentDir>/sessions as the session root
 *   PI_SUBAGENT_RETAIN_DAYS=N           retain child session files for N days (default 30)
 *   PI_SUBAGENT_STATUS_LINGER_MS=N      keep completed status visible for N ms (default 5000)
 *   PI_SUBAGENT_MAX_TURNS=N             global max-turns cap (wins over per-agent setting)
 *   PI_SUBAGENT_TIMEOUT_MS=N            global wall-clock cap (wins over per-agent setting)
 *   PI_SUBAGENT_MODEL=provider/id       global model override applied to every child
 *   PI_SUBAGENT_BG_MAX=N                max entries retained in the background registry (default 32)
 *   PI_SUBAGENT_BG_SHUTDOWN_MS=N        wall-clock cap on the shutdown abort-and-dispose loop (default 2000)
 *
 * Commands:
 *   /agents              list every loaded agent with its source layer
 *   /agents show <name>  print full frontmatter + body of agent <name>
 *   /agents running      list active background sub-agents + their snapshots
 *
 * Pure helpers live under `../../../lib/node/pi/subagent-*.ts` so they
 * can be unit-tested under vitest without the pi runtime.
 */

import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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
import { matchesKey, Text, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  getSessionSubagentAggregate,
  makeChildToolAggregate,
  recordToolCall,
  snapshotByTool,
  type ChildToolAggregate,
} from '../../../lib/node/pi/subagent/aggregate.ts';
import {
  ActivityRing,
  activityPushModeFor,
  applyActivityLine,
  formatActivityLine,
  getSessionActivityRings,
  makeActivityState,
  tailJsonl,
  type ActivityEvent,
} from '../../../lib/node/pi/subagent/activity.ts';
import {
  formatAgentListDescription,
  formatAgentListRowDescription,
  formatAgentPreview,
  formatParallelSubagentStatus,
  formatRunningChildRow,
  formatRunningChildrenList,
  formatSpawnMessage,
  formatSubagentScorecard,
  formatSubagentStatus,
  scorecardGlyph,
  subagentDetailsToSnapshot,
  type AgentPreviewSource,
  type RunningChildListItem,
  type ScorecardStopReason,
  type SubagentRunSnapshot,
} from '../../../lib/node/pi/subagent/format.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { makeHandleCounter, resolveHandle } from '../../../lib/node/pi/subagent/handle.ts';
import { AGENTS_USAGE } from '../../../lib/node/pi/subagent/usage.ts';
import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import {
  type AgentDef,
  type AgentLoadResult,
  type AgentLoadWarning,
  defaultAgentLayers,
  loadAgents,
  makeNodeReadLayer,
} from '../../../lib/node/pi/subagent/loader.ts';
import {
  classifyStopReason,
  extractFinalAssistantText,
  type AgentMessageLike,
} from '../../../lib/node/pi/subagent/result.ts';
import {
  childSessionDir,
  subagentSessionRoot,
  sweepStaleSessions,
  type SweepFs,
} from '../../../lib/node/pi/subagent/session-paths.ts';
import {
  createWorktree,
  removeWorktree,
  sweepStaleWorktrees,
  type CreatedWorktree,
} from '../../../lib/node/pi/subagent/worktree.ts';
import { resolveChildModel } from '../../../lib/node/pi/subagent/spawn.ts';
import { resolveMaxTurns } from '../../../lib/node/pi/subagent/budget.ts';
import { type SubagentConfig, loadSubagentConfig } from '../../../lib/node/pi/subagent/config.ts';
import { collectSubagentInjections } from '../../../lib/node/pi/subagent/extension-injection.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { resolveWriteRoots } from '../../../lib/node/pi/persona/resolve.ts';
import { Semaphore } from '../../../lib/node/pi/semaphore.ts';
import { setActiveAgent, clearActiveAgent } from '../../../lib/node/pi/subagent/active-agent.ts';
import { createAgentGateFactory } from '../../../lib/node/pi/subagent/agent-gate.ts';
import { collapseWhitespace } from '../../../lib/node/pi/shared.ts';
import { formatHeaderRule } from '../../../lib/node/pi/tui-rule.ts';

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

interface SubagentParamsT {
  agent: string;
  task: string;
  modelOverride?: string;
  maxTurns?: number;
  returnFormat?: 'text' | 'json';
  run_in_background?: boolean;
}

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
    errorFromChild: undefined,
    tools: makeChildToolAggregate(),
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
// /agents overlay primitives
// ──────────────────────────────────────────────────────────────────────

/**
 * Loaded-list overlay rendered by `/agents`. Two horizontal rules
 * separate a row list (top) from a preview block (bottom); selection
 * is driven by the arrow keys, escape closes.
 */
class AgentsLoadedOverlay implements Component {
  private agents: AgentPreviewSource[];
  private selected = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    agents: AgentPreviewSource[],
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {
    this.agents = agents;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.onClose();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.move(1);
      return;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private move(delta: number): void {
    if (this.agents.length === 0) return;
    this.selected = Math.max(0, Math.min(this.agents.length - 1, this.selected + delta));
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [''];

    const count = this.agents.length;
    const chip = count > 0 ? `${count} agent${count === 1 ? '' : 's'}` : undefined;
    lines.push(truncateToWidth(formatHeaderRule('Loaded sub-agents', chip, width, th), width));
    lines.push('');

    if (count === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg('dim', 'No agents loaded. Drop Markdown definitions into <piAgentDir>/agents/.')}`,
          width,
        ),
      );
      lines.push('');
      lines.push(truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width));
      lines.push('');
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    const maxName = this.agents.reduce((m, a) => Math.max(m, a.name.length), 0);
    const sourcePad = '[global] '.length; // widest tag with trailing space
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const marker = i === this.selected ? th.fg('accent', '>') : ' ';
      const namePad = ' '.repeat(Math.max(1, maxName + 2 - a.name.length));
      const sourceTag = `[${a.source}]`;
      const sourceSeg = th.fg('muted', sourceTag + ' '.repeat(Math.max(1, sourcePad - sourceTag.length)));
      const desc = formatAgentListRowDescription(a.description);
      const styled = i === this.selected ? th.fg('text', a.name) : th.fg('dim', a.name);
      const row = `  ${marker} ${styled}${namePad}${sourceSeg} ${th.fg('dim', desc)}`;
      lines.push(truncateToWidth(row, width));
    }

    const selected = this.agents[this.selected];
    lines.push('');
    lines.push(
      truncateToWidth(formatHeaderRule(`${selected.name}  [${selected.source}]`, undefined, width, th), width),
    );
    lines.push('');
    for (const previewLine of formatAgentPreview(selected)) {
      // First line is the path (dim); the rest of the body is text-tone.
      const styled = previewLine.startsWith('/') ? th.fg('dim', previewLine) : th.fg('text', previewLine);
      lines.push(truncateToWidth(`  ${styled}`, width));
    }
    lines.push('');
    lines.push(truncateToWidth(`  ${th.fg('dim', '↑/↓ move · Press Escape to close')}`, width));
    lines.push('');

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

/**
 * Running-children overlay rendered by `/agents running`. Live tick
 * every 1 s; each row block lays out handle, agent, state, elapsed,
 * `turn N/max`, token line, ctx bar, model, and (optional) tool counts.
 * Below the row list, a preview block summarises the highlighted child
 * + renders the bounded activity-tail ring.
 */
interface RunningOverlayEntry {
  handle: string;
  agent: string;
  agentSource?: 'global' | 'user' | 'project';
  task: string;
  snapshot: SubagentRunSnapshot;
  startedAt: number;
  /** Wall-clock millis of the last `pushStatus` call. */
  lastUpdateMs: number;
  /** True while the entry is live; false for terminal children. */
  running: boolean;
  /** Path to the child's JSONL transcript on disk (for the disk-tail fallback). */
  sessionFile: string | undefined;
}

const RUNNING_TICK_MS = 1000;

function fmtDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function capLine(s: string, cap: number): string {
  const collapsed = collapseWhitespace(s);
  if (collapsed.length <= cap) return collapsed;
  return `${collapsed.slice(0, cap - 1).trimEnd()}…`;
}

class AgentsRunningOverlay implements Component {
  private selected = 0;
  /** `f` toggles freeze for the highlighted child's activity tail. */
  private frozenHandles = new Set<string>();
  /** Cached width / lines so static frames don't redraw on every tick. */
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly getEntries: () => RunningOverlayEntry[],
    private readonly rings: Map<string, ActivityRing>,
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.onClose();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.move(1);
      return;
    }
    if (data === 'f') {
      this.toggleFreeze();
      return;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private move(delta: number): void {
    const entries = this.getEntries();
    if (entries.length === 0) return;
    this.selected = Math.max(0, Math.min(entries.length - 1, this.selected + delta));
    this.invalidate();
  }

  private toggleFreeze(): void {
    const entries = this.getEntries();
    if (entries.length === 0) return;
    const handle = entries[Math.min(this.selected, entries.length - 1)].handle;
    const ring = this.rings.get(handle);
    if (!ring) return;
    if (this.frozenHandles.has(handle)) {
      this.frozenHandles.delete(handle);
      ring.resume();
    } else {
      this.frozenHandles.add(handle);
      ring.freeze();
    }
    this.invalidate();
  }

  render(width: number): string[] {
    // We cannot cache by width alone because the live tick changes the
    // payload. Each render rebuilds; the overlay sits behind a 1 s
    // request-render tick so cost is negligible.
    void this.cachedWidth;
    void this.cachedLines;

    const th = this.theme;
    const entries = this.getEntries();
    const now = Date.now();
    const lines: string[] = [''];

    const chip = entries.length === 0 ? '0 active' : `${entries.length} active · ${RUNNING_TICK_MS}ms`;
    lines.push(truncateToWidth(formatHeaderRule('Running sub-agents', chip, width, th), width));
    lines.push('');

    if (entries.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg('dim', 'No background sub-agents running.')}`, width));
      lines.push('');
      lines.push(truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width));
      lines.push('');
      return lines;
    }

    if (this.selected >= entries.length) this.selected = entries.length - 1;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const marker = i === this.selected ? th.fg('accent', '>') : ' ';
      const rowLines = formatRunningChildRow({ handle: e.handle, snapshot: e.snapshot, startedAt: e.startedAt }, now, {
        width,
      });
      lines.push(truncateToWidth(`  ${marker} ${th.fg('text', rowLines[0])}`, width));
      for (let j = 1; j < rowLines.length; j++) {
        lines.push(truncateToWidth(`    ${th.fg('dim', rowLines[j])}`, width));
      }
    }

    const sel = entries[this.selected];
    lines.push('');
    lines.push(truncateToWidth(formatHeaderRule(`${sel.handle}  ${sel.agent}`, undefined, width, th), width));
    lines.push('');
    if (sel.task) {
      const taskWrap = capLine(sel.task, Math.max(40, width - 14));
      lines.push(truncateToWidth(`  ${th.fg('muted', 'task    ')}${th.fg('text', taskWrap)}`, width));
    }
    const spawnedAgo = fmtDurationShort(Math.max(0, now - sel.startedAt));
    const updateAgo = fmtDurationShort(Math.max(0, now - sel.lastUpdateMs));
    lines.push(
      truncateToWidth(
        `  ${th.fg('muted', 'spawned ')}${spawnedAgo} ago${' '.repeat(4)}${th.fg('muted', 'last update ')}${updateAgo} ago`,
        width,
      ),
    );

    // Activity tail
    const ring = this.rings.get(sel.handle);
    const frozen = this.frozenHandles.has(sel.handle);
    const live = sel.running && !frozen;
    const tailChip = frozen ? 'tail · frozen' : sel.running ? `tail · ${RUNNING_TICK_MS}ms · live` : 'tail · final';
    lines.push('');
    lines.push(truncateToWidth(formatHeaderRule('activity', tailChip, width, th), width));
    lines.push('');
    const tailLines = ring ? ring.snapshot() : sel.sessionFile ? tailJsonl(sel.sessionFile, { maxLines: 32 }) : [];
    if (tailLines.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg('dim', '(no activity yet)')}`, width));
    } else {
      for (const tl of tailLines.slice(-12)) {
        lines.push(truncateToWidth(`  ${th.fg('dim', tl)}`, width));
      }
    }

    lines.push('');
    lines.push(truncateToWidth(`  ${th.fg('dim', '↑/↓ move · f freeze tail · Press Escape to close')}`, width));
    lines.push('');
    void live;
    return lines;
  }
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
  // captured once below (changing it mid-session needs /reload).
  let subagentConfig: SubagentConfig = loadSubagentConfig(process.cwd());

  // Process-wide concurrency semaphore. Limit is captured once at
  // registration; changing concurrency (config file or
  // `PI_SUBAGENT_CONCURRENCY`) mid-session requires /reload.
  const semaphore = new Semaphore(subagentConfig.concurrency);

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
    /** Flipped by subagent_send({action:'abort'}) so the classifier picks `aborted`. */
    externallyAborted: boolean;
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
    };
  };

  const pruneBackgroundRegistry = (): void => {
    const cap = envPositiveInt('PI_SUBAGENT_BG_MAX', DEFAULT_BG_REGISTRY_CAP);
    if (backgroundChildren.size <= cap) return;
    // Evict completed entries in insertion order first; leave running
    // entries alone. Map iteration order is insertion order.
    const toDrop: string[] = [];
    let overflow = backgroundChildren.size - cap;
    for (const [handle, entry] of backgroundChildren) {
      if (overflow <= 0) break;
      if (!entry.running) {
        toDrop.push(handle);
        overflow--;
      }
    }
    for (const h of toDrop) backgroundChildren.delete(h);
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
    const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
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
    reload(ctx.cwd);
    // Re-resolve config from the real session cwd so a project-local
    // <cwd>/.pi/subagent.json takes effect. `concurrency` is intentionally
    // not re-applied to the already-constructed semaphore (needs /reload),
    // matching the prior PI_SUBAGENT_CONCURRENCY behaviour.
    subagentConfig = loadSubagentConfig(ctx.cwd);
    surfaceWarnings(ctx, loadResult.warnings);
    handleCounter.reset();
    backgroundChildren.clear();
    // Drop any subagent totals from a previous session so the
    // statusline Σ(N):… segment starts fresh for this parent session.
    getSessionSubagentAggregate().reset();
    // Sweep stale worktrees + old child session files from prior (possibly
    // crashed) runs. Both helpers are best-effort and silent on failure.
    const wtSwept = sweepStaleWorktrees(ctx.cwd, makeSweepFs());
    if (debug && wtSwept.swept > 0) ctx.ui.notify(`subagent: swept ${wtSwept.swept} stale worktree(s)`, 'info');
    const retain = envPositiveInt('PI_SUBAGENT_RETAIN_DAYS', DEFAULT_RETAIN_DAYS);
    const swept = sweepStaleSessions(subagentSessionRoot(), retain, makeSweepFs());
    if (debug && swept.removed > 0) ctx.ui.notify(`subagent: swept ${swept.removed} stale session file(s)`, 'info');
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // Drain running background children first. We fire `abort()` on
    // each and wait up to PI_SUBAGENT_BG_SHUTDOWN_MS total for their
    // drive() loops to settle - this gives them a chance to dispose
    // cleanly + cleanup worktrees. If the deadline passes, we fall
    // through and let GC handle the rest; disposal may be incomplete
    // but shutdown must never hang.
    const drainDeadlineMs = envPositiveInt('PI_SUBAGENT_BG_SHUTDOWN_MS', DEFAULT_BG_SHUTDOWN_MS);
    const pending: Promise<unknown>[] = [];
    for (const entry of backgroundChildren.values()) {
      if (!entry.running) continue;
      entry.externallyAborted = true;
      try {
        void entry.session.abort();
      } catch {
        // best-effort
      }
      pending.push(entry.completion);
    }
    if (pending.length > 0) {
      void Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => setTimeout(resolve, drainDeadlineMs)),
      ]);
    }

    // Happy-path sweep. Both sweeps are best-effort - shutdown must
    // not block or throw.
    try {
      sweepStaleWorktrees(ctx.cwd, makeSweepFs());
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
    warnings.reset();
    runningChildren.clear();
    for (const t of lingerTimers) clearTimeout(t);
    lingerTimers.clear();
    backgroundChildren.clear();
    handleCounter.reset();
    getSessionActivityRings().clear();
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
        'What the sub-agent should do. Be specific - the sub-agent starts with NO context from this conversation. ' +
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
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          'Launch the sub-agent in the background and return a handle immediately. ' +
          'Use `subagent_send` to poll, steer, or await completion. ' +
          'Defaults to false (synchronous - the parent turn blocks until the child finishes).',
      }),
    ),
    maxTurns: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1000,
        description:
          "Optional `maxTurns` cap for this dispatch. Default is whatever the agent's `.md` declares (20 for `general-purpose` as of today). Raise when delegating a known multi-file implementation that exceeds the default. Bounded by `PI_SUBAGENT_MAX_TURNS` if set.",
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
          'What to do with the referenced subagent. `status` (default when `text` is omitted) returns the latest snapshot. `wait` blocks until the child completes and returns the final answer. `abort` cancels a running child. Providing `text` without `action` steers the running child.',
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
    ctx: ExtensionContext;
    parentSignal: AbortSignal | undefined;
    /** When true, the caller owns the semaphore release - drive() skips it. */
    background: boolean;
  }): Promise<SpawnResult> {
    const { agent, task, modelOverride, maxTurnsOverride, ctx, parentSignal, background } = args;
    const start = Date.now();
    const agg = makeAggregate();

    // ── Model resolution ──────────────────────────────────────────────
    // Shared with the iteration-loop's critic spawn via
    // lib/node/pi/subagent/spawn.ts::resolveChildModel. Both extensions
    // surface the same diagnostic strings so users see consistent
    // messages; keeping the resolver in one place prevents drift.
    // Per-call override wins, then the config layer
    // (project > user > PI_SUBAGENT_MODEL env), then inherit.
    const modelSpecStr = modelOverride ?? subagentConfig.model;
    const modelResolution = resolveChildModel({
      override: modelSpecStr,
      agent,
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
    // gets cleaned up on any failure - the prior split let a
    // `resourceLoader.reload()` throw bypass the cleanup path.
    const noPersist = envTruthy(process.env.PI_SUBAGENT_NO_PERSIST);
    const sessionDir = childSessionDir({
      parentCwd: ctx.cwd,
      parentSessionId: ctx.sessionManager.getSessionId(),
    });
    // SessionManager.create will mkdir the sessionDir lazily on first write.
    const childSessionManager = noPersist
      ? SessionManager.inMemory(childCwd)
      : SessionManager.create(childCwd, sessionDir);

    let child: AgentSession;
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
        extensionFactories: [
          // Global subagent-injection registry first - parent-side
          // security gates (bash-permissions, filesystem) register
          // hook-only factories there so child bash / read / write
          // calls go through the same gates as the parent. The
          // per-agent gate runs LAST so its agent-specific
          // bashAllow / bashDeny / writeRoots can override (last
          // tool_call handler wins on the same event).
          ...(collectSubagentInjections() as unknown as ExtensionFactory[]),
          agentGateFactory as unknown as ExtensionFactory,
        ] satisfies ExtensionFactory[],
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
      clearActiveAgent();
      return {
        kind: 'error',
        result: cleanupAndError({
          agent,
          task,
          durationMs: Date.now() - start,
          error: e instanceof Error ? e.message : String(e),
          worktree,
          parentCwd: ctx.cwd,
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
    let reachedMaxTurns = false;
    // We trigger `child.abort()` ourselves on maxTurns, timeout, or parent
    // signal - any of those counts as an "aborted" outcome even though
    // `parentSignal.aborted` stays false for the first two.
    let abortedByUs = false;

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
      externallyAborted: false,
    };

    const pushStatus = (state: SubagentRunSnapshot['state'], opts?: { durationMs?: number }): void => {
      const snap = makeSnapshot(state, opts);
      entry.snapshot = snap;
      runningChildren.set(childSessionId, snap);
      updateStatus(ctx);
    };

    pushStatus('running');

    // Per-handle activity ring + cursor state. The overlay reads the
    // ring via `getSessionActivityRings()` so it survives jiti
    // re-evaluation of this extension module. State + ring are dropped
    // in `drive()`'s finally so the registry doesn't accumulate handles
    // across long-running sessions.
    const activityRing = new ActivityRing({ capacity: 64 });
    const activityState = makeActivityState();
    getSessionActivityRings().set(handle, activityRing);

    const unsubscribe = child.subscribe((event: AgentSessionEvent) => {
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
    // Background children outlive the parent's tool-call turn by
    // design, so wiring parentSignal to them would abort the child as
    // soon as the spawning turn wraps up. Only synchronous calls chain
    // the turn-scoped signal.
    const listenToParent = !background;
    const parentAbortHandler = (): void => {
      abortedByUs = true;
      void child.abort();
    };
    if (listenToParent) parentSignal?.addEventListener('abort', parentAbortHandler, { once: true });

    const drive = async (): Promise<RunChildResult> => {
      let childError: Error | undefined;
      try {
        await child.prompt(task);
      } catch (e) {
        childError = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timeoutHandle);
        if (listenToParent) parentSignal?.removeEventListener('abort', parentAbortHandler);
        unsubscribe();
      }

      // AbortError may arrive as a thrown DOMException, an Error whose
      // `name` is `AbortError`, or no throw at all (pi may swallow it).
      // `abortedByUs` covers timeout, maxTurns, parent-signal, and
      // subagent_send({action:'abort'}) paths; `parentSignal.aborted`
      // covers the rare case where the parent aborted between our
      // listener firing and `removeEventListener` (sync path only).
      const errorIsAbort =
        childError !== undefined && (childError.name === 'AbortError' || /abort/i.test(childError.message ?? ''));
      const aborted =
        abortedByUs || entry.externallyAborted || (listenToParent && parentSignal?.aborted === true) || errorIsAbort;
      const hasRealError = childError !== undefined && !errorIsAbort;
      const stopReason = classifyStopReason({
        reachedMaxTurns,
        aborted: aborted && !reachedMaxTurns,
        error: !reachedMaxTurns && !aborted && (hasRealError || agg.errorFromChild !== undefined),
      });

      // ── Extract final answer text + terminate child ─────────────────
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
      clearActiveAgent();

      // ── Cleanup the worktree (if any) ───────────────────────────────
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
      // Contribute this run's totals to the session-wide subagent
      // aggregate so the statusline's line-2 Σ(N):… segment reflects
      // the cumulative cost of delegated work. We intentionally count
      // errored / aborted / max_turns runs too (with `failed: true`)
      // - tokens + cost were still spent and users want to see them.
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
        handle,
        error: stopReason === 'error' ? (agg.errorFromChild ?? childError?.message) : undefined,
        maxTurns,
        byTool: snapshotByTool(agg.tools),
        contextTokens: agg.contextTokens > 0 ? agg.contextTokens : undefined,
        contextWindow: childModel?.contextWindow,
      };

      const result: RunChildResult = {
        content: finalText,
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

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: toolDescription(),
    promptSnippet:
      'Delegate a subtask to a fresh sub-agent session so intermediate exploration stays out of your context.',
    promptGuidelines: [
      'Use `subagent` when the next step would read many files, run a broad `grep`, or otherwise produce intermediate noise you will not use yourself. Prefer the `explore` agent for read-only discovery and the `plan` agent for implementation planning.',
      'The sub-agent starts with no context - describe the goal, constraints, and desired output shape inside `task`.',
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

      const background = params.run_in_background === true;

      await semaphore.acquire();

      let spawn: SpawnResult;
      try {
        spawn = await spawnChild({
          agent,
          task: params.task,
          modelOverride: params.modelOverride,
          maxTurnsOverride: params.maxTurns,
          ctx,
          parentSignal: signal,
          background,
        });
      } catch (e) {
        semaphore.release();
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
            stopReason: 'error',
            error: err,
          } satisfies SubagentDetails,
          isError: true,
        };
      }

      if (spawn.kind === 'error') {
        semaphore.release();
        return {
          content: [{ type: 'text', text: spawn.result.content }],
          details: spawn.result.details,
          isError: true,
        };
      }

      const { entry, drive } = spawn;

      if (background) {
        // Background spawns return immediately with `stopReason: 'spawned'`
        // so the parent renderResult picks the `⏳` glyph from
        // `scorecardGlyph` rather than falling through to the error
        // glyph (`✗`). The actual `drive()` outcome - with a real
        // stopReason - lands on the entry once it settles.
        const spawnedDetails: SubagentDetails = {
          ...entryToRunningDetails(entry),
          stopReason: 'spawned',
        };
        // Kick drive() off into the void. Semaphore release + audit
        // entry happen inside the async IIFE once drive() settles.
        // Completion promise is wired BEFORE the registry insert so
        // `subagent_send({ action: "wait" })` can never observe the
        // placeholder promise.
        entry.completion = (async () => {
          let result: RunChildResult;
          try {
            result = await drive();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const durationMs = Date.now() - entry.startedAt;
            result = {
              content: `subagent ${agent.name}: drive failed - ${msg}`,
              details: {
                agent: agent.name,
                agentSource: agent.source,
                task: params.task,
                model: ctx.model?.id,
                turns: entry.snapshot.turns,
                tokens: {
                  input: entry.snapshot.input,
                  cacheRead: entry.snapshot.cacheRead,
                  cacheWrite: 0,
                  output: entry.snapshot.output,
                },
                cost: entry.snapshot.cost,
                durationMs,
                stopReason: 'error',
                childSessionId: entry.childSessionId,
                childSessionFile: entry.childSessionFile,
                handle: entry.handle,
                error: msg,
              },
              isError: true,
            };
            entry.running = false;
            entry.outcome = result;
          }
          if (!entry.semaphoreReleased) {
            semaphore.release();
            entry.semaphoreReleased = true;
          }
          try {
            pi.appendEntry(SUBAGENT_CUSTOM_TYPE, result.details);
          } catch {
            // appendEntry can throw before the session is fully bound.
          }
          return result;
        })();

        backgroundChildren.set(entry.handle, entry);
        pruneBackgroundRegistry();

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

      // ── Synchronous path ────────────────────────────────────────────
      // Register in background map too so `subagent_send` can still
      // read finished runs (and so that /agents running shows
      // currently-streaming sync calls). Completion promise is wired
      // before the registry insert to match the background path.
      entry.completion = drive();
      backgroundChildren.set(entry.handle, entry);
      let out: RunChildResult;
      try {
        out = await entry.completion;
      } finally {
        if (!entry.semaphoreReleased) {
          semaphore.release();
          entry.semaphoreReleased = true;
        }
      }

      // Parent-side audit entry so /fork, /tree, and session-usage can
      // see delegated runs without scanning message bodies. We do NOT
      // also call pi.sendMessage() for the run: pi's convertToLlm
      // serializes `custom` messages as synthetic `user` turns, which
      // would double the prompt tokens the parent bills for the same
      // content that's already in the tool_result.
      try {
        pi.appendEntry(SUBAGENT_CUSTOM_TYPE, out.details);
      } catch {
        // appendEntry can throw before the session is fully bound.
      }

      pruneBackgroundRegistry();

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
      const a = args as SubagentParamsT;
      const name = a.agent || '(no agent)';
      const preview = a.task ? (a.task.length > 80 ? `${a.task.slice(0, 80)}…` : a.task) : '';
      let text = `${theme.fg('toolTitle', theme.bold('subagent '))}${theme.fg('accent', name)}`;
      if (preview) text += `\n  ${theme.fg('dim', preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<SubagentDetails>;
      const stopReason: ScorecardStopReason = (details.stopReason as ScorecardStopReason | undefined) ?? 'spawned';
      const lead = renderScorecard({
        theme,
        agent: details.agent ?? '(agent)',
        agentSource: details.agentSource,
        handle: details.handle,
        stopReason,
        snapshot: subagentDetailsToSnapshot(details, stopReason),
        // For successful background spawns we want a "spawned in background"
        // suffix so the card visually mirrors the toast text.
        leadSuffix: stopReason === 'spawned' ? 'spawned in background' : undefined,
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
    promptGuidelines: [
      'Use `subagent_send({ to, action: "wait" })` to retrieve the final answer of a background child once it has had time to make progress.',
      'Use `subagent_send({ to, action: "status" })` for a cheap progress check that does not block.',
      'Use `subagent_send({ to, text: "…" })` to inject additional guidance into a still-running child.',
      'Only the parent session can call this tool - it is not exposed to sub-agents.',
    ],
    parameters: SubagentSendParams,
    executionMode: 'parallel',

    async execute(_toolCallId, rawParams, signal, _onUpdate, _ctx) {
      const params = rawParams as unknown as SubagentSendParamsT;
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
        entry.externallyAborted = true;
        try {
          await entry.session.abort();
        } catch {
          // abort is best-effort - drive() will observe the aborted flag.
        }
        // Wait briefly for drive to settle so we return a stable snapshot.
        try {
          await Promise.race([entry.completion, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
        } catch {
          // completion promises never reject in our shape, but be defensive.
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
        const result = await Promise.race<{ kind: 'completed'; result: RunChildResult } | { kind: 'aborted' }>([
          entry.completion.then((r) => ({ kind: 'completed', result: r })),
          new Promise((resolve) => {
            if (!signal) return;
            if (signal.aborted) resolve({ kind: 'aborted' });
            else signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
          }),
        ]);
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
      return {
        content: [{ type: 'text', text: formatSubagentStatus(entry.snapshot) }],
        details: entry.outcome?.details ?? entryToRunningDetails(entry),
        isError: false,
      };
    },

    renderCall(args, theme, _context) {
      const a = args as SubagentSendParamsT;
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
        stopReason = (details.stopReason as ScorecardStopReason | undefined) ?? 'completed';
      } else {
        // `send` (steering) keeps today's pi default rendering - mirror
        // it by collapsing to the lead line only.
        stopReason = (details.stopReason as ScorecardStopReason | undefined) ?? 'running';
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
    description: 'Inspect loaded sub-agents and active background children',
    getArgumentCompletions: (prefix) => {
      const arg = prefix.trim();
      if (arg === '' || 'show'.startsWith(arg) || 'running'.startsWith(arg)) {
        const out: { value: string; label: string; description: string }[] = [];
        if (arg === '' || 'show'.startsWith(arg)) {
          out.push({ value: 'show', label: 'show', description: 'Show full frontmatter + body for an agent' });
        }
        if (arg === '' || 'running'.startsWith(arg)) {
          out.push({ value: 'running', label: 'running', description: 'List active background sub-agents' });
        }
        return out;
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
      if (isHelpArg(args)) {
        ctx.ui.notify(AGENTS_USAGE, 'info');
        return;
      }
      const raw = (args ?? '').trim();
      reload(ctx.cwd);
      surfaceWarnings(ctx, loadResult.warnings);

      if (raw === 'running') {
        // Live overlay of active background children, auto-refreshing on a
        // RUNNING_TICK_MS timer. Falls back to a flat notify when the host
        // lacks UI (print / rpc modes).
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
        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          overlay = new AgentsRunningOverlay(buildEntries, rings, theme, () => {
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

      const match = /^show\s+(\S+)$/.exec(raw);
      if (match) {
        const name = match[1];
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

      if (raw && raw !== 'list') {
        ctx.ui.notify('subagent: usage: /agents [list] | /agents show <name> | /agents running', 'warning');
        return;
      }

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

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => new AgentsLoadedOverlay(agents, theme, () => done()));
    },
  });
}
