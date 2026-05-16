/**
 * Formatting helpers for the subagent extension.
 *
 * Pure module - no pi imports - so it can be unit-tested under `vitest`.
 * Lives alongside `subagent-loader.ts` / `subagent-result.ts` because the
 * three types share the same `AgentDef` shape and aren't useful apart.
 *
 * Two kinds of output:
 *
 * 1. **Agent-list description** embedded in the `subagent` tool's
 *    `agent` parameter description, so the LLM sees available agents +
 *    their "when to use" blurbs as autocomplete candidates.
 * 2. **Running / completed status lines** fed to
 *    `ctx.ui.setStatus('subagent', …)`, which the parent statusline
 *    already renders on line 3. Parallel children collapse into one
 *    aggregate line.
 */

import { fmtCost, fmtSi } from './token-format.ts';

export interface AgentListItem {
  name: string;
  description: string;
  source?: 'global' | 'user' | 'project';
}

const SHORT_DESCRIPTION_CAP = 160;

function shorten(s: string, cap: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= cap) return collapsed;
  return `${collapsed.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * Build the `agent` param's description string. Agents are listed
 * alphabetically with the source layer tagged so users see which
 * override is in play at a glance. Used by the extension when calling
 * `pi.registerTool` - baked in at startup.
 */
export function formatAgentListDescription(items: readonly AgentListItem[]): string {
  if (items.length === 0) {
    return 'Sub-agent type name. No agent definitions loaded - drop Markdown files into `~/.pi/agents/` or `.pi/agents/`.';
  }
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const maxName = sorted.reduce((m, a) => Math.max(m, a.name.length), 0);
  const lines: string[] = ['Sub-agent type name. Available:'];
  for (const a of sorted) {
    const pad = ' '.repeat(Math.max(1, maxName + 2 - a.name.length));
    const sourceTag = a.source && a.source !== 'global' ? ` [${a.source}]` : '';
    lines.push(`  ${a.name}${pad}- ${shorten(a.description, SHORT_DESCRIPTION_CAP)}${sourceTag}`);
  }
  return lines.join('\n');
}

export type SubagentRunState = 'running' | 'completed' | 'error' | 'aborted' | 'max_turns';

export interface SubagentRunSnapshot {
  agent: string;
  state: SubagentRunState;
  model?: string;
  turns: number;
  input: number;
  cacheRead: number;
  output: number;
  cost: number;
  /** Context tokens for the child, or undefined before any assistant message. */
  contextTokens?: number;
  /** Context window of the child's model. */
  contextWindow?: number;
  durationMs?: number;
}

function stateGlyph(state: SubagentRunState): string {
  switch (state) {
    case 'running':
      return '⏳';
    case 'completed':
      return '✓';
    case 'error':
      return '✗';
    case 'aborted':
      return '⚠';
    case 'max_turns':
      return '∎';
  }
}

function fmtDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * One-line status rendered into `ctx.ui.setStatus('subagent', …)`.
 * Mirrors the main statusline's line-2 style so the two read the same
 * way.
 *
 * Format while running:
 *   `subagent:explore ⏳ M(2):↑320/↻ 2.1k/↓180 R 87% $0.004 ctx:8% model:qwen3`
 *
 * Format after completion:
 *   `subagent:explore ✓ 3 turns ↑1.2k ↻ 5.4k ↓410 $0.013 4.2s`
 */
export function formatSubagentStatus(snap: SubagentRunSnapshot): string {
  const head = `subagent:${snap.agent} ${stateGlyph(snap.state)}`;
  const parts: string[] = [head];
  if (snap.state === 'running') {
    const label = snap.turns > 0 ? `M(${snap.turns})` : 'M';
    const denom = snap.input + snap.cacheRead;
    const ratio = denom > 0 ? ` R ${Math.round((snap.cacheRead / denom) * 100)}%` : '';
    parts.push(`${label}:↑${fmtSi(snap.input)}/↻ ${fmtSi(snap.cacheRead)}/↓${fmtSi(snap.output)}${ratio}`);
    if (snap.cost > 0) parts.push(fmtCost(snap.cost));
    if (snap.contextTokens != null && snap.contextWindow && snap.contextWindow > 0) {
      const pct = Math.min(100, Math.round((snap.contextTokens / snap.contextWindow) * 100));
      parts.push(`ctx:${pct}%`);
    }
    if (snap.model) parts.push(`model:${snap.model}`);
  } else {
    if (snap.turns > 0) parts.push(`${snap.turns} turn${snap.turns === 1 ? '' : 's'}`);
    if (snap.input > 0) parts.push(`↑${fmtSi(snap.input)}`);
    if (snap.cacheRead > 0) parts.push(`↻ ${fmtSi(snap.cacheRead)}`);
    if (snap.output > 0) parts.push(`↓${fmtSi(snap.output)}`);
    if (snap.cost > 0) parts.push(fmtCost(snap.cost));
    if (snap.durationMs != null) {
      const d = fmtDurationShort(snap.durationMs);
      if (d) parts.push(d);
    }
  }
  return parts.join(' ');
}

const TASK_PREVIEW_CAP = 80;

/**
 * Human-readable message the `subagent` tool returns when the parent
 * passes `run_in_background: true`. Embeds the handle the parent must
 * use to talk to `subagent_send` later.
 */
export function formatSpawnMessage(args: { handle: string; agent: string; task: string }): string {
  const preview = shorten(args.task, TASK_PREVIEW_CAP);
  return [
    'subagent spawned in background.',
    `  handle: ${args.handle}`,
    `  agent:  ${args.agent}`,
    `  task:   ${preview}`,
    'Use `subagent_send` to check status, steer, or retrieve the result.',
  ].join('\n');
}

export interface RunningChildListItem {
  handle: string;
  snapshot: SubagentRunSnapshot;
  startedAt: number;
}

/**
 * Multi-line list rendered by `/agents running`. One child per line,
 * handle + the same status line the parent statusline uses. Empty list
 * returns a single "nothing active" message so callers can pass the
 * output straight to `ctx.ui.notify`.
 */
export function formatRunningChildrenList(entries: readonly RunningChildListItem[], now: number = Date.now()): string {
  if (entries.length === 0) return 'No background sub-agents running.';
  const sorted = [...entries].sort((a, b) => a.startedAt - b.startedAt);
  const maxHandle = sorted.reduce((m, e) => Math.max(m, e.handle.length), 0);
  const lines: string[] = ['Background sub-agents:'];
  for (const e of sorted) {
    const pad = ' '.repeat(Math.max(1, maxHandle + 2 - e.handle.length));
    const elapsed = Math.max(0, now - e.startedAt);
    // formatSubagentStatus renders durationMs only for non-running
    // states. Append elapsed outside the status line so the /agents
    // running view shows wall-clock for every entry, running or not.
    const status = formatSubagentStatus(e.snapshot);
    const elapsedStr = fmtDurationShort(elapsed);
    const suffix = elapsedStr && e.snapshot.state === 'running' ? ` ${elapsedStr}` : '';
    lines.push(`  ${e.handle}${pad}${status}${suffix}`);
  }
  return lines.join('\n');
}

/**
 * Parallel-dispatch collapse: when multiple children run at once, emit
 * one line with running / done counts + aggregate cost. Mirrors Claude
 * Code's collapsed presentation for fan-out Task calls.
 */
export function formatParallelSubagentStatus(snapshots: readonly SubagentRunSnapshot[]): string {
  const running = snapshots.filter((s) => s.state === 'running').length;
  const done = snapshots.length - running;
  const cost = snapshots.reduce((s, x) => s + (x.cost || 0), 0);
  const parts = [`subagent: ${done}/${snapshots.length} done`];
  if (running > 0) parts.push(`${running} running`);
  if (cost > 0) parts.push(fmtCost(cost));
  return parts.join(' · ');
}
