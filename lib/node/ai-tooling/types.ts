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
  agent?: string;
  directory?: string;
  version?: string;
  toolBytes?: number;
  skills?: string[];
  cost?: number;
}

export interface SessionDetail extends SessionSummary {
  subagents: Subagent[];
}
