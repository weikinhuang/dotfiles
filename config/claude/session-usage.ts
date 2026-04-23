#!/usr/bin/env node
// Claude Code session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import { readJsonlLines } from '../../lib/node/ai-tooling/jsonl.ts';
import type { SessionDetail, SessionSummary, SessionTokens, Subagent } from '../../lib/node/ai-tooling/types.ts';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ClaudeContext {
  projectDir: string;
  projectSlug: string;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

function cwdToSlug(dir: string): string {
  return dir.replace(/[/.]/g, '-');
}

function detectProjectSlug(projectsDir: string, cwd: string): string {
  let dir = cwd;
  while (dir !== '/') {
    const slug = cwdToSlug(dir);
    if (fs.existsSync(path.join(projectsDir, slug))) return slug;
    dir = path.dirname(dir);
  }
  return '';
}

function listProjectSlugs(projectsDir: string): string[] {
  if (!fs.existsSync(projectsDir)) return [];
  return fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function resolveProjectDir(projectsDir: string, projectArg: string): { dir: string; slug: string } {
  let slug = projectArg;
  if (slug && (slug.startsWith('/') || slug.startsWith('~') || slug.startsWith('.'))) {
    const resolved = slug.startsWith('~') ? path.join(process.env.HOME ?? '', slug.slice(1)) : path.resolve(slug);
    slug = detectProjectSlug(projectsDir, resolved);
  }
  if (!slug) slug = detectProjectSlug(projectsDir, process.cwd());
  if (!slug) {
    console.error('Could not detect project from $PWD. Use --project <slug> to specify one.');
    const projects = listProjectSlugs(projectsDir);
    if (projects.length > 0) {
      console.error('\nAvailable projects:');
      for (const p of projects) console.error(`  ${p}`);
    }
    process.exit(1);
  }
  const dir = path.join(projectsDir, slug);
  if (!fs.existsSync(dir)) {
    console.error(`Project directory not found: ${dir}`);
    process.exit(1);
  }
  return { dir, slug };
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

interface ParsedEntries {
  startTime: string;
  endTime: string;
  model: string;
  tokens: SessionTokens;
  toolCalls: number;
  toolBytes: number;
  toolBreakdown: Record<string, number>;
  skills: string[];
  userTurns: number;
}

function parseEntries(entries: any[]): ParsedEntries {
  const tokens: SessionTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let toolCalls = 0;
  let toolBytes = 0;
  let userTurns = 0;
  let startTime = '';
  let endTime = '';
  let model = '';
  const toolBreakdown: Record<string, number> = {};
  const skillCandidates = new Map<string, string>();
  const failedToolUseIds = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type === 'assistant') {
      if (!model && entry.message?.model) model = entry.message.model;
      if (entry.message?.usage) {
        const u = entry.message.usage;
        tokens.input += u.input_tokens ?? 0;
        tokens.cacheWrite! += u.cache_creation_input_tokens ?? 0;
        tokens.cacheRead += u.cache_read_input_tokens ?? 0;
        tokens.output += u.output_tokens ?? 0;
      }

      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            toolCalls++;
            const name: string = block.name ?? 'unknown';
            toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
            if (name === 'Skill' && typeof block.input?.skill === 'string') {
              skillCandidates.set(block.id, block.input.skill);
            }
          }
        }
      }
    }

    if (entry.type === 'user') {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        if (!content.startsWith('<system-reminder>') && !content.startsWith('<local-command-')) {
          userTurns++;
        }
      }

      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block?.type === 'tool_result') {
            if (block.is_error) failedToolUseIds.add(block.tool_use_id);
            const rc = block.content;
            if (typeof rc === 'string') {
              toolBytes += rc.length;
            } else if (Array.isArray(rc)) {
              for (const item of rc) {
                if (typeof item === 'object' && typeof item?.text === 'string') {
                  toolBytes += item.text.length;
                }
              }
            }
          }
        }
      }
    }
  }

  const skills: string[] = [];
  for (const [toolUseId, skillName] of skillCandidates) {
    if (!failedToolUseIds.has(toolUseId)) skills.push(skillName);
  }

  return {
    startTime,
    endTime,
    model,
    tokens,
    toolCalls,
    toolBytes,
    toolBreakdown,
    skills: [...new Set(skills)].sort(),
    userTurns,
  };
}

