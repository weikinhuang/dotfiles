import { describe, expect, test } from 'vitest';

import { fillTurnCosts, priceTurn } from '../../../../../lib/node/ai-tooling/analyze/pricing-fill.ts';
import {
  emptyTurnTokens,
  type NormalizedSession,
  type NormalizedTurn,
} from '../../../../../lib/node/ai-tooling/analyze/turn-model.ts';
import { type ModelPricing, type PricingTable } from '../../../../../lib/node/ai-tooling/pricing.ts';

const ANTHROPIC_P: ModelPricing = {
  inputPerToken: 1e-5,
  outputPerToken: 5e-5,
  cacheReadPerToken: 1e-6, // 0.1x
  cacheWritePerToken: 1.25e-5, // 1.25x
};
const OPENAI_P: ModelPricing = {
  inputPerToken: 1e-6,
  outputPerToken: 4e-6,
  cacheReadPerToken: 2.5e-7, // 0.25x
};

function table(models: Record<string, ModelPricing>): PricingTable {
  return { models, fetchedAt: '2026-01-01T00:00:00Z', source: 'cache' };
}

function turn(over: Partial<NormalizedTurn>): NormalizedTurn {
  return {
    index: 0,
    timestamp: '2026-06-26T00:00:00.000Z',
    role: 'assistant',
    cachingModel: 'anthropic',
    tokens: emptyTurnTokens(),
    ...over,
  };
}

function session(turns: NormalizedTurn[], model: string): NormalizedSession {
  return {
    harness: 'claude',
    sessionId: 's',
    model,
    startTime: '',
    endTime: '',
    turns,
    costNeedsBackfill: true,
  };
}

describe('priceTurn', () => {
  test('anthropic splits fresh input, cacheRead, and cacheWrite at their own rates', () => {
    const cost = priceTurn(
      'anthropic',
      { ...emptyTurnTokens(), input: 100, output: 200, cacheReadInput: 1000, cacheWriteInput: 500 },
      ANTHROPIC_P,
    );
    expect(cost.input).toBeCloseTo(100 * 1e-5, 12);
    expect(cost.output).toBeCloseTo(200 * 5e-5, 12);
    expect(cost.cacheRead).toBeCloseTo(1000 * 1e-6, 12);
    expect(cost.cacheWrite).toBeCloseTo(500 * 1.25e-5, 12);
    expect(cost.total).toBeCloseTo(cost.input + cost.output + cost.cacheRead + cost.cacheWrite, 12);
  });

  test('openai prices only the fresh (uncached) slice of input + the cached slice', () => {
    // input is the grand total (cached included); fresh = input - cacheRead.
    const cost = priceTurn(
      'openai',
      { ...emptyTurnTokens(), input: 10000, output: 500, cacheReadInput: 8000, cacheWriteInput: 0 },
      OPENAI_P,
    );
    expect(cost.input).toBeCloseTo(2000 * 1e-6, 12); // fresh = 10000 - 8000
    expect(cost.cacheRead).toBeCloseTo(8000 * 2.5e-7, 12);
    expect(cost.cacheWrite).toBe(0);
  });

  test('falls back to default cache multipliers when the table omits them', () => {
    const bare: ModelPricing = { inputPerToken: 1e-5, outputPerToken: 5e-5 };
    const cost = priceTurn('anthropic', { ...emptyTurnTokens(), cacheReadInput: 1000, cacheWriteInput: 1000 }, bare);
    expect(cost.cacheRead).toBeCloseTo(1000 * 1e-5 * 0.1, 12);
    expect(cost.cacheWrite).toBeCloseTo(1000 * 1e-5 * 1.25, 12);
  });
});

describe('fillTurnCosts', () => {
  test('fills cost on turns that lack it and clears the backfill flag', () => {
    const s = session(
      [turn({ tokens: { ...emptyTurnTokens(), input: 100, output: 200, cacheReadInput: 1000, cacheWriteInput: 500 } })],
      'claude-opus-4-8',
    );
    const res = fillTurnCosts(s, table({ 'claude-opus-4-8': ANTHROPIC_P }));
    expect(res.filled).toBe(1);
    expect(res.unpricedModels).toEqual([]);
    expect(s.turns[0].cost).toBeDefined();
    expect(s.costNeedsBackfill).toBe(false);
  });

  test('leaves existing cost untouched', () => {
    const existing = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 };
    const s = session([turn({ cost: existing })], 'claude-opus-4-8');
    const res = fillTurnCosts(s, table({ 'claude-opus-4-8': ANTHROPIC_P }));
    expect(res.filled).toBe(0);
    expect(s.turns[0].cost).toBe(existing);
  });

  test('reports unpriced models and leaves their turns without cost', () => {
    const s = session([turn({ model: 'mystery-model-9' })], 'mystery-model-9');
    const res = fillTurnCosts(s, table({ 'claude-opus-4-8': ANTHROPIC_P }));
    expect(res.filled).toBe(0);
    expect(res.unpricedModels).toEqual(['mystery-model-9']);
    expect(s.turns[0].cost).toBeUndefined();
  });

  test('prefers the per-turn model over the session model', () => {
    const s = session(
      [turn({ model: 'gpt-5', cachingModel: 'openai', tokens: { ...emptyTurnTokens(), input: 1000 } })],
      'claude-opus-4-8',
    );
    const res = fillTurnCosts(s, table({ 'gpt-5': OPENAI_P }));
    expect(res.filled).toBe(1);
    expect(s.turns[0].cost!.input).toBeCloseTo(1000 * 1e-6, 12);
  });
});
