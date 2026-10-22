// opencode session-log adapter: parsed DB message rows -> NormalizedSession.
//
// opencode stores sessions in SQLite (not JSONL), so the CLI runs the query
// (see ../opencode-db.ts) and hands this pure adapter the already-parsed v2
// `session_message` objects plus session meta. The per-message caching model
// is derived from `model.providerID` (anthropic / openai / local). opencode records a scalar `cost`
// but not the cacheRead/cacheWrite split the detectors attribute against, so
// the adapter leaves cost for the pricing backfill to compute the component
// breakdown consistently (local llama.cpp turns are `none` + unpriced -> $0,
// which is correct).
// SPDX-License-Identifier: MIT

import {
  annotateGaps,
  classifyCachingModel,
  emptyTurnTokens,
  type NormalizedSession,
  type NormalizedTurn,
  refineLocalCachingModel,
} from '../analyze/turn-model.ts';

export interface OpencodeContentItem {
  type?: string;
  name?: string;
}

// One opencode v2 `session_message` row: the row's `type` (user / assistant /
// synthetic / idle) merged with its parsed JSON `data`.
export interface OpencodeMessage {
  type?: string;
  agent?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  cost?: number;
  content?: OpencodeContentItem[];
  time?: { created?: number; completed?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface OpencodeSessionMeta {
  sessionId: string;
  startTimeMs?: number;
  endTimeMs?: number;
}

function isoFromMs(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

export function opencodeToNormalized(messages: OpencodeMessage[], meta: OpencodeSessionMeta): NormalizedSession {
  let sessionModel = '';
  const turns: NormalizedTurn[] = [];

  for (const m of messages) {
    if (typeof m !== 'object' || m === null || m.type !== 'assistant') continue;
    const model = m.model?.id ?? '';
    const provider = m.model?.providerID ?? '';
    if (!sessionModel && model) sessionModel = model;

    const t = m.tokens ?? {};
    const cache = t.cache ?? {};
    turns.push({
      index: turns.length,
      timestamp: isoFromMs(m.time?.created),
      role: 'assistant',
      model: model || undefined,
      cachingModel: classifyCachingModel(provider, model),
      tokens: {
        ...emptyTurnTokens(),
        input: t.input ?? 0,
        output: (t.output ?? 0) + (t.reasoning ?? 0),
        cacheReadInput: cache.read ?? 0,
        cacheWriteInput: cache.write ?? 0,
      },
    });
  }

  annotateGaps(turns);
  refineLocalCachingModel(turns);

  return {
    harness: 'opencode',
    sessionId: meta.sessionId,
    model: sessionModel,
    startTime: isoFromMs(meta.startTimeMs) || turns[0]?.timestamp || '',
    endTime: isoFromMs(meta.endTimeMs) || turns[turns.length - 1]?.timestamp || '',
    turns,
    // Re-derive the cost breakdown from tokens via the pricing table so the
    // detectors get cacheRead/cacheWrite components opencode's scalar omits.
    costNeedsBackfill: turns.length > 0,
  };
}
