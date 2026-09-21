// GitHub Copilot CLI usage rows -> NormalizedSession.
//
// Copilot stores one assistant_usage_events row per model request in SQLite.
// Root-agent rows have no parent_tool_call_id; the CLI filters child-agent
// rows before calling this pure adapter. Costs are not stored in USD, so the
// shared pricing backfill derives the per-component estimate from tokens.
// SPDX-License-Identifier: MIT

import {
  annotateGaps,
  classifyCachingModel,
  emptyTurnTokens,
  type NormalizedSession,
  type NormalizedTurn,
  refineLocalCachingModel,
} from '../analyze/turn-model.ts';

export interface CopilotUsageEvent {
  model?: string;
  copilotUsageModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  createdAt?: string;
}

export interface CopilotSessionMeta {
  sessionId: string;
  startTime?: string;
  endTime?: string;
}

export function copilotToNormalized(events: CopilotUsageEvent[], meta: CopilotSessionMeta): NormalizedSession {
  let sessionModel = '';
  const turns: NormalizedTurn[] = [];

  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const model = event.model ?? event.copilotUsageModel ?? '';
    if (!sessionModel && model) sessionModel = model;

    turns.push({
      index: turns.length,
      timestamp: event.createdAt ?? '',
      role: 'assistant',
      model: model || undefined,
      cachingModel: classifyCachingModel(undefined, model),
      tokens: {
        ...emptyTurnTokens(),
        input: event.inputTokens ?? 0,
        output: (event.outputTokens ?? 0) + (event.reasoningTokens ?? 0),
        cacheReadInput: event.cacheReadTokens ?? 0,
        cacheWriteInput: event.cacheWriteTokens ?? 0,
      },
    });
  }

  annotateGaps(turns);
  refineLocalCachingModel(turns);

  return {
    harness: 'copilot',
    sessionId: meta.sessionId,
    model: sessionModel,
    startTime: meta.startTime ?? turns[0]?.timestamp ?? '',
    endTime: meta.endTime ?? turns[turns.length - 1]?.timestamp ?? '',
    turns,
    costNeedsBackfill: turns.length > 0,
  };
}
