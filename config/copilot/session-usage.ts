#!/usr/bin/env node
// GitHub Copilot CLI session usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import {
  copilotLegacyError,
  type CopilotSessionDir,
  type CopilotSessionRecord,
  copilotSkippedLegacyNotice,
  copilotStateDir,
  copilotStateDirMissing,
  defaultCopilotHome,
  isEmptyCopilotSession,
  listCopilotSessionDirs,
  loadCopilotSessionDir,
  pickCopilotSessionDir,
} from '../../lib/node/ai-tooling/copilot-events.ts';
import { resolveProjectPath } from '../../lib/node/ai-tooling/paths.ts';
import { type SessionDetail, type SessionSummary } from '../../lib/node/ai-tooling/types.ts';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface CopilotContext {
  stateDir: string;
  filterCwd: string;
}

function recordToSummary(s: CopilotSessionRecord): SessionSummary {
  const startMs = s.startTime ? new Date(s.startTime).getTime() : 0;
  const endMs = s.endTime ? new Date(s.endTime).getTime() : 0;
  const summary: SessionSummary = {
    sessionId: s.sessionId,
    model: s.model,
    startTime: s.startTime,
    endTime: s.endTime,
    durationSecs: startMs && endMs ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0,
    userTurns: s.userTurns,
    tokens: s.tokens,
    toolCalls: s.toolCalls,
    toolBreakdown: s.toolBreakdown,
    subagentCount: s.subagents.length,
  };
  if (s.title) summary.title = s.title;
  if (s.preview) summary.preview = s.preview;
  if (s.cwd) summary.directory = s.cwd;
  if (s.copilotVersion) summary.version = s.copilotVersion;
  if (s.modelBreakdown.length > 0) summary.modelBreakdown = s.modelBreakdown;
  if (s.lastContextTokens !== undefined) summary.lastContextTokens = s.lastContextTokens;
  return summary;
}

// ---------------------------------------------------------------------------
// Adapter operations
// ---------------------------------------------------------------------------

// Parses every session with an events.jsonl. Never-prompted sessions are
// skipped silently; legacy-format sessions are counted and reported once.
function loadAll(ctx: CopilotContext): CopilotSessionRecord[] {
  const out: CopilotSessionRecord[] = [];
  let legacy = 0;
  for (const entry of listCopilotSessionDirs(ctx.stateDir)) {
    const parsed = loadCopilotSessionDir(entry);
    if (!parsed) continue;
    if (parsed.kind === 'legacy') {
      legacy++;
      continue;
    }
    if (!isEmptyCopilotSession(parsed.session)) out.push(parsed.session);
  }
  if (legacy > 0) console.error(copilotSkippedLegacyNotice(legacy));
  return out.sort((a, b) => (a.startTime < b.startTime ? 1 : a.startTime > b.startTime ? -1 : 0));
}

function matchesFilter(cwd: string | undefined, filterCwd: string): boolean {
  if (!cwd) return false;
  const prefix = filterCwd.endsWith(path.sep) ? filterCwd : `${filterCwd}${path.sep}`;
  return cwd === filterCwd || cwd.startsWith(prefix);
}

function listSessions(ctx: CopilotContext): SessionSummary[] {
  return loadAll(ctx)
    .filter((s) => matchesFilter(s.cwd, ctx.filterCwd))
    .map(recordToSummary);
}

function listAllSessions(ctx: CopilotContext): SessionSummary[] {
  return loadAll(ctx).map(recordToSummary);
}

function resolveSessionDir(ctx: CopilotContext, sessionId: string): CopilotSessionDir {
  const picked = pickCopilotSessionDir(listCopilotSessionDirs(ctx.stateDir), sessionId);
  if (picked.ok) return picked.session;
  if (picked.error === 'ambiguous') {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const id of picked.matches) console.error(`  ${id}`);
    process.exit(1);
  }
  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

function loadSessionDetail(ctx: CopilotContext, sessionId: string): SessionDetail {
  const entry = resolveSessionDir(ctx, sessionId);
  const parsed = loadCopilotSessionDir(entry);
  if (!parsed) {
    console.error(`GitHub Copilot session ${entry.id} has no events.jsonl (never prompted)`);
    process.exit(1);
  }
  if (parsed.kind === 'legacy') {
    console.error(copilotLegacyError(parsed.sessionId, parsed.copilotVersion));
    process.exit(1);
  }
  return { ...recordToSummary(parsed.session), subagents: parsed.session.subagents };
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
  --user-dir, -u <dir> GitHub Copilot data dir (default: $COPILOT_HOME,
                       else ~/.copilot)
  --json               Machine-readable JSON output
  --sort <field>       list: date, tokens, duration, tools
                       totals: date, tokens, tools (default: date)
  --limit, -n <N>      Limit to N rows
  --group-by, -g <p>   totals period: day or week (default: day)
  --no-color           Disable ANSI colors
  -h, --help           Show this help

Reads the per-session event logs in <user-dir>/session-state/*/events.jsonl.
Sessions recorded before copilot logged session.usage_record events are not
supported: list / totals skip them, session <uuid> fails. Copilot bills in
premium requests, not USD, so no cost is shown; --no-cost and
--refresh-prices are accepted for interface parity but have no effect.`;

const adapter: SessionUsageAdapter<CopilotContext> = {
  help: HELP,
  defaultUserDir: defaultCopilotHome(),
  sessionArgLabel: '<uuid>',
  resolveContext(args, userDir) {
    const stateDir = copilotStateDir(userDir);
    if (!fs.existsSync(stateDir)) {
      console.error(copilotStateDirMissing(stateDir));
      process.exit(1);
    }
    return { stateDir, filterCwd: resolveProjectPath(args.projectArg) };
  },
  listSessions,
  listAllSessions,
  loadSessionDetail,
};

runSessionUsageCli(adapter).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
