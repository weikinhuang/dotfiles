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
/** Cap used by the `/agents` overlay row list; preview block carries the overflow. */
export const OVERLAY_DESCRIPTION_CAP = 55;

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
  /** Optional task summary - rendered in the running overlay preview block. */
  task?: string;
  /** Optional short handle (`sub_explore_1`) - rendered alongside the agent name. */
  handle?: string;
  /** Optional `maxTurns` cap for the child run - shown as `turn N/max`. */
  maxTurns?: number;
  /** Optional source layer for the agent definition (global / user / project). */
  agentSource?: 'global' | 'user' | 'project';
  /** Optional cache-write tokens (only some providers bill them). */
  cacheWrite?: number;
  /** Per-tool call counts for the child run, sourced from `tool_execution_start` events. */
  byTool?: Readonly<Record<string, number>>;
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

// ──────────────────────────────────────────────────────────────────────
// /agents overlay helpers
// ──────────────────────────────────────────────────────────────────────

/** Subset of `AgentDef` consumed by the preview formatter. */
export interface AgentPreviewSource {
  name: string;
  description: string;
  source: 'global' | 'user' | 'project';
  path: string;
  tools: readonly string[];
  model: 'inherit' | { provider: string; modelId: string };
  maxTurns: number;
  timeoutMs: number;
  isolation: 'shared-cwd' | 'worktree';
}

/** Cap on the preview-block description prose (chars). Overflow gets `…`. */
const PREVIEW_DESCRIPTION_CAP = 320;

function formatModel(model: AgentPreviewSource['model']): string {
  if (model === 'inherit') return 'inherit';
  return `${model.provider}/${model.modelId}`;
}

/**
 * Cap a description for the `/agents` overlay row list. The preview
 * block below the rule carries the full text, so this is a hard truncate
 * at ~55 chars - enough to read intent at 80 cols without crowding the
 * `[<source>]` tag on the right.
 */
export function formatAgentListRowDescription(description: string, cap: number = OVERLAY_DESCRIPTION_CAP): string {
  return shorten(description, cap);
}

/**
 * Build the preview-block lines rendered below the row list in the
 * `/agents` overlay. Pure - returns an array of plain strings the
 * overlay theme wraps + truncates to width.
 *
 * Layout:
 *   <path>
 *   (blank)
 *   tools:  read, grep, find, ls
 *   model:  inherit       maxTurns: 20    timeoutMs: 180s
 *   isolation: shared-cwd
 *   (blank)
 *   <description prose, soft-capped>
 */
export function formatAgentPreview(agent: AgentPreviewSource): string[] {
  const lines: string[] = [];
  lines.push(agent.path);
  lines.push('');
  const toolsLine = `tools:  ${agent.tools.length > 0 ? agent.tools.join(', ') : '(none)'}`;
  lines.push(toolsLine);
  const timeoutS = Math.round(agent.timeoutMs / 1000);
  lines.push(`model:  ${formatModel(agent.model)}       maxTurns: ${agent.maxTurns}    timeoutMs: ${timeoutS}s`);
  lines.push(`isolation: ${agent.isolation}`);
  lines.push('');
  const prose = agent.description.replace(/\s+/g, ' ').trim();
  const capped = prose.length > PREVIEW_DESCRIPTION_CAP ? `${prose.slice(0, PREVIEW_DESCRIPTION_CAP - 1).trimEnd()}…` : prose;
  lines.push(capped);
  return lines;
}

// ──────────────────────────────────────────────────────────────────────
// /agents:running overlay helpers
// ──────────────────────────────────────────────────────────────────────

const BAR_FILLED = '▰';
const BAR_EMPTY = '▱';

/**
 * Context-usage bar: `▰▰▱▱▱▱▱▱  8%`. Width is the count of cells
 * (default 8). Falls back to an empty bar when context info is missing.
 */
export function formatContextBar(
  snap: Pick<SubagentRunSnapshot, 'contextTokens' | 'contextWindow'>,
  options: { width?: number } = {},
): string {
  const width = options.width ?? 8;
  const tokens = snap.contextTokens;
  const window = snap.contextWindow;
  if (tokens == null || !window || window <= 0) {
    return `${BAR_EMPTY.repeat(width)}  --%`;
  }
  const pct = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)));
  const filled = Math.min(width, Math.round((pct / 100) * width));
  const bar = `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(width - filled)}`;
  return `${bar}  ${pct}%`;
}

