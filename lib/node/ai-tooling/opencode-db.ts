// Shared reader for the opencode v2 SQLite session store.
//
// opencode >= 2 keeps sessions in `session_v2` (one row per session, with
// `parent_id` set for subagents) and `session_message` (one row per message,
// ordered by `seq`, discriminated by `type`: user / assistant / synthetic /
// idle). Assistant `data` carries per-message cost, token usage, the model,
// and an inline `content[]` list whose `{ type: 'tool', name }` items are the
// tool calls. The v1 `session` / `message` / `part` tables are not supported.
//
// Used by config/opencode/session-usage.ts and the ai-cost-doctor loader. The
// DB handle is passed in (structurally typed) so this module never imports
// node:sqlite itself and the doctor can keep its lazy import.
// SPDX-License-Identifier: MIT

import * as path from 'node:path';

import { type OpencodeMessage } from './adapters/opencode-adapter.ts';
import { expandUserPath } from './paths.ts';
import { type SessionTokens } from './types.ts';

type SqlParam = string | number | null;

export interface OpencodeDb {
  prepare(sql: string): {
    all(...params: SqlParam[]): unknown[];
    get(...params: SqlParam[]): unknown;
  };
}

export interface OpencodeSessionRow {
  id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string | null;
  version: string;
  time_created: number;
  time_updated: number;
}

export const OPENCODE_SESSION_COLUMNS = 'id, parent_id, slug, directory, title, version, time_created, time_updated';

export const OPENCODE_V2_REQUIRED =
  'opencode v2 database required (table session_v2 not found); opencode 1.x session stores are not supported';

// Default data dir, mirroring opencode's XDG lookup.
export function defaultOpencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'opencode') : '~/.local/share/opencode';
}

// Resolve the DB file: an explicit --user-dir wins, then OPENCODE_DB (set by
// the `opencode -u <profile>` wrapper), then the default data dir.
export function resolveOpencodeDbPath(explicitDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicitDir) return path.join(expandUserPath(explicitDir), 'opencode.db');
  if (env.OPENCODE_DB) return expandUserPath(env.OPENCODE_DB);
  return path.join(expandUserPath(defaultOpencodeDataDir(env)), 'opencode.db');
}

export function isOpencodeV2(db: OpencodeDb): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get();
  return row !== undefined;
}

// Messages for one session in `seq` order. The row `type` is folded into the
// parsed `data` object so downstream code sees one self-describing record.
export function readOpencodeMessages(db: OpencodeDb, sessionId: string): OpencodeMessage[] {
  const rows = db
    .prepare('SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as { type: string; data: string }[];
  const out: OpencodeMessage[] = [];
  for (const r of rows) {
    let data: unknown;
    try {
      data = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue;
    out.push({ ...(data as OpencodeMessage), type: r.type });
  }
  return out;
}

export interface OpencodeSessionStats {
  userTurns: number;
  model: string;
  agent: string;
  cost: number;
  tokens: SessionTokens;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  lastContextTokens?: number;
}

// Pure: fold a session's messages into usage totals. `lastContextTokens` is
// the full prompt of the most recent assistant message (input + cache write +
// cache read; opencode's `input` excludes cached tokens).
export function summarizeOpencodeMessages(messages: OpencodeMessage[]): OpencodeSessionStats {
  const stats: OpencodeSessionStats = {
    userTurns: 0,
    model: '',
    agent: '',
    cost: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    toolCalls: 0,
    toolBreakdown: {},
  };

  for (const m of messages) {
    if (m.type === 'user') {
      stats.userTurns++;
      continue;
    }
    if (m.type !== 'assistant') continue;

    if (!stats.agent && typeof m.agent === 'string') stats.agent = m.agent;
    if (typeof m.model?.id === 'string' && m.model.id) stats.model = m.model.id;
    if (typeof m.cost === 'number') stats.cost += m.cost;

    const t = m.tokens ?? {};
    stats.tokens.input += t.input ?? 0;
    stats.tokens.output += t.output ?? 0;
    stats.tokens.reasoning = (stats.tokens.reasoning ?? 0) + (t.reasoning ?? 0);
    stats.tokens.cacheWrite = (stats.tokens.cacheWrite ?? 0) + (t.cache?.write ?? 0);
    stats.tokens.cacheRead += t.cache?.read ?? 0;
    const turnInput = (t.input ?? 0) + (t.cache?.write ?? 0) + (t.cache?.read ?? 0);
    if (turnInput > 0) stats.lastContextTokens = turnInput;

    for (const c of m.content ?? []) {
      if (c?.type === 'tool' && typeof c.name === 'string' && c.name) {
        stats.toolCalls++;
        stats.toolBreakdown[c.name] = (stats.toolBreakdown[c.name] ?? 0) + 1;
      }
    }
  }

  return stats;
}
