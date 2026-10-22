// Shared reader for GitHub Copilot CLI session event logs.
//
// Copilot writes one directory per session under
// `$COPILOT_HOME/session-state/<uuid>/` holding `events.jsonl` (the canonical
// log that `--resume` replays) and `workspace.yaml` (display name, cwd, ...).
// Each JSONL line is `{ type, data, id, timestamp, parentId, agentId? }`.
// The events this reader folds into a session record:
//
//   session.start         data.{sessionId, copilotVersion, startTime, selectedModel, context.cwd}
//   session.shutdown      written on process exit (end time only when nothing later exists)
//   user.message          data.content (one per user prompt)
//   session.usage_record  data.usage.{model, inputTokens, outputTokens, cacheReadTokens,
//                         cacheWriteTokens, reasoningTokens, cost, parentToolCallId}
//   tool.execution_start  data.{toolCallId, toolName, parentToolCallId}
//   subagent.started      data.{toolCallId, agentName, agentDisplayName, agentDescription, model}
//
// `inputTokens` includes cached prompt tokens (input >= cacheRead + cacheWrite).
// Usage / tool events from a sub-agent carry `parentToolCallId` (the tool call
// that spawned it, matching `subagent.started.toolCallId`) and a top-level
// `agentId`; root-agent events carry neither.
//
// Sessions written before `session.usage_record` existed (copilot <= ~1.0.93,
// which logged `model.model_call_success` instead) are reported as `legacy`
// and are not parsed. `session-store.db` is not read.
//
// Used by config/copilot/session-usage.ts and the ai-cost-doctor loader.
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeSessionPreview } from './preview.ts';
import { type ModelTokenBreakdown, type SessionTokens, type Subagent } from './types.ts';

export interface CopilotEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  // Sub-agent instance id; absent for root-agent and session-level events.
  agentId?: string;
}

export interface CopilotSessionDir {
  // Directory name (the session uuid).
  id: string;
  dir: string;
  // Absent when the session never got a prompt (no events.jsonl written).
  eventsPath?: string;
  mtimeMs: number;
}

// One `session.usage_record` (one model call).
export interface CopilotUsageRecord {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  // Premium-request multiplier cost for the call (not USD).
  premiumCost: number;
  // Sub-agent grouping key; undefined for root-agent calls.
  subagentKey?: string;
}

export interface CopilotSessionRecord {
  sessionId: string;
  copilotVersion: string;
  startTime: string;
  endTime: string;
  cwd?: string;
  title?: string;
  preview: string;
  userTurns: number;
  // Dominant root model (most output tokens), else the selected model.
  model: string;
  tokens: SessionTokens;
  modelBreakdown: ModelTokenBreakdown[];
  lastContextTokens?: number;
  // Sum of usage_record `cost` over root + sub-agent calls (premium requests).
  premiumRequests: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  subagents: Subagent[];
  // Root-agent usage records in log order (the doctor's turn series).
  rootUsage: CopilotUsageRecord[];
}

export type CopilotParseResult =
  | { kind: 'ok'; session: CopilotSessionRecord }
  | { kind: 'legacy'; sessionId: string; copilotVersion: string };

export function defaultCopilotHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COPILOT_HOME) return env.COPILOT_HOME;
  return '~/.copilot';
}

export function copilotStateDir(userDir: string): string {
  return path.join(userDir, 'session-state');
}

export function copilotStateDirMissing(stateDir: string): string {
  return `GitHub Copilot session-state directory not found: ${stateDir}`;
}

export function copilotLegacyError(sessionId: string, copilotVersion: string): string {
  const version = copilotVersion || 'unknown';
  return `GitHub Copilot session ${sessionId} was recorded by copilot ${version} in the pre-usage_record event format, which is not supported (no session.usage_record events)`;
}

export function copilotSkippedLegacyNotice(count: number): string {
  return `skipped ${count} session(s) recorded in an unsupported older event format`;
}