/** Maximum number of per-tool entries rendered before the `· +N more` suffix. */
const TOOL_COUNT_TOP_N = 5;

/**
 * `read(7) · grep(3) · bash(1)` for a child snapshot. Sorted descending
 * by count, then ascending by tool name for stability. Returns `null`
 * when no tool calls have been recorded so callers can hide the line.
 */
export function formatToolCallCounts(snap: Pick<SubagentRunSnapshot, 'byTool'>): string | null {
  const by = snap.byTool;
  if (!by) return null;
  const entries = Object.entries(by).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = entries.slice(0, TOOL_COUNT_TOP_N).map(([name, count]) => `${name}(${count})`);
  const more = entries.length - TOOL_COUNT_TOP_N;
  if (more > 0) head.push(`+${more} more`);
  return head.join(' · ');
}

/**
 * Stop-reason → glyph table used by both the renderResult scorecard
 * and the running-overlay rows. `spawned` is the v2 addition for
 * background dispatches (parent sees `⏳`, not `✗`).
 */
export type ScorecardStopReason = 'completed' | 'max_turns' | 'aborted' | 'error' | 'running' | 'spawned';

export interface ScorecardGlyphInfo {
  glyph: string;
  /** Theme token name (matches `theme.fg(...)` keys). */
  themeColor: 'success' | 'warning' | 'error' | 'accent';
}

export function scorecardGlyph(stopReason: ScorecardStopReason | undefined): ScorecardGlyphInfo {
  switch (stopReason) {
    case 'completed':
      return { glyph: '✓', themeColor: 'success' };
    case 'max_turns':
      return { glyph: '∎', themeColor: 'warning' };
    case 'aborted':
      return { glyph: '⚠', themeColor: 'warning' };
    case 'error':
      return { glyph: '✗', themeColor: 'error' };
    case 'running':
    case 'spawned':
    default:
      return { glyph: '⏳', themeColor: 'accent' };
  }
}

const RUNNING_ROW_INDENT = '       ';

/**
 * 4-line block for one entry in `/agents:running`:
 *   `<handle> <agent> <state> <elapsed>  turn N/max`
 *   `M(N) ↑in ↻cached ↓out  R xx%  $cost`
 *   `ctx <bar>  model <model>`
 *   `tools: read(7) · grep(3)`  (omitted when empty)
 */
export function formatRunningChildRow(
  entry: { handle: string; snapshot: SubagentRunSnapshot; startedAt: number },
  now: number,
  options: { width?: number; selected?: boolean } = {},
): string[] {
  const { snapshot: snap, handle, startedAt } = entry;
  const elapsedMs = Math.max(0, now - startedAt);
  const elapsedStr = fmtDurationShort(elapsedMs);
  const stateLabel =
    snap.state === 'running'
      ? 'running'
      : snap.state === 'completed'
        ? 'done'
        : snap.state === 'aborted'
          ? 'aborted'
          : snap.state === 'max_turns'
            ? 'max turns'
            : 'error';
  const glyph = scorecardGlyph(snap.state === 'running' ? 'running' : snap.state).glyph;
  const turnChip =
    snap.maxTurns && snap.maxTurns > 0 ? `turn ${snap.turns}/${snap.maxTurns}` : `turn ${snap.turns}`;

  const head = [`${entry.handle ? handle : ''}`, snap.agent, glyph, stateLabel, elapsedStr, turnChip]
    .filter((s) => s && s.length > 0)
    .join(' ');

  const tokenLabel = snap.turns > 0 ? `M(${snap.turns})` : 'M';
  const denom = snap.input + snap.cacheRead;
  const ratio = denom > 0 ? ` R ${Math.round((snap.cacheRead / denom) * 100)}%` : '';
  const tokenLine = `${tokenLabel} ↑${fmtSi(snap.input)} ↻ ${fmtSi(snap.cacheRead)} ↓${fmtSi(snap.output)}${ratio}  ${fmtCost(snap.cost || 0)}`;

  const ctxLine = `ctx ${formatContextBar(snap, { width: 8 })}   model ${snap.model ?? 'inherit'}`;

  const lines = [head, `${RUNNING_ROW_INDENT}${tokenLine}`, `${RUNNING_ROW_INDENT}${ctxLine}`];
  const tools = formatToolCallCounts(snap);
  if (tools) lines.push(`${RUNNING_ROW_INDENT}tools: ${tools}`);
  // `options.width` is reserved for future tighter truncation; today the
  // overlay caller applies `truncateToWidth` line-by-line. Keep the
  // parameter present so the call sites are stable.
  void options.width;
  void options.selected;
  return lines;
}

