#!/usr/bin/env node
// pi session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import { readJsonlLines } from '../../lib/node/ai-tooling/jsonl.ts';
import { expandUserPath, resolveProjectPath } from '../../lib/node/ai-tooling/paths.ts';
import {
  type ModelTokenBreakdown,
  type SessionDetail,
  type SessionSummary,
  type SessionTokens,
  type Subagent,
} from '../../lib/node/ai-tooling/types.ts';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface PiContext {
  sessionsDir: string;
  // When set, listSessions() filters to sessions whose cwd (from the
  // SessionHeader) equals or is a descendant of this path. An empty string
  // means "no filter — all projects" (used by the `totals` command).
  filterCwd: string;
  projectLabel: string;
}

// ---------------------------------------------------------------------------
// Entry types (subset of pi's session-format.md needed for usage metrics)
// ---------------------------------------------------------------------------

interface PiUsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: PiUsageCost;
}

interface PiContentBlock {
  type?: string;
  name?: string;
  text?: string;
}

interface PiMessage {
  role?: string;
  model?: string;
  provider?: string;
  toolName?: string;
  isError?: boolean;
  usage?: PiUsage;
  content?: string | PiContentBlock[];
}

interface PiSubagentRunData {
  agent?: string;
  agentSource?: string;
  task?: string;
  model?: string;
  turns?: number;
  tokens?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
  cost?: number;
  durationMs?: number;
  stopReason?: string;
  workspace?: { isolation?: string; worktreePath?: string };
  childSessionId?: string;
  childSessionFile?: string;
  handle?: string;
  error?: string;
}

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  // SessionHeader fields (first entry only)
  version?: number;
  cwd?: string;
  parentSession?: string;
  // model_change fields
  provider?: string;
  modelId?: string;
  // session_info fields
  name?: string;
  // Wrapped message (type === "message")
  message?: PiMessage;
  // CustomEntry fields (type === "custom"): the subagent extension records
  // each completed child run here so we can attribute agent labels / tasks
  // back to the matching child .jsonl transcript.
  customType?: string;
  data?: PiSubagentRunData;
}

