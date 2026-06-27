// pi session-log adapter: raw pi JSONL entries -> NormalizedSession.
//
// Pure: the caller (CLI / bin) reads the file with `readJsonlLines` and hands
// the parsed entry array here. pi precomputes per-message cost, so no pricing
// backfill is needed - `costNeedsBackfill` is false whenever every assistant
// turn carried a cost object.
// SPDX-License-Identifier: MIT

import {
  annotateGaps,
  classifyCachingModel,
  emptyTurnTokens,
  type NormalizedSession,
  type NormalizedTurn,
  refineLocalCachingModel,
  type TurnCost,
} from '../analyze/turn-model.ts';
import { makeSessionPreview } from '../preview.ts';

// Subset of pi's session record shape needed for the cost/cache series. See
// config/pi/session-usage.ts for the fuller picture.
interface PiUsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: PiUsageCost;
}

interface PiContentBlock {
  type?: string;
  text?: string;
  name?: string;
}

interface PiMessage {
  role?: string;
  model?: string;
  provider?: string;
  usage?: PiUsage;
  timestamp?: string;
  content?: string | PiContentBlock[];
}

export interface PiEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  message?: PiMessage;
}

function piCost(cost: PiUsageCost): TurnCost {
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    total: cost.total ?? 0,
  };
}

function countImageBlocks(content: string | PiContentBlock[] | undefined): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b.type === 'image' || b.type === 'imageUrl').length;
}

// One-line preview of an assistant turn: its text, or a `→ tool, tool`
// summary when the turn is pure tool calls.
function assistantPreview(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return makeSessionPreview(content, 48);
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
  if (text.trim()) return makeSessionPreview(text, 48);
  const tools = content.filter((b) => b.type === 'toolCall' && b.name).map((b) => b.name);
  return tools.length > 0 ? makeSessionPreview(`→ ${tools.join(', ')}`, 48) : '';
}

export function piToNormalized(entries: PiEntry[], fallbackSessionId: string): NormalizedSession {
  let sessionId = fallbackSessionId;
  let startTime = '';
  let endTime = '';
  // The model/provider in force, updated by model_change. Assistant messages
  // also carry their own model/provider, which wins for that response.
  let currentModel = '';
  let currentProvider = '';
  let sessionModel = '';
  const turns: NormalizedTurn[] = [];
  let costNeedsBackfill = false;

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    if (entry.type === 'session') {
      if (entry.id) sessionId = entry.id;
      if (entry.timestamp && !startTime) startTime = entry.timestamp;
      continue;
    }

    const ts = entry.timestamp ?? entry.message?.timestamp ?? '';
    if (ts) {
      if (!startTime) startTime = ts;
      endTime = ts;
    }

    if (entry.type === 'model_change') {
      if (entry.modelId) {
        currentModel = entry.modelId;
        if (!sessionModel) sessionModel = entry.modelId;
      }
      if (entry.provider) currentProvider = entry.provider;
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;
    const m = entry.message;
    if (m.role !== 'assistant' || !m.usage) continue;

    const model = m.model ?? currentModel;
    const provider = m.provider ?? currentProvider;
    if (!sessionModel && model) sessionModel = model;

    const u = m.usage;
    const turn: NormalizedTurn = {
      index: turns.length,
      timestamp: ts,
      role: 'assistant',
      model: model || undefined,
      cachingModel: classifyCachingModel(provider, model),
      tokens: {
        ...emptyTurnTokens(),
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheReadInput: u.cacheRead ?? 0,
        cacheWriteInput: u.cacheWrite ?? 0,
      },
    };

    if (u.cost) {
      turn.cost = piCost(u.cost);
    } else {
      costNeedsBackfill = true;
    }

    const imageBlockCount = countImageBlocks(m.content);
    if (imageBlockCount > 0) {
      turn.body = {
        approxContextTokens: turn.tokens.input + turn.tokens.cacheReadInput + turn.tokens.cacheWriteInput,
        imageBlockCount,
        largeToolResultBytes: 0,
      };
    }

    const preview = assistantPreview(m.content);
    if (preview) turn.preview = preview;

    turns.push(turn);
  }

  annotateGaps(turns);
  refineLocalCachingModel(turns);

  return {
    harness: 'pi',
    sessionId,
    model: sessionModel,
    startTime,
    endTime,
    turns,
    costNeedsBackfill,
  };
}
