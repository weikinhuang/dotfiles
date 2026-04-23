#!/usr/bin/env node
// Codex CLI session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import { readJsonlLines } from '../../lib/node/ai-tooling/jsonl.ts';
import { resolveProjectPath } from '../../lib/node/ai-tooling/paths.ts';
import type { SessionDetail, SessionSummary, SessionTokens, Subagent } from '../../lib/node/ai-tooling/types.ts';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface CodexContext {
  sessionsDir: string;
  filterCwd: string;
  allFiles: string[];
  subagentIndex: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// File discovery and subagent indexing
// ---------------------------------------------------------------------------

function findAllSessionFiles(sessionsDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }

  walk(sessionsDir);
  return results;
}

function buildSubagentIndex(allFiles: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const f of allFiles) {
    const first = fs.readFileSync(f, 'utf-8').split('\n')[0] ?? '';
    try {
      const entry = JSON.parse(first);
      const parentId = entry?.payload?.forked_from_id;
      if (entry.type === 'session_meta' && parentId) {
        const list = index.get(parentId) ?? [];
        list.push(f);
        index.set(parentId, list);
      }
    } catch {
      // skip
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

interface ParsedSession {
  sessionId: string;
  model: string;
  cwd: string;
  cliVersion: string;
  agentNickname: string;
  agentRole: string;
  isSubagent: boolean;
  startTime: string;
  endTime: string;
  userTurns: number;
  tokens: SessionTokens;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
}

function parseSessionFile(filePath: string): ParsedSession {
  const entries = readJsonlLines(filePath);

  let sessionId = '';
  let model = '';
  let cwd = '';
  let cliVersion = '';
  let agentNickname = '';
  let agentRole = '';
  let isSubagent = false;
  let startTime = '';
  let endTime = '';
  let userTurns = 0;
  let tokens: SessionTokens = { input: 0, cacheRead: 0, output: 0, reasoning: 0 };
  const toolBreakdown: Record<string, number> = {};
  let toolCalls = 0;

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type === 'session_meta' && !sessionId) {
      const p = entry.payload;
      sessionId = p?.id ?? '';
      cwd = p?.cwd ?? '';
      cliVersion = p?.cli_version ?? '';
      agentNickname = p?.agent_nickname ?? '';
      agentRole = p?.agent_role ?? '';
      isSubagent = typeof p?.source === 'object' && !!p.source?.subagent;
    }

    if (entry.type === 'turn_context' && !model) {
      model = entry.payload?.model ?? '';
    }

    if (entry.type === 'event_msg') {
      const p = entry.payload;
      if (p?.type === 'user_message') {
        userTurns++;
      }
      if (p?.type === 'token_count' && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        tokens = {
          input: u.input_tokens ?? 0,
          cacheRead: u.cached_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: u.reasoning_output_tokens ?? 0,
        };
      }
    }

    if (entry.type === 'response_item') {
      const p = entry.payload;
      if ((p?.type === 'function_call' || p?.type === 'custom_tool_call') && p.name) {
        toolCalls++;
        toolBreakdown[p.name] = (toolBreakdown[p.name] ?? 0) + 1;
      }
    }
  }

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');

  return {
    sessionId,
    model,
    cwd,
    cliVersion,
    agentNickname,
    agentRole,
    isSubagent,
    startTime,
    endTime,
    userTurns,
    tokens,
    toolCalls,
    toolBreakdown,
  };
}

function parsedToSummary(p: ParsedSession, subagentCount: number): SessionSummary {
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
    subagentCount,
  };
  if (p.cwd) summary.directory = p.cwd;
  if (p.cliVersion) summary.version = p.cliVersion;
  return summary;
}

function parsedToSubagent(p: ParsedSession): Subagent {
  const sa: Subagent = {
    agentId: p.sessionId,
    agentLabel: p.agentNickname || 'unnamed',
    model: p.model,
    tokens: p.tokens,
    toolCalls: p.toolCalls,
    toolBreakdown: p.toolBreakdown,
  };
  if (p.agentRole) sa.role = p.agentRole;
  return sa;
}

// ---------------------------------------------------------------------------
// Adapter operations
// ---------------------------------------------------------------------------

function listSessions(ctx: CodexContext): SessionSummary[] {
  const parents = ctx.allFiles.map(parseSessionFile).filter((p) => !p.isSubagent);
  const filtered = parents.filter((p) => p.cwd === ctx.filterCwd || p.cwd.startsWith(ctx.filterCwd + '/'));
  return filtered.map((p) => parsedToSummary(p, ctx.subagentIndex.get(p.sessionId)?.length ?? 0));
}

function resolveSessionFile(ctx: CodexContext, sessionId: string): string {
  // Exact match on path substring
  for (const f of ctx.allFiles) {
    if (f.includes(sessionId)) return f;
  }

  // Prefix match on session_meta id
  const matches = ctx.allFiles.filter((f) => {
    const first = fs.readFileSync(f, 'utf-8').split('\n')[0] ?? '';
    try {
      const entry = JSON.parse(first);
      if (entry.type === 'session_meta') {
        return (entry.payload?.id ?? '').startsWith(sessionId);
      }
    } catch {
      // skip
    }
    return false;
  });

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const f of matches) console.error(`  ${path.basename(f, '.jsonl')}`);
    process.exit(1);
  }

  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

function loadSessionDetail(ctx: CodexContext, sessionId: string): SessionDetail {
  const file = resolveSessionFile(ctx, sessionId);
  const parsed = parseSessionFile(file);
  const subagentFiles = ctx.subagentIndex.get(parsed.sessionId) ?? [];
  const summary = parsedToSummary(parsed, subagentFiles.length);
  const subagents = subagentFiles.map((f) => parsedToSubagent(parseSessionFile(f)));
  return { ...summary, subagents };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions (default)
  session <id>         Detailed single-session report

Options:
  --project, -p <path> Filter sessions by project directory
  --user-dir, -u <dir> Codex config dir (default: ~/.codex)
  --json               Machine-readable JSON output
  --sort <field>       Sort by: date, tokens, duration, tools (default: date)
  --limit, -n <N>      Limit to N sessions
  --no-color           Disable ANSI colors
  -h, --help           Show this help`;

const adapter: SessionUsageAdapter<CodexContext> = {
  help: HELP,
  defaultUserDir: '~/.codex',
  resolveContext(args, userDir) {
    const sessionsDir = path.join(userDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      console.error(`Codex sessions directory not found: ${sessionsDir}`);
      process.exit(1);
    }
    const allFiles = findAllSessionFiles(sessionsDir);
    return {
      sessionsDir,
      filterCwd: resolveProjectPath(args.projectArg),
      allFiles,
      subagentIndex: buildSubagentIndex(allFiles),
    };
  },
  listSessions,
  loadSessionDetail,
};

runSessionUsageCli(adapter);