const SUBAGENT_RUN_CUSTOM_TYPE = 'subagent-run';
const SUBAGENTS_DIRNAME = 'subagents';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function emptyTokens(): SessionTokens {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

interface ParsedPi {
  sessionId: string;
  cwd: string;
  sessionName: string;
  hasParentSession: boolean;
  startTime: string;
  endTime: string;
  model: string;
  tokens: SessionTokens;
  cost: number;
  modelBreakdown: ModelTokenBreakdown[];
  toolCalls: number;
  toolBytes: number;
  toolBreakdown: Record<string, number>;
  userTurns: number;
  // Indexed by childSessionId so loadSessionDetail() can enrich each child
  // transcript with its agent label / task / stop reason without re-reading
  // the parent file. Empty for child session files, which don't record
  // subagent-run entries for their own descendants.
  subagentRuns: Map<string, PiSubagentRunData>;
}

function parseEntries(entries: PiEntry[], fallbackSessionId: string): ParsedPi {
  const tokens = emptyTokens();
  const perModel = new Map<string, { tokens: SessionTokens; cost: number }>();
  const toolBreakdown: Record<string, number> = {};
  let sessionId = fallbackSessionId;
  let cwd = '';
  let sessionName = '';
  let hasParentSession = false;
  let startTime = '';
  let endTime = '';
  let model = '';
  let cost = 0;
  let toolCalls = 0;
  let toolBytes = 0;
  let userTurns = 0;
  const subagentRuns = new Map<string, PiSubagentRunData>();
  // Tracks the explicit model last chosen via `/model`. Assistant messages
  // also carry their own `model` field, which is authoritative for that
  // specific response — we prefer it when attributing token slices.
  let currentModel = '';

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    if (entry.type === 'session') {
      if (entry.id) sessionId = entry.id;
      if (entry.cwd) cwd = entry.cwd;
      if (entry.parentSession) hasParentSession = true;
      if (entry.timestamp && !startTime) startTime = entry.timestamp;
      continue;
    }

    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type === 'model_change') {
      if (entry.modelId) {
        currentModel = entry.modelId;
        if (!model) model = entry.modelId;
      }
      continue;
    }

    if (entry.type === 'session_info') {
      if (entry.name) sessionName = entry.name;
      continue;
    }

    if (entry.type === 'custom' && entry.customType === SUBAGENT_RUN_CUSTOM_TYPE && entry.data) {
      const childId = entry.data.childSessionId;
      if (childId) subagentRuns.set(childId, entry.data);
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;

    const m = entry.message;
    const role = m.role;

    if (role === 'user') {
      // Every role=user message is a user-authored turn. Pi stores extension
      // injections under a distinct `custom_message` entry type (not
      // role=user), so no harness-prefix filter is needed here. User content
      // may be a string or a TextContent/ImageContent array — both count.
      userTurns++;
      continue;
    }

    if (role === 'assistant') {
      const msgModel = m.model ?? currentModel ?? '';
      if (!model && msgModel) model = msgModel;

      const u = m.usage;
      if (u) {
        const dIn = u.input ?? 0;
        const dOut = u.output ?? 0;
        const dCr = u.cacheRead ?? 0;
        const dCw = u.cacheWrite ?? 0;
        const dCost = u.cost?.total ?? 0;
        tokens.input += dIn;
        tokens.output += dOut;
        tokens.cacheRead += dCr;
        tokens.cacheWrite! += dCw;
        cost += dCost;

        const key = msgModel || 'unknown';
        const slice = perModel.get(key) ?? { tokens: emptyTokens(), cost: 0 };
        slice.tokens.input += dIn;
        slice.tokens.output += dOut;
        slice.tokens.cacheRead += dCr;
        slice.tokens.cacheWrite! += dCw;
        slice.cost += dCost;
        perModel.set(key, slice);
      }

      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'toolCall') {
            toolCalls++;
            const name = block.name ?? 'unknown';
            toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
          }
        }
      }
      continue;
    }

    if (role === 'toolResult') {
      // Tool results contribute to toolBytes. Tool-call counting happens from
      // the assistant message above so we don't double-count.
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            toolBytes += block.text.length;
          }
        }
      }
      continue;
    }

    // bashExecution / custom / branchSummary / compactionSummary carry no
    // token usage; ignored for totals.
  }

  const modelBreakdown: ModelTokenBreakdown[] = [];
  let dominantOutput = -1;
  for (const [m, slice] of perModel) {
    const mb: ModelTokenBreakdown = { model: m, tokens: slice.tokens };
    if (slice.cost > 0) mb.cost = slice.cost;
    modelBreakdown.push(mb);
    if (slice.tokens.output > dominantOutput) {
      dominantOutput = slice.tokens.output;
      model = m;
    }
  }

  return {
    sessionId,
    cwd,
    sessionName,
    hasParentSession,
    startTime,
    endTime,
    model,
    tokens,
    cost,
    modelBreakdown,
    toolCalls,
    toolBytes,
    toolBreakdown,
    userTurns,
    subagentRuns,
  };
}

function parsedToSummary(p: ParsedPi, subagentCount: number): SessionSummary {
  const startMs = p.startTime ? new Date(p.startTime).getTime() : 0;
  const endMs = p.endTime ? new Date(p.endTime).getTime() : 0;
  const durationSecs = startMs && endMs ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;

  const summary: SessionSummary = {
    sessionId: p.sessionId,
    model: p.model,
    startTime: p.startTime,
    endTime: p.endTime,
    durationSecs,
    userTurns: p.userTurns,
    tokens: p.tokens,
    toolCalls: p.toolCalls,
    toolBreakdown: p.toolBreakdown,
    // Pi's `subagent` extension writes each child session next to the parent
    // under `subagents/<parent-session-id>/`. Mirror claude/codex: list/
    // totals count parent tokens only; child tokens become their own rows in
    // `session <uuid>`. Forked/cloned sessions live as sibling top-level
    // .jsonl files and are shown as their own entries, not nested here.
    subagentCount,
  };
  if (p.sessionName) summary.title = p.sessionName;
  if (p.cwd) summary.directory = p.cwd;
  if (p.toolBytes > 0) summary.toolBytes = p.toolBytes;
  if (p.cost > 0) summary.cost = p.cost;
  if (p.modelBreakdown.length > 0) summary.modelBreakdown = p.modelBreakdown;
  return summary;
}

