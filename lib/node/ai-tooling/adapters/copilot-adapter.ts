// GitHub Copilot CLI usage records -> NormalizedSession.
//
// Copilot logs one `session.usage_record` event per model call in
// session-state/<uuid>/events.jsonl (see ../copilot-events.ts). The caller
// passes only root-agent records (sub-agent calls carry parentToolCallId and
// are excluded). `inputTokens` includes cached tokens; Anthropic-style turns get
// the cache slices subtracted, OpenAI-style turns keep the grand total (the
// turn-model convention for each). Costs are premium
// requests, not USD, so the shared pricing backfill derives the per-component
// estimate from tokens.
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
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  timestamp?: string;
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
    const model = event.model ?? '';
    if (!sessionModel && model) sessionModel = model;

    const cacheRead = event.cacheReadTokens ?? 0;
    const cacheWrite = event.cacheWriteTokens ?? 0;
    const cachingModel = classifyCachingModel(undefined, model);
    const totalInput = event.inputTokens ?? 0;
    turns.push({
      index: turns.length,
      timestamp: event.timestamp ?? '',
      role: 'assistant',
      model: model || undefined,
      cachingModel,
      tokens: {
        ...emptyTurnTokens(),
        // `inputTokens` is the grand total (both cache slices included). The
        // turn model wants that for OpenAI-style turns (pricing subtracts the
        // cached read itself) but fresh input only for Anthropic-style turns.
        input: cachingModel === 'anthropic' ? Math.max(0, totalInput - cacheRead - cacheWrite) : totalInput,
        output: (event.outputTokens ?? 0) + (event.reasoningTokens ?? 0),
        cacheReadInput: cacheRead,
        cacheWriteInput: cacheWrite,
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