// Non-empty string, else undefined (so `??` treats '' as missing).
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// Pure: parse JSONL text into events, skipping blank / malformed lines.
export function parseCopilotEvents(content: string): CopilotEvent[] {
  const out: CopilotEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = asRecord(raw);
    const type = asString(obj?.type);
    if (!obj || !type) continue;
    const event: CopilotEvent = { type, data: asRecord(obj.data) ?? {}, timestamp: asString(obj.timestamp) ?? '' };
    const agentId = asString(obj.agentId);
    if (agentId) event.agentId = agentId;
    out.push(event);
  }
  return out;
}

export function readCopilotEvents(eventsPath: string): CopilotEvent[] {
  return parseCopilotEvents(fs.readFileSync(eventsPath, 'utf-8'));
}

function unquoteYamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

// Pure: the display title from workspace.yaml text. Copilot writes the
// auto-generated / user-chosen title to `name:`; `summary:` is accepted as a
// fallback. Only top-level scalar keys are read: plain, quoted, or a block
// scalar (`|`, `|-`, `>`, ...) whose indented lines are joined with spaces.
export function parseWorkspaceTitle(yaml: string): string | undefined {
  const keys = new Map<string, string>();
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|summary):[ \t]*(.*)$/.exec(lines[i]);
    if (!m || keys.has(m[1])) continue;
    let value: string;
    if (/^[|>][-+]?$/.test(m[2].trim())) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        if (lines[i].trim()) block.push(lines[i].trim());
      }
      value = block.join(' ');
    } else {
      value = unquoteYamlScalar(m[2]);
    }
    if (value) keys.set(m[1], value);
  }
  return keys.get('name') ?? keys.get('summary');
}

export function readWorkspaceTitle(sessionDir: string): string | undefined {
  try {
    return parseWorkspaceTitle(fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf-8'));
  } catch {
    return undefined;
  }
}

// Every session directory under `stateDir`, with or without events.jsonl.
export function listCopilotSessionDirs(stateDir: string): CopilotSessionDir[] {
  const out: CopilotSessionDir[] = [];
  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(stateDir, entry.name);
    const eventsPath = path.join(dir, 'events.jsonl');
    let mtimeMs = 0;
    let hasEvents = false;
    try {
      const st = fs.statSync(eventsPath);
      hasEvents = st.isFile();
      mtimeMs = st.mtimeMs;
    } catch {
      // never prompted
    }
    const item: CopilotSessionDir = { id: entry.name, dir, mtimeMs };
    if (hasEvents) item.eventsPath = eventsPath;
    out.push(item);
  }
  return out;
}

export type CopilotDirPick =
  | { ok: true; session: CopilotSessionDir }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'ambiguous'; matches: string[] };

// Pure: exact directory-name match, else a unique prefix.
export function pickCopilotSessionDir(dirs: CopilotSessionDir[], idOrPrefix: string): CopilotDirPick {
  const exact = dirs.find((d) => d.id === idOrPrefix);
  if (exact) return { ok: true, session: exact };
  const matches = dirs.filter((d) => d.id.startsWith(idOrPrefix));
  if (matches.length === 1) return { ok: true, session: matches[0] };
  if (matches.length > 1) return { ok: false, error: 'ambiguous', matches: matches.map((d) => d.id).sort() };
  return { ok: false, error: 'not-found' };
}