// ──────────────────────────────────────────────────────────────────────
// subagent + subagent_send renderResult scorecard
// ──────────────────────────────────────────────────────────────────────

const SCORECARD_INDENT = '   ';

/**
 * Render the multi-line scorecard body shared by `subagent` (sync
 * completion), `subagent_send wait`, `subagent_send status`, and the
 * inline preview in `/agents:running`. Does NOT include the lead glyph
 * line - callers prefix that themselves so they can pick the colour /
 * label that matches the surface (e.g. `⏳ explore  (global)`).
 *
 * Returns 3-4 lines, indented two-spaces deep:
 *   `3 turns / 20 max · ↑1.2k / ↻ 4.5k / ↓180 · R 79% · $0.004 · 4.2s`
 *   `stop: completed   ctx:8%   model: qwen3-coder-30b`
 *   `tools: read(7) · grep(3) · bash(1)`  (omitted when empty)
 */
export function formatSubagentScorecard(snap: SubagentRunSnapshot): string[] {
  const lines: string[] = [];

  const turnSeg =
    snap.maxTurns && snap.maxTurns > 0
      ? `${snap.turns} ${snap.turns === 1 ? 'turn' : 'turns'} / ${snap.maxTurns} max`
      : `${snap.turns} ${snap.turns === 1 ? 'turn' : 'turns'}`;
  const tokenSegs = [
    `↑${fmtSi(snap.input)}`,
    `↻ ${fmtSi(snap.cacheRead)}`,
    `↓${fmtSi(snap.output)}`,
  ];
  if (snap.cacheWrite && snap.cacheWrite > 0) tokenSegs.splice(2, 0, `W ${fmtSi(snap.cacheWrite)}`);
  const tokenSeg = tokenSegs.join(' / ');
  const denom = snap.input + snap.cacheRead;
  const ratioSeg = denom > 0 ? `R ${Math.round((snap.cacheRead / denom) * 100)}%` : null;
  const costSeg = snap.cost > 0 ? fmtCost(snap.cost) : null;
  const durSeg = snap.durationMs != null ? fmtDurationShort(snap.durationMs) : null;
  const firstSegs = [turnSeg, tokenSeg, ratioSeg, costSeg, durSeg].filter((s): s is string => Boolean(s));
  lines.push(`${SCORECARD_INDENT}${firstSegs.join(' · ')}`);

  const stopLabel =
    snap.state === 'running'
      ? 'running'
      : snap.state === 'completed'
        ? 'completed'
        : snap.state === 'max_turns'
          ? 'max_turns'
          : snap.state === 'aborted'
            ? 'aborted'
            : 'error';
  const ctxSeg =
    snap.contextTokens != null && snap.contextWindow && snap.contextWindow > 0
      ? `ctx:${Math.min(100, Math.round((snap.contextTokens / snap.contextWindow) * 100))}%`
      : null;
  const modelSeg = snap.model ? `model: ${snap.model}` : null;
  const stopSegs = [`stop: ${stopLabel}`, ctxSeg, modelSeg].filter((s): s is string => Boolean(s));
  lines.push(`${SCORECARD_INDENT}${stopSegs.join('   ')}`);

  const tools = formatToolCallCounts(snap);
  if (tools) lines.push(`${SCORECARD_INDENT}tools: ${tools}`);

  return lines;
}

/**
 * Lead line shared by `subagent` + `subagent_send` renderResult:
 *   `⏳ explore  (global)   sub_explore_1`
 * Caller themes / colours individual segments; this returns the raw
 * plain-text composition (the glyph is included verbatim).
 */
export function formatScorecardLead(args: {
  agent: string;
  agentSource?: 'global' | 'user' | 'project';
  handle?: string;
  stopReason: ScorecardStopReason | undefined;
  /** Optional suffix - e.g. `"spawned in background"`. */
  suffix?: string;
}): string {
  const g = scorecardGlyph(args.stopReason);
  const sourceTag = args.agentSource ? ` (${args.agentSource})` : '';
  const handleTag = args.handle ? `   ${args.handle}` : '';
  const suffix = args.suffix ? `   ${args.suffix}` : '';
  return `${g.glyph} ${args.agent}${sourceTag}${handleTag}${suffix}`;
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
