// Provider-neutral per-turn session model for the cost / caching analyzer.
//
// Every harness adapter (pi, claude, codex, opencode) parses its native
// session log into a `NormalizedSession`: an ordered series of
// `NormalizedTurn`s, one per assistant request/response, carrying the token
// and (optionally precomputed) cost accounting that the detectors reason
// about. Detectors are pure functions of `NormalizedSession` and branch only
// on `cachingModel` - never on harness name - so the same poisoning /
// TTL-churn / large-context logic works across every harness.
// SPDX-License-Identifier: MIT

export type Harness = 'pi' | 'claude' | 'codex' | 'opencode';

// Which provider's prompt-cache semantics this turn ran under. Detectors key
// off this, not the harness:
//   anthropic - explicit cache breakpoints; usage splits cache_creation
//               (write, billed 1.25x/2x) from cache_read (billed 0.1x).
//   openai    - automatic prefix cache; usage reports cached_tokens only
//               (no explicit write line); failure mode is a low cached ratio.
//   none      - local / non-caching backends (llama.cpp etc.); cache
//               detectors no-op.
export type CachingModel = 'anthropic' | 'openai' | 'none';

export interface TurnTokens {
  // Fresh (uncached) input tokens for this request.
  input: number;
  // Output / completion tokens (includes reasoning for OpenAI-style).
  output: number;
  // Anthropic cache_read_input_tokens / OpenAI cached_tokens.
  cacheReadInput: number;
  // Anthropic cache_creation_input_tokens; always 0 for OpenAI-style.
  cacheWriteInput: number;
}

export interface TurnCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// Optional body-shape metrics for the image / large-result detectors. Filled
// only by adapters whose logs carry the per-message content blocks.
export interface TurnBody {
  approxContextTokens: number;
  imageBlockCount: number;
  largeToolResultBytes: number;
}

export interface NormalizedTurn {
  // 0-based position in the assistant-turn series (not the raw line number).
  index: number;
  timestamp: string;
  role: 'assistant' | 'user' | 'tool' | 'other';
  model?: string;
  cachingModel: CachingModel;
  tokens: TurnTokens;
  // Present when the log precomputes cost (pi, opencode) or after
  // `fillTurnCosts` backfills it from a pricing table (claude, codex).
  cost?: TurnCost;
  body?: TurnBody;
  // Wall-clock seconds since the previous turn in the series. Undefined on
  // the first turn. Drives the TTL-expiry detector.
  gapSecFromPrev?: number;
  // Short one-line preview of this assistant turn's message content (text,
  // falling back to its tool-call names). Populated where the log carries
  // the content on the assistant record (pi, claude); empty otherwise.
  preview?: string;
}

export interface NormalizedSession {
  harness: Harness;
  sessionId: string;
  model: string;
  startTime: string;
  endTime: string;
  // Assistant turns in chronological order, each one request/response that
  // carried usage. This is the series every detector walks.
  turns: NormalizedTurn[];
  // True when at least one turn lacks `cost` (the log did not precompute it).
  // The CLI uses this to decide whether a pricing-table backfill is needed.
  costNeedsBackfill: boolean;
}

// Maps a (provider, modelId) pair to the prompt-cache semantics its usage
// numbers obey. Order matters: a Claude model served via Bedrock has provider
// "amazon-bedrock" but is still anthropic-style, so the model id is consulted
// too. Anything that is neither Anthropic- nor OpenAI-flavored (local
// llama.cpp, unknown backends) is `none` and the cache detectors skip it.
export function classifyCachingModel(provider?: string, modelId?: string): CachingModel {
  const p = (provider ?? '').toLowerCase();
  const m = (modelId ?? '').toLowerCase();
  if (p.includes('anthropic') || p.includes('bedrock') || m.includes('claude') || m.includes('anthropic')) {
    return 'anthropic';
  }
  if (
    p.includes('openai') ||
    p.includes('azure') ||
    p === 'codex' ||
    m.includes('gpt') ||
    /^o[0-9]/.test(m) ||
    m.includes('codex')
  ) {
    return 'openai';
  }
  return 'none';
}

export function emptyTurnTokens(): TurnTokens {
  return { input: 0, output: 0, cacheReadInput: 0, cacheWriteInput: 0 };
}

export function emptyTurnCost(): TurnCost {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

// Approximate context size carried into a turn's request: the prompt the
// provider had to assemble = fresh input + the cached-read prefix + whatever
// was (re)written to cache this turn. For OpenAI-style turns cacheWriteInput
// is 0, so this is input + cached.
export function turnContextTokens(turn: NormalizedTurn): number {
  const t = turn.tokens;
  return t.input + t.cacheReadInput + t.cacheWriteInput;
}

export interface SessionCostTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function sessionCostTotals(session: NormalizedSession): SessionCostTotals {
  const acc: SessionCostTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const turn of session.turns) {
    if (!turn.cost) continue;
    acc.input += turn.cost.input;
    acc.output += turn.cost.output;
    acc.cacheRead += turn.cost.cacheRead;
    acc.cacheWrite += turn.cost.cacheWrite;
    acc.total += turn.cost.total;
  }
  return acc;
}

// Wall-clock gap in seconds between two ISO timestamps, or undefined when
// either is missing / unparseable. Negative gaps (clock skew, out-of-order
// records) clamp to 0.
export function gapSeconds(prevIso: string, currIso: string): number | undefined {
  if (!prevIso || !currIso) return undefined;
  const prev = new Date(prevIso).getTime();
  const curr = new Date(currIso).getTime();
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return undefined;
  return Math.max(0, (curr - prev) / 1000);
}

// Stamps `gapSecFromPrev` onto each turn from consecutive timestamps. Adapters
// call this after building the turn series so the TTL detector has gaps.
export function annotateGaps(turns: NormalizedTurn[]): void {
  for (let i = 1; i < turns.length; i++) {
    const gap = gapSeconds(turns[i - 1].timestamp, turns[i].timestamp);
    if (gap !== undefined) turns[i].gapSecFromPrev = gap;
  }
}

export interface ModelChange {
  // Turn index where the new model first appears.
  index: number;
  from: string;
  to: string;
  timestamp?: string;
}

// Points in the assistant-turn series where the active model changed (e.g. a
// /model switch). A model switch busts the prompt cache, so these are worth
// annotating next to the cache series. Turns with no model are skipped (they
// don't establish or break a model run).
export function modelChanges(session: NormalizedSession): ModelChange[] {
  const out: ModelChange[] = [];
  let last = '';
  for (const t of session.turns) {
    const m = t.model ?? '';
    if (!m) continue;
    if (last && m !== last) out.push({ index: t.index, from: last, to: m, timestamp: t.timestamp || undefined });
    last = m;
  }
  return out;
}