function parseSessionFile(filePath: string): ParsedPi {
  // Pi encodes the session UUID into the filename as
  // `<timestamp>_<uuid>.jsonl`. Strip `.jsonl` and keep the trailing UUID as
  // a fallback id if, for some reason, the header is missing.
  const base = path.basename(filePath, '.jsonl');
  const fallbackSessionId = base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base;
  return parseEntries(readJsonlLines<PiEntry>(filePath), fallbackSessionId);
}

// ---------------------------------------------------------------------------
// Subagent session discovery
// ---------------------------------------------------------------------------

/**
 * The subagent extension writes child transcripts to
 * `<projectDir>/subagents/<parent-session-id>/<timestamp>_<child-id>.jsonl`.
 * We locate `<projectDir>` by stripping the parent session filename off the
 * input path — all subagent files share the same `<projectDir>` root as
 * their parent.
 */
function subagentDirFor(parentFilePath: string, parentSessionId: string): string {
  return path.join(path.dirname(parentFilePath), SUBAGENTS_DIRNAME, parentSessionId);
}

function listSubagentFiles(parentFilePath: string, parentSessionId: string): string[] {
  const dir = subagentDirFor(parentFilePath, parentSessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
}

function countSubagentFiles(parentFilePath: string, parentSessionId: string): number {
  return listSubagentFiles(parentFilePath, parentSessionId).length;
}

function parsedToSubagent(p: ParsedPi, meta: PiSubagentRunData | undefined): Subagent {
  // Child transcripts are authoritative for token counts, tool calls, model
  // breakdown, and cost (pi records real cost per assistant message). The
  // parent-side `subagent-run` entry contributes the agent identity and the
  // task string that the parent used to spawn the child — neither of which
  // appears in the child's own .jsonl.
  const sa: Subagent = {
    agentId: p.sessionId,
    agentLabel: meta?.agent ?? '',
    model: p.model,
    tokens: p.tokens,
    toolCalls: p.toolCalls,
    toolBreakdown: p.toolBreakdown,
  };
  if (meta?.task) {
    // Keep the task snippet short — some spawns paste multi-paragraph
    // prompts; we want the detail view readable.
    sa.description = meta.task.length > 160 ? `${meta.task.slice(0, 157)}…` : meta.task;
  }
  if (meta?.handle) sa.role = meta.handle;
  if (p.cost > 0) sa.cost = p.cost;
  if (p.modelBreakdown.length > 0) sa.modelBreakdown = p.modelBreakdown;
  return sa;
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

function listSessionFiles(sessionsDir: string): string[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const result: string[] = [];
  for (const projectEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, projectEntry.name);
    for (const f of fs.readdirSync(projectDir)) {
      if (f.endsWith('.jsonl')) result.push(path.join(projectDir, f));
    }
  }
  return result;
}

function matchesFilter(sessionCwd: string, filterCwd: string): boolean {
  if (!filterCwd) return true;
  if (!sessionCwd) return false;
  return sessionCwd === filterCwd || sessionCwd.startsWith(filterCwd + '/');
}

function resolveSessionFile(sessionsDir: string, sessionId: string): string {
  const files = listSessionFiles(sessionsDir);

  // Exact UUID match on either the filename (legacy) or the header id.
  // Walking entries is expensive on a big store so we look at the filename
  // suffix first, falling back to parsing only when needed.
  const suffixMatches = files.filter((f) => {
    const base = path.basename(f, '.jsonl');
    const tail = base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base;
    return tail === sessionId || tail.startsWith(sessionId);
  });
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (suffixMatches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const f of suffixMatches) {
      const base = path.basename(f, '.jsonl');
      const tail = base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base;
      console.error(`  ${tail}`);
    }
    process.exit(1);
  }

  // Fall back to scanning headers — handles the rare case where the filename
  // UUID differs from the header id (e.g. a renamed file).
  const headerMatches = files.filter((f) => {
    try {
      const first = fs.readFileSync(f, 'utf-8').split('\n')[0] ?? '';
      const entry = JSON.parse(first) as PiEntry;
      return entry.type === 'session' && (entry.id ?? '').startsWith(sessionId);
    } catch {
      return false;
    }
  });
  if (headerMatches.length === 1) return headerMatches[0];
  if (headerMatches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const f of headerMatches) console.error(`  ${path.basename(f, '.jsonl')}`);
    process.exit(1);
  }

  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Adapter operations
