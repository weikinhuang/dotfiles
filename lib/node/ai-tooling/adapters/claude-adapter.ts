// Claude Code session-log adapter: raw claude JSONL entries -> NormalizedSession.
//
// Claude Code splits one assistant response across multiple JSONL entries
// (thinking block, then tool_use chunks) and repeats the full `usage` object
// on each, so usage is counted once per `message.id`. Claude Code does not
// store cost, so `costNeedsBackfill` is always true - the CLI backfills via
// the pricing table. All Claude traffic is anthropic-style caching.
// SPDX-License-Identifier: MIT

import { annotateGaps, emptyTurnTokens, type NormalizedSession, type NormalizedTurn } from '../analyze/turn-model.ts';
import { makeSessionPreview } from '../preview.ts';

interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
}

interface ClaudeMessage {
  model?: string;
  id?: string;
  usage?: ClaudeUsage;
  content?: string | ClaudeContentBlock[];
}

export interface ClaudeEntry {
  timestamp?: string;
  type?: string;
  sessionId?: string;
  message?: ClaudeMessage;
}

function countImageBlocks(content: string | ClaudeContentBlock[] | undefined): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b.type === 'image').length;
}

// One-line preview of an assistant turn: its text, or a `→ tool, tool`
// summary when the turn is pure tool_use blocks.
function assistantPreview(content: string | ClaudeContentBlock[] | undefined): string {
  if (typeof content === 'string') return makeSessionPreview(content, 48);
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
  if (text.trim()) return makeSessionPreview(text, 48);
  const tools = content.filter((b) => b.type === 'tool_use' && b.name).map((b) => b.name);
  return tools.length > 0 ? makeSessionPreview(`→ ${tools.join(', ')}`, 48) : '';
}

export function claudeToNormalized(entries: ClaudeEntry[], fallbackSessionId: string): NormalizedSession {
  let sessionId = fallbackSessionId;
  let sessionModel = '';
  let startTime = '';
  let endTime = '';
  const turns: NormalizedTurn[] = [];
  const countedMessageIds = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (entry.sessionId && sessionId === fallbackSessionId) sessionId = entry.sessionId;
    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type !== 'assistant') continue;
    const m = entry.message;
    if (!m?.usage) continue;
    const u = m.usage;
    const msgId = m.id;
    if (msgId && countedMessageIds.has(msgId)) continue;
    if (msgId) countedMessageIds.add(msgId);

    const model = m.model ?? '';
    if (!sessionModel && model) sessionModel = model;

    const turn: NormalizedTurn = {
      index: turns.length,
      timestamp: entry.timestamp ?? '',
      role: 'assistant',
      model: model || undefined,
      cachingModel: 'anthropic',
      tokens: {
        ...emptyTurnTokens(),
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheReadInput: u.cache_read_input_tokens ?? 0,
        cacheWriteInput: u.cache_creation_input_tokens ?? 0,
      },
    };

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

  return {
    harness: 'claude',
    sessionId,
    model: sessionModel,
    startTime,
    endTime,
    turns,
    // Claude Code logs never carry cost.
    costNeedsBackfill: turns.length > 0,
  };
}
