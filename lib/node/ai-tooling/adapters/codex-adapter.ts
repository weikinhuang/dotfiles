// Codex CLI session-log adapter: raw codex JSONL entries -> NormalizedSession.
//
// Codex emits a `token_count` event per turn whose `info.last_token_usage`
// carries that turn's usage (input_tokens is the grand total, inclusive of
// the cached slice; cached_input_tokens is the cached read). Quota-ping
// `token_count` events arrive with `info: null` and are skipped. Codex is
// OpenAI-style: there is no cache-write line, so the poisoning signature is a
// low cached ratio, not a write spike. Cost is not stored -> backfill.
// SPDX-License-Identifier: MIT

import {
  annotateGaps,
  emptyTurnTokens,
  type NormalizedSession,
  type NormalizedTurn,
  refineLocalCachingModel,
} from '../analyze/turn-model.ts';

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexPayload {
  id?: string;
  model?: string;
  type?: string;
  info?: {
    last_token_usage?: CodexTokenUsage | null;
    model_context_window?: number;
  } | null;
}

export interface CodexEntry {
  timestamp?: string;
  type?: string;
  payload?: CodexPayload;
}

export function codexToNormalized(entries: CodexEntry[], fallbackSessionId: string): NormalizedSession {
  let sessionId = fallbackSessionId;
  let sessionModel = '';
  let currentModel = '';
  let startTime = '';
  let endTime = '';
  const turns: NormalizedTurn[] = [];

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type === 'session_meta' && entry.payload?.id && sessionId === fallbackSessionId) {
      sessionId = entry.payload.id;
      continue;
    }

    if (entry.type === 'turn_context' && entry.payload?.model) {
      currentModel = entry.payload.model;
      if (!sessionModel) sessionModel = currentModel;
      continue;
    }

    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
    const last = entry.payload.info?.last_token_usage;
    if (!last) continue; // quota-ping event (info: null) or no per-turn usage

    const model = currentModel || sessionModel;
    if (!sessionModel && model) sessionModel = model;

    turns.push({
      index: turns.length,
      timestamp: entry.timestamp ?? '',
      role: 'assistant',
      model: model || undefined,
      cachingModel: 'openai',
      tokens: {
        ...emptyTurnTokens(),
        // OpenAI input_tokens is the grand total (cached included).
        input: last.input_tokens ?? 0,
        // Output billing includes reasoning tokens.
        output: (last.output_tokens ?? 0) + (last.reasoning_output_tokens ?? 0),
        cacheReadInput: last.cached_input_tokens ?? 0,
        cacheWriteInput: 0,
      },
    });
  }

  annotateGaps(turns);
  refineLocalCachingModel(turns);

  return {
    harness: 'codex',
    sessionId,
    model: sessionModel,
    startTime,
    endTime,
    turns,
    costNeedsBackfill: turns.length > 0,
  };
}