function emptyTokens(): SessionTokens {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

function addUsage(tokens: SessionTokens, u: CopilotUsageRecord): void {
  tokens.input += u.inputTokens;
  tokens.output += u.outputTokens;
  tokens.cacheRead += u.cacheReadTokens;
  tokens.cacheWrite = (tokens.cacheWrite ?? 0) + u.cacheWriteTokens;
  tokens.reasoning = (tokens.reasoning ?? 0) + u.reasoningTokens;
}

interface FoldedUsage {
  model: string;
  tokens: SessionTokens;
  modelBreakdown: ModelTokenBreakdown[];
}

// Totals plus a per-model split; the dominant model has the most output.
function foldUsage(records: CopilotUsageRecord[]): FoldedUsage {
  const tokens = emptyTokens();
  const perModel = new Map<string, SessionTokens>();
  for (const u of records) {
    addUsage(tokens, u);
    const mt = perModel.get(u.model) ?? emptyTokens();
    addUsage(mt, u);
    perModel.set(u.model, mt);
  }
  const modelBreakdown: ModelTokenBreakdown[] = [];
  let model = '';
  let dominantOutput = -1;
  for (const [name, mt] of perModel) {
    modelBreakdown.push({ model: name, tokens: mt });
    if (mt.output > dominantOutput) {
      model = name;
      dominantOutput = mt.output;
    }
  }
  return { model, tokens, modelBreakdown };
}

function toUsageRecord(event: CopilotEvent): CopilotUsageRecord | undefined {
  const usage = asRecord(event.data.usage);
  if (!usage) return undefined;
  const record: CopilotUsageRecord = {
    timestamp: event.timestamp,
    model: asString(usage.model) ?? '',
    inputTokens: asNumber(usage.inputTokens),
    outputTokens: asNumber(usage.outputTokens),
    cacheReadTokens: asNumber(usage.cacheReadTokens),
    cacheWriteTokens: asNumber(usage.cacheWriteTokens),
    reasoningTokens: asNumber(usage.reasoningTokens),
    premiumCost: asNumber(usage.cost),
  };
  const key = asString(usage.parentToolCallId) ?? event.agentId;
  if (key) record.subagentKey = key;
  return record;
}

interface SubagentMeta {
  label: string;
  description?: string;
  model?: string;
}

interface SubagentAcc {
  usage: CopilotUsageRecord[];
  toolBreakdown: Record<string, number>;
  toolCalls: number;
}

// Pure: fold one session's events into a record. `sessionId` is the session
// directory name; `title` comes from workspace.yaml when available.
export function summarizeCopilotEvents(
  events: CopilotEvent[],
  meta: { sessionId: string; title?: string },
): CopilotParseResult {
  let copilotVersion = '';
  let startTime = '';
  let endTime = '';
  let cwd: string | undefined;
  let selectedModel = '';
  let userTurns = 0;
  let firstPrompt: string | undefined;
  let premiumRequests = 0;
  let sawUsageRecord = false;
  let sawLegacyModelCall = false;
  const rootUsage: CopilotUsageRecord[] = [];
  const subUsage: CopilotUsageRecord[] = [];
  const rootTools = new Map<string, string>();
  const subTools = new Map<string, { key: string; name: string }>();
  const subMeta = new Map<string, SubagentMeta>();

  let shutdownTime = '';
  for (const ev of events) {
    // End = last activity. session.shutdown is written when the CLI process
    // exits, which can be a day after the last prompt, so it only counts when
    // nothing else carries a timestamp.
    if (ev.type === 'session.shutdown') {
      if (ev.timestamp > shutdownTime) shutdownTime = ev.timestamp;
    } else if (ev.timestamp && ev.timestamp > endTime) {
      endTime = ev.timestamp;
    }
    const d = ev.data;
    switch (ev.type) {
      case 'session.start': {
        if (!copilotVersion) copilotVersion = asString(d.copilotVersion) ?? '';
        if (!startTime) startTime = asString(d.startTime) ?? ev.timestamp;
        if (!selectedModel) selectedModel = asString(d.selectedModel) ?? '';
        cwd ??= asString(asRecord(d.context)?.cwd);
        break;
      }
      case 'user.message': {
        if (ev.agentId) break;
        userTurns++;
        const content = asString(d.content);
        if (firstPrompt === undefined && content?.trim()) firstPrompt = content;
        break;
      }
      case 'session.usage_record': {
        sawUsageRecord = true;
        const u = toUsageRecord(ev);
        if (!u) break;
        premiumRequests += u.premiumCost;
        if (u.subagentKey) subUsage.push(u);
        else rootUsage.push(u);
        break;
      }
      case 'model.model_call_success':
        sawLegacyModelCall = true;
        break;
      case 'tool.execution_start': {
        const id = asString(d.toolCallId);
        const name = asString(d.toolName) ?? 'unknown';
        if (!id) break;
        const key = asString(d.parentToolCallId) ?? ev.agentId;
        if (key) {
          if (!subTools.has(id)) subTools.set(id, { key, name });
        } else if (!rootTools.has(id)) {
          rootTools.set(id, name);
        }
        break;
      }
      case 'subagent.started': {
        const id = asString(d.toolCallId);
        if (!id || subMeta.has(id)) break;
        const m: SubagentMeta = { label: asString(d.agentName) ?? asString(d.agentDisplayName) ?? 'subagent' };
        const description = asString(d.agentDescription);
        if (description) m.description = description;
        const model = asString(d.model);
        if (model) m.model = model;
        subMeta.set(id, m);
        break;
      }
      default:
        break;
    }
  }

  if (!sawUsageRecord && sawLegacyModelCall) {
    return { kind: 'legacy', sessionId: meta.sessionId, copilotVersion };
  }

  const root = foldUsage(rootUsage);
  let lastContextTokens: number | undefined;
  for (const u of rootUsage) {
    // inputTokens already includes cache read + cache write.
    const ctx = Math.max(u.inputTokens, u.cacheReadTokens + u.cacheWriteTokens);
    if (ctx > 0) lastContextTokens = ctx;
  }

  const toolBreakdown: Record<string, number> = {};
  for (const name of rootTools.values()) toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;

  // Sub-agents: every spawned agent (subagent.started) plus any usage / tool
  // key seen without a start event, in first-seen order.
  const subAcc = new Map<string, SubagentAcc>();
  const accFor = (key: string): SubagentAcc => {
    let acc = subAcc.get(key);
    if (!acc) {
      acc = { usage: [], toolBreakdown: {}, toolCalls: 0 };
      subAcc.set(key, acc);
    }
    return acc;
  };
  for (const key of subMeta.keys()) accFor(key);
  for (const u of subUsage) accFor(u.subagentKey ?? '').usage.push(u);
  for (const { key, name } of subTools.values()) {
    const acc = accFor(key);
    acc.toolCalls++;
    acc.toolBreakdown[name] = (acc.toolBreakdown[name] ?? 0) + 1;
  }
  const subagents: Subagent[] = [];
  for (const [key, acc] of subAcc) {
    const folded = foldUsage(acc.usage);
    const m = subMeta.get(key);
    let model = folded.model;
    if (!model) model = m?.model ?? '';
    const sa: Subagent = {
      agentId: key,
      agentLabel: m?.label ?? 'subagent',
      model,
      tokens: folded.tokens,
      toolCalls: acc.toolCalls,
      toolBreakdown: acc.toolBreakdown,
    };
    if (m?.description) sa.description = m.description;
    if (folded.modelBreakdown.length > 0) sa.modelBreakdown = folded.modelBreakdown;
    subagents.push(sa);
  }

  const session: CopilotSessionRecord = {
    sessionId: meta.sessionId,
    copilotVersion,
    startTime: startTime || (events[0]?.timestamp ?? ''),
    endTime: endTime || shutdownTime,
    preview: makeSessionPreview(firstPrompt),
    userTurns,
    model: root.model || selectedModel,
    tokens: root.tokens,
    modelBreakdown: root.modelBreakdown,
    premiumRequests,
    toolCalls: rootTools.size,
    toolBreakdown,
    subagents,
    rootUsage,
  };
  if (cwd) session.cwd = cwd;
  if (meta.title) session.title = meta.title;
  if (lastContextTokens !== undefined) session.lastContextTokens = lastContextTokens;
  return { kind: 'ok', session };
}

// A session with neither a user prompt nor a model call (opened and closed).
export function isEmptyCopilotSession(s: CopilotSessionRecord): boolean {
  return s.userTurns === 0 && s.rootUsage.length === 0 && s.subagents.length === 0;
}

// Reads + summarizes one session directory that has an events.jsonl.
export function loadCopilotSessionDir(entry: CopilotSessionDir): CopilotParseResult | undefined {
  if (!entry.eventsPath) return undefined;
  return summarizeCopilotEvents(readCopilotEvents(entry.eventsPath), {
    sessionId: entry.id,
    title: readWorkspaceTitle(entry.dir),
  });
}
