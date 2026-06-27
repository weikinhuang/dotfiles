import { describe, expect, test } from 'vitest';

import {
  emptyTurnTokens,
  modelChanges,
  type NormalizedSession,
  type NormalizedTurn,
  refineLocalCachingModel,
} from '../../../../../lib/node/ai-tooling/analyze/turn-model.ts';

function mkTurn(index: number, over: Partial<NormalizedTurn> = {}): NormalizedTurn {
  return {
    index,
    timestamp: new Date(Date.UTC(2026, 5, 21, 0, index)).toISOString(),
    role: 'assistant',
    cachingModel: 'none',
    tokens: emptyTurnTokens(),
    ...over,
  };
}

function mkSession(turns: NormalizedTurn[]): NormalizedSession {
  return {
    harness: 'pi',
    sessionId: 'x',
    model: turns[0]?.model ?? '',
    startTime: turns[0]?.timestamp ?? '',
    endTime: turns.at(-1)?.timestamp ?? '',
    turns,
    costNeedsBackfill: false,
  };
}

describe('refineLocalCachingModel', () => {
  test('upgrades a local model that reports cache reads to openai (whole run)', () => {
    // A llama.cpp-style run: cold turn 0, warm middle, then an idle eviction
    // (turn 2 drops cacheRead back to 0). The cold eviction turn must also be
    // openai so the read-side detectors can see it.
    const turns = [
      mkTurn(0, { model: 'gemma4-31b', tokens: { input: 22725, output: 900, cacheReadInput: 1, cacheWriteInput: 0 } }),
      mkTurn(1, {
        model: 'gemma4-31b',
        tokens: { input: 151, output: 400, cacheReadInput: 22726, cacheWriteInput: 0 },
      }),
      mkTurn(2, { model: 'gemma4-31b', tokens: { input: 23000, output: 200, cacheReadInput: 0, cacheWriteInput: 0 } }),
    ];
    refineLocalCachingModel(turns);
    expect(turns.map((t) => t.cachingModel)).toEqual(['openai', 'openai', 'openai']);
  });

  test('leaves a truly cache-blind local model as none', () => {
    const turns = [
      mkTurn(0, {
        model: 'mystery-local',
        tokens: { input: 5000, output: 100, cacheReadInput: 0, cacheWriteInput: 0 },
      }),
      mkTurn(1, {
        model: 'mystery-local',
        tokens: { input: 5200, output: 120, cacheReadInput: 0, cacheWriteInput: 0 },
      }),
    ];
    refineLocalCachingModel(turns);
    expect(turns.map((t) => t.cachingModel)).toEqual(['none', 'none']);
  });

  test('does not touch turns already classified anthropic/openai', () => {
    const turns = [
      mkTurn(0, {
        model: 'claude',
        cachingModel: 'anthropic',
        tokens: { input: 2, output: 5, cacheReadInput: 0, cacheWriteInput: 100 },
      }),
      mkTurn(1, {
        model: 'gpt-5',
        cachingModel: 'openai',
        tokens: { input: 2, output: 5, cacheReadInput: 50, cacheWriteInput: 0 },
      }),
    ];
    refineLocalCachingModel(turns);
    expect(turns.map((t) => t.cachingModel)).toEqual(['anthropic', 'openai']);
  });

  test('decides per model, not session-wide', () => {
    const turns = [
      mkTurn(0, { model: 'reader', tokens: { input: 10, output: 5, cacheReadInput: 9000, cacheWriteInput: 0 } }),
      mkTurn(1, { model: 'no-cache', tokens: { input: 9000, output: 5, cacheReadInput: 0, cacheWriteInput: 0 } }),
    ];
    refineLocalCachingModel(turns);
    expect(turns.map((t) => t.cachingModel)).toEqual(['openai', 'none']);
  });
});

describe('modelChanges', () => {
  test('reports each switch point with from/to and turn index', () => {
    const turns = [
      mkTurn(0, { model: 'qwen3-6-35b-a3b' }),
      mkTurn(1, { model: 'claude-opus-4-7' }),
      mkTurn(2, { model: 'claude-opus-4-7' }),
    ];
    expect(modelChanges(mkSession(turns))).toEqual([
      { index: 1, from: 'qwen3-6-35b-a3b', to: 'claude-opus-4-7', timestamp: turns[1].timestamp },
    ]);
  });

  test('returns empty for a single-model session and skips turns with no model', () => {
    const turns = [mkTurn(0, { model: 'm' }), mkTurn(1, {}), mkTurn(2, { model: 'm' })];
    expect(modelChanges(mkSession(turns))).toEqual([]);
  });
});