// ---------------------------------------------------------------------------

function listSessions(ctx: PiContext): SessionSummary[] {
  const summaries: SessionSummary[] = [];
  for (const file of listSessionFiles(ctx.sessionsDir)) {
    const parsed = parseSessionFile(file);
    if (!matchesFilter(parsed.cwd, ctx.filterCwd)) continue;
    summaries.push(parsedToSummary(parsed, countSubagentFiles(file, parsed.sessionId)));
  }
  return summaries;
}

function listAllSessions(ctx: PiContext): SessionSummary[] {
  return listSessionFiles(ctx.sessionsDir).map((f) => {
    const parsed = parseSessionFile(f);
    return parsedToSummary(parsed, countSubagentFiles(f, parsed.sessionId));
  });
}

function loadSessionDetail(ctx: PiContext, sessionId: string): SessionDetail {
  const file = resolveSessionFile(ctx.sessionsDir, sessionId);
  const parsed = parseSessionFile(file);
  const childFiles = listSubagentFiles(file, parsed.sessionId);
  const subagents: Subagent[] = childFiles.map((cf) => {
    const child = parseSessionFile(cf);
    return parsedToSubagent(child, parsed.subagentRuns.get(child.sessionId));
  });
  return { ...parsedToSummary(parsed, childFiles.length), subagents };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions for the current project (default)
  session <uuid>       Detailed single-session report
  totals               Usage totals bucketed by day or week. Aggregates across
                       all projects unless --project is given.

Options:
  --project, -p <path> Filter sessions by project directory (default: $PWD)
  --user-dir, -u <dir> Pi agent dir (default: ~/.pi/agent)
  --json               Machine-readable JSON output
  --sort <field>       list: date, tokens, duration, tools
                       totals: date, tokens, tools, cost (default: date)
  --limit, -n <N>      Limit to N rows
  --group-by, -g <p>   totals period: day or week (default: day)
  --no-color           Disable ANSI colors
  -h, --help           Show this help

Costs come directly from pi's own usage.cost.total field on each assistant
message — no pricing fetch is needed. --no-cost and --refresh-prices are
accepted for interface parity with the other tools but have no effect here.`;

const adapter: SessionUsageAdapter<PiContext> = {
  help: HELP,
  defaultUserDir: '~/.pi/agent',
  sessionArgLabel: '<uuid>',
  resolveContext(args, userDir) {
    const sessionsDir = path.join(expandUserPath(userDir), 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      console.error(`Pi sessions directory not found: ${sessionsDir}`);
      process.exit(1);
    }
    // For `totals` without an explicit --project we want the unfiltered view;
    // every other command defaults to the current cwd.
    const filterCwd = args.command === 'totals' && !args.projectArg ? '' : resolveProjectPath(args.projectArg);
    return {
      sessionsDir,
      filterCwd,
      projectLabel: filterCwd ? path.basename(filterCwd) || filterCwd : '',
    };
  },
  listSessions,
  listAllSessions,
  loadSessionDetail,
  listLabel: (ctx) => ctx.projectLabel || undefined,
  // No costVariant: pi records real costs per message, so we skip the
  // LiteLLM pricing table entirely. parsedToSummary() fills in `cost` and
  // the CLI harness respects existing values.
};

runSessionUsageCli(adapter).catch((err) => {
  console.error(err);
  process.exit(1);
});
