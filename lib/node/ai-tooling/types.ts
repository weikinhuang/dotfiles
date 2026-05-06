// Canonical data types for session-usage adapters.
// SPDX-License-Identifier: MIT
//
// Tools (claude, codex, opencode) parse their native session logs into
// these shared shapes. Common fields are required; tool-specific fields
// are optional and auto-hidden by the renderer when absent.

export interface SessionTokens {
  input: number;
  cacheRead: number;
  output: number;
  cacheWrite?: number;
  reasoning?: number;
}

// Per-model token accounting inside a single session or subagent. When a
// session switches models mid-stream (e.g. Claude Code's /model command),
// adapters emit one entry per model so cost estimation can price each slice
// at its own rate instead of charging everything at the first-seen model's
// price. `cost` is populated by the CLI cost annotator.
export interface ModelTokenBreakdown {
  model: string;
  tokens: SessionTokens;
  cost?: number;
}

export interface Subagent {
  agentId: string;
  agentLabel: string;
  model: string;
  tokens: SessionTokens;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  role?: string;
  description?: string;
  skills?: string[];
  cost?: number;
  modelBreakdown?: ModelTokenBreakdown[];
}

export interface SessionSummary {
  sessionId: string;
  model: string;
  startTime: string;
  endTime: string;
  durationSecs: number;
  userTurns: number;
  tokens: SessionTokens;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  subagentCount: number;
  title?: string;
  // Auto-derived single-line snippet of the first user message. Populated
  // by every adapter so list / detail renderers have context for sessions
  // that share the same model and directory. Title (when set explicitly by
  // the user via /name / opencode's auto-titling) takes priority over this.
  preview?: string;
  agent?: string;
  directory?: string;
  version?: string;
  toolBytes?: number;
  skills?: string[];
  cost?: number;
  modelBreakdown?: ModelTokenBreakdown[];
  // Context consumed on the most recent completed assistant turn (input +
  // cache_read + cache_write). This is not a true "next message" prediction
  // — the next request will add any post-last-assistant user text and tool
  // results on top — but it is the best signal available from a closed log.
  // Populated by every adapter whose session format carries per-turn usage.
  lastContextTokens?: number;
  // Model context window max, when the log carries it (Codex only today).
  // Kept separate from the LiteLLM-derived lookup so JSON consumers can tell
  // an authoritative value from an estimate.
  contextWindow?: number;
}

export interface SessionDetail extends SessionSummary {
  subagents: Subagent[];
}