function buildSummary(sessionId: string, parsed: ParsedEntries, subagentCount: number): SessionSummary {
  const startMs = parsed.startTime ? new Date(parsed.startTime).getTime() : 0;
  const endMs = parsed.endTime ? new Date(parsed.endTime).getTime() : 0;
  const durationSecs = startMs && endMs ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;

  const summary: SessionSummary = {
    sessionId,
    model: parsed.model,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    durationSecs,
    userTurns: parsed.userTurns,
    tokens: parsed.tokens,
    toolCalls: parsed.toolCalls,
    toolBreakdown: parsed.toolBreakdown,
    subagentCount,
  };
  if (parsed.toolBytes > 0) summary.toolBytes = parsed.toolBytes;
  if (parsed.skills.length > 0) summary.skills = parsed.skills;
  return summary;
}

function parseSessionFile(filePath: string): SessionSummary {
  const sessionId = path.basename(filePath, '.jsonl');
  const parsed = parseEntries(readJsonlLines(filePath));

  const sessionDir = filePath.replace(/\.jsonl$/, '');
  const subagentDir = path.join(sessionDir, 'subagents');
  let subagentCount = 0;
  if (fs.existsSync(subagentDir)) {
    subagentCount = fs.readdirSync(subagentDir).filter((f) => f.endsWith('.jsonl')).length;
  }

  return buildSummary(sessionId, parsed, subagentCount);
}

function parseSubagents(sessionFilePath: string): Subagent[] {
  const sessionDir = sessionFilePath.replace(/\.jsonl$/, '');
  const subagentDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentDir)) return [];

  const result: Subagent[] = [];
  for (const jsonlFile of fs.readdirSync(subagentDir).filter((f) => f.endsWith('.jsonl'))) {
    const agentId = jsonlFile.replace('.jsonl', '');
    const metaPath = path.join(subagentDir, `${agentId}.meta.json`);

    let agentType = '';
    let description = '';
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        agentType = meta.agentType ?? '';
        description = meta.description ?? '';
      } catch {
        // skip
      }
    }

    const parsed = parseEntries(readJsonlLines(path.join(subagentDir, jsonlFile)));
    const sa: Subagent = {
      agentId,
      agentLabel: agentType,
      model: parsed.model,
      tokens: parsed.tokens,
      toolCalls: parsed.toolCalls,
      toolBreakdown: parsed.toolBreakdown,
    };
    if (description) sa.description = description;
    if (parsed.skills.length > 0) sa.skills = parsed.skills;
    result.push(sa);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Adapter operations
// ---------------------------------------------------------------------------

function listSessionFiles(projectDir: string): string[] {
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(projectDir, f));
}

function resolveSessionFile(projectDir: string, sessionId: string): string {
  const exact = path.join(projectDir, `${sessionId}.jsonl`);
  if (fs.existsSync(exact)) return exact;

  const matches = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl') && f.startsWith(sessionId));
  if (matches.length === 1) return path.join(projectDir, matches[0]!);
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const f of matches) console.error(`  ${f.replace('.jsonl', '')}`);
    process.exit(1);
  }

  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

function listSessions(ctx: ClaudeContext): SessionSummary[] {
  return listSessionFiles(ctx.projectDir).map(parseSessionFile);
}

function loadSessionDetail(ctx: ClaudeContext, sessionId: string): SessionDetail {
  const file = resolveSessionFile(ctx.projectDir, sessionId);
  const summary = parseSessionFile(file);
  const subagents = parseSubagents(file);
  return { ...summary, subagents };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions in a project (default)
  session <uuid>       Detailed single-session report

Options:
  --project, -p <slug> Project slug (default: derived from $PWD)
  --user-dir, -u <dir> Claude config dir (default: ~/.claude)
  --json               Machine-readable JSON output
  --sort <field>       Sort by: date, tokens, duration, tools (default: date)
  --limit, -n <N>      Limit to N sessions
  --no-color           Disable ANSI colors
  -h, --help           Show this help`;

const adapter: SessionUsageAdapter<ClaudeContext> = {
  help: HELP,
  defaultUserDir: '~/.claude',
  sessionArgLabel: '<uuid>',
  resolveContext(args, userDir) {
    const projectsDir = path.join(userDir, 'projects');
    const { dir, slug } = resolveProjectDir(projectsDir, args.projectArg);
    return { projectDir: dir, projectSlug: slug };
  },
  listSessions,
  loadSessionDetail,
  listLabel: (ctx) => ctx.projectSlug,
};

runSessionUsageCli(adapter);
