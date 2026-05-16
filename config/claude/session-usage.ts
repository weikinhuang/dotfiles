#!/usr/bin/env node
// Claude Code session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import { readJsonlLines } from '../../lib/node/ai-tooling/jsonl.ts';
import { makeSessionPreview } from '../../lib/node/ai-tooling/preview.ts';
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

interface ClaudeContext {
  projectsDir: string;
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

function resolveProjectDir(projectsDir: string, projectArg: string, required: boolean): { dir: string; slug: string } {
  let slug = projectArg;
  if (slug && (slug.startsWith('/') || slug.startsWith('~') || slug.startsWith('.'))) {
    const resolved = slug.startsWith('~') ? path.join(process.env.HOME ?? '', slug.slice(1)) : path.resolve(slug);
    slug = detectProjectSlug(projectsDir, resolved);
  }
  if (!slug) slug = detectProjectSlug(projectsDir, process.cwd());
  if (!slug) {
    if (!required) return { dir: '', slug: '' };
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

interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeToolResultTextItem {
  text?: string;
}

interface ClaudeContentBlock {
  type?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  tool_use_id?: string;
  content?: string | ClaudeToolResultTextItem[];
  text?: string;
}

interface ClaudeMessage {
  model?: string;
  id?: string;
  usage?: ClaudeUsage;
  content?: string | ClaudeContentBlock[];
}

interface ClaudeEntry {
  timestamp?: string;
  type?: string;
  message?: ClaudeMessage;
}

interface ClaudeSubagentMeta {
  agentType?: string;
  description?: string;
}

interface ParsedEntries {
  startTime: string;
  endTime: string;
  model: string;
  tokens: SessionTokens;
  modelBreakdown: ModelTokenBreakdown[];
  toolCalls: number;
  toolBytes: number;
  toolBreakdown: Record<string, number>;
  skills: string[];
  userTurns: number;
  preview: string;
  lastContextTokens?: number;
}

function emptyTokens(): SessionTokens {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function parseEntries(entries: ClaudeEntry[]): ParsedEntries {
  const tokens: SessionTokens = emptyTokens();
  const perModel = new Map<string, SessionTokens>();
  let toolCalls = 0;
  let toolBytes = 0;
  let userTurns = 0;
  let preview = '';
  let startTime = '';
  let endTime = '';
  let model = '';
  const toolBreakdown: Record<string, number> = {};
  const skillCandidates = new Map<string, string>();
  const failedToolUseIds = new Set<string>();
  // Claude Code splits one assistant response across multiple JSONL entries
  // (e.g. thinking block, then tool_use chunks) and repeats the full `usage`
  // object on each one. Count usage exactly once per message.id so we don't
  // double-count tokens - tool_use blocks are still aggregated across all
  // entries since they are partial slices of the complete response.
  const countedMessageIds = new Set<string>();
  // Track the most recent assistant turn's context consumption (input +
  // cache_creation + cache_read). Since JSONL entries are in chronological
  // order and each distinct message.id carries an identical `usage` object,
  // overwriting on every newly-seen id yields the last completed turn.
  let lastAssistantMsgId = '';
  let lastContextTokens: number | undefined;

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type === 'assistant') {
      const msgModel: string = entry.message?.model ?? '';
      if (!model && msgModel) model = msgModel;
      const msgId: string | undefined = entry.message?.id;
      const usageAlreadyCounted = msgId ? countedMessageIds.has(msgId) : false;
      if (entry.message?.usage && !usageAlreadyCounted) {
        if (msgId) countedMessageIds.add(msgId);
        const u = entry.message.usage;
        const dIn = u.input_tokens ?? 0;
        const dCw = u.cache_creation_input_tokens ?? 0;
        const dCr = u.cache_read_input_tokens ?? 0;
        const dOut = u.output_tokens ?? 0;
        if (msgId && msgId !== lastAssistantMsgId) {
          lastAssistantMsgId = msgId;
          lastContextTokens = dIn + dCw + dCr;
        } else if (!msgId) {
          // No id - still track the latest usage we saw.
          lastContextTokens = dIn + dCw + dCr;
        }
        tokens.input += dIn;
        tokens.cacheWrite! += dCw;
        tokens.cacheRead += dCr;
        tokens.output += dOut;

        const key = msgModel || model || 'unknown';
        const slice = perModel.get(key) ?? emptyTokens();
        slice.input += dIn;
        slice.cacheWrite! += dCw;
        slice.cacheRead += dCr;
        slice.output += dOut;
        perModel.set(key, slice);
      }

      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            toolCalls++;
            const name: string = block.name ?? 'unknown';
            toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
            if (name === 'Skill' && typeof block.input?.skill === 'string' && block.id) {
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
          if (!preview) {
            const snippet = makeSessionPreview(content);
            if (snippet) preview = snippet;
          }
        }
      }

      if (Array.isArray(content)) {
        // First-user-message preview can also arrive as an array of content
        // blocks when Claude Code includes tool results and a user text
        // block in the same entry. Prefer the earliest `text` block.
        if (!preview) {
          for (const block of content) {
            if (block.type === 'tool_result') continue;
            if (typeof block.text === 'string' && block.text.trim()) {
              const snippet = makeSessionPreview(block.text);
              if (snippet) {
                preview = snippet;
                break;
              }
            }
          }
        }
        for (const block of content) {
          if (block.type === 'tool_result') {
            if (block.is_error && block.tool_use_id) failedToolUseIds.add(block.tool_use_id);
            const rc = block.content;
            if (typeof rc === 'string') {
              toolBytes += rc.length;
            } else if (Array.isArray(rc)) {
              for (const item of rc) {
                if (typeof item?.text === 'string') {
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

  const modelBreakdown: ModelTokenBreakdown[] = [];
  // Pick a representative display model: the one with the most output tokens.
  let dominantModel = model;
  let dominantOutput = -1;
  for (const [m, t] of perModel) {
    modelBreakdown.push({ model: m, tokens: t });
    if (t.output > dominantOutput) {
      dominantOutput = t.output;
      dominantModel = m;
    }
  }
  if (dominantModel) model = dominantModel;

  return {
    startTime,
    endTime,
    model,
    tokens,
    modelBreakdown,
    toolCalls,
    toolBytes,
    toolBreakdown,
    skills: [...new Set(skills)].sort(),
    userTurns,
    preview,
    lastContextTokens,
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
  if (parsed.modelBreakdown.length > 0) summary.modelBreakdown = parsed.modelBreakdown;
  if (parsed.preview) summary.preview = parsed.preview;
  if (parsed.lastContextTokens !== undefined) summary.lastContextTokens = parsed.lastContextTokens;
  return summary;
}

function parseSessionFile(filePath: string): SessionSummary {
  const sessionId = path.basename(filePath, '.jsonl');
  const parsed = parseEntries(readJsonlLines<ClaudeEntry>(filePath));

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
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ClaudeSubagentMeta;
        agentType = meta.agentType ?? '';
        description = meta.description ?? '';
      } catch {
        // skip
      }
    }

    const parsed = parseEntries(readJsonlLines<ClaudeEntry>(path.join(subagentDir, jsonlFile)));
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
    if (parsed.modelBreakdown.length > 0) sa.modelBreakdown = parsed.modelBreakdown;
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
  if (matches.length === 1) return path.join(projectDir, matches[0]);
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const f of matches) console.error(`  ${f.replace('.jsonl', '')}`);
    process.exit(1);
  }

  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

function listSessions(ctx: ClaudeContext): SessionSummary[] {
  if (!ctx.projectDir) return [];
  return listSessionFiles(ctx.projectDir).map(parseSessionFile);
}

function listAllSessions(ctx: ClaudeContext): SessionSummary[] {
  const slugs = listProjectSlugs(ctx.projectsDir);
  const out: SessionSummary[] = [];
  for (const slug of slugs) {
    const dir = path.join(ctx.projectsDir, slug);
    for (const file of listSessionFiles(dir)) out.push(parseSessionFile(file));
  }
  return out;
}

function loadSessionDetail(ctx: ClaudeContext, sessionId: string): SessionDetail {
  if (!ctx.projectDir) {
    console.error('Could not detect project from $PWD. Use --project <slug> to specify one.');
    process.exit(1);
  }
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
  totals               Usage totals bucketed by day or week. Aggregates across
                       all projects unless --project is given.

Options:
  --project, -p <slug> Project slug (default: derived from $PWD)
  --user-dir, -u <dir> Claude config dir (default: ~/.claude)
  --json               Machine-readable JSON output
  --sort <field>       list: date, tokens, duration, tools
                       totals: date, tokens, tools, cost (default: date)
  --limit, -n <N>      Limit to N rows
  --group-by, -g <p>   totals period: day or week (default: day)
  --no-cost            Skip cost estimation (no pricing fetch)
  --refresh-prices     Force-refresh the cached LiteLLM pricing table
  --no-color           Disable ANSI colors
  -h, --help           Show this help

Cost is an estimate from token counts × model pricing (LiteLLM JSON,
cached for 7 days at ~/.cache/ai-tool-usage/pricing.json).`;

const adapter: SessionUsageAdapter<ClaudeContext> = {
  help: HELP,
  defaultUserDir: '~/.claude',
  sessionArgLabel: '<uuid>',
  resolveContext(args, userDir) {
    const projectsDir = path.join(userDir, 'projects');
    // The totals command defaults to all projects, so don't force a project
    // match when the user omitted --project.
    const required = args.command !== 'totals' || !!args.projectArg;
    const { dir, slug } = resolveProjectDir(projectsDir, args.projectArg, required);
    return { projectsDir, projectDir: dir, projectSlug: slug };
  },
  listSessions,
  listAllSessions,
  loadSessionDetail,
  listLabel: (ctx) => ctx.projectSlug,
  costVariant: 'anthropic',
};

runSessionUsageCli(adapter).catch((err) => {
  console.error(err);
  process.exit(1);
});
