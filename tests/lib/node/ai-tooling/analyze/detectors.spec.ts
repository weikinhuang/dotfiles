import { describe, expect, test } from 'vitest';

import {
  DEFAULT_DETECTOR_CONFIG,
  detectCacheBust,
  detectCachePoisoning,
  detectCacheWriteDominant,
  detectLargeContextCarry,
  detectTtlExpiry,
  runDetectors,
} from '../../../../../lib/node/ai-tooling/analyze/detectors.ts';
import {
  type CachingModel,
  emptyTurnTokens,
  type NormalizedSession,
  type NormalizedTurn,
  type TurnTokens,
} from '../../../../../lib/node/ai-tooling/analyze/turn-model.ts';

// Anthropic cache rates relative to a $X input rate: cacheWrite 1.25x,
// cacheRead 0.1x. Synthetic costs use input rate 1e-6/token so the numbers
// stay legible.
const IN = 1e-6;

interface TurnSpec {
  cacheRead?: number;
  cacheWrite?: number;
  input?: number;
  output?: number;
  gap?: number;
  cachingModel?: CachingModel;
}

function mkTurn(index: number, spec: TurnSpec): NormalizedTurn {
  const tokens: TurnTokens = {
    ...emptyTurnTokens(),
    input: spec.input ?? 2,
    output: spec.output ?? 100,
    cacheReadInput: spec.cacheRead ?? 0,
    cacheWriteInput: spec.cacheWrite ?? 0,
  };
  const cost = {
    input: tokens.input * IN,
    output: tokens.output * IN,
    cacheRead: tokens.cacheReadInput * IN * 0.1,
    cacheWrite: tokens.cacheWriteInput * IN * 1.25,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  const turn: NormalizedTurn = {
    index,
    timestamp: new Date(Date.UTC(2026, 5, 26, 0, 0, 0) + index * 1000).toISOString(),
    role: 'assistant',
    cachingModel: spec.cachingModel ?? 'anthropic',
    tokens,
    cost,
  };
  if (spec.gap !== undefined) turn.gapSecFromPrev = spec.gap;
  return turn;
}

function mkSession(turns: NormalizedTurn[], harness: NormalizedSession['harness'] = 'pi'): NormalizedSession {
  return {
    harness,
    sessionId: 'syn',
    model: 'claude-opus-4-8',
    startTime: turns[0]?.timestamp ?? '',
    endTime: turns[turns.length - 1]?.timestamp ?? '',
    turns,
    costNeedsBackfill: false,
  };
}

const CFG = DEFAULT_DETECTOR_CONFIG;

describe('detectCachePoisoning', () => {
  test('flags a frozen-cacheRead run with cacheWrite dominating context', () => {
    // 6 turns: cacheRead pinned at 40000, cacheWrite ~100000 (>50% of context).
    const turns = Array.from({ length: 6 }, (_, i) => mkTurn(i, { cacheRead: 40000, cacheWrite: 100000 + i * 100 }));
    const f = detectCachePoisoning(mkSession(turns), CFG);
    expect(f).toHaveLength(1);
    expect(f[0].detector).toBe('cache-poisoning');
    expect(f[0].range.startIndex).toBe(0);
    expect(f[0].range.endIndex).toBe(5);
    expect(f[0].severity).toBe('critical');
    // dollars = sum of cacheWrite cost over the run.
    const expected = turns.reduce((a, t) => a + t.cost!.cacheWrite, 0);
    expect(f[0].dollarsAttributed).toBeCloseTo(expected, 6);
  });

  test('does NOT flag a healthy session where cacheRead grows each turn', () => {
    const turns = Array.from({ length: 8 }, (_, i) => mkTurn(i, { cacheRead: 10000 + i * 10000, cacheWrite: 2000 }));
    expect(detectCachePoisoning(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('does NOT flag a stable plateau with small cacheWrite (frozen read, low write share)', () => {
    // cacheRead frozen but cacheWrite only ~5% of context: cheap, not poison.
    const turns = Array.from({ length: 8 }, (_, i) => mkTurn(i, { cacheRead: 90000, cacheWrite: 4000 + i * 100 }));
    expect(detectCachePoisoning(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('requires at least poisonMinRun consecutive frozen turns', () => {
    const turns = Array.from({ length: 3 }, (_, i) => mkTurn(i, { cacheRead: 40000, cacheWrite: 100000 }));
    expect(detectCachePoisoning(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('ignores openai-style turns (no cache-write semantics)', () => {
    const turns = Array.from({ length: 6 }, (_, i) =>
      mkTurn(i, { cacheRead: 40000, cacheWrite: 0, input: 100000, cachingModel: 'openai' }),
    );
    expect(detectCachePoisoning(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('separates a low-write plateau from a following high-write poison run', () => {
    const healthy = Array.from({ length: 5 }, (_, i) => mkTurn(i, { cacheRead: 90000, cacheWrite: 3000 }));
    const poison = Array.from({ length: 6 }, (_, i) => mkTurn(5 + i, { cacheRead: 40000, cacheWrite: 110000 }));
    const f = detectCachePoisoning(mkSession([...healthy, ...poison]), CFG);
    expect(f).toHaveLength(1);
    expect(f[0].range.startIndex).toBe(5);
    expect(f[0].range.endIndex).toBe(10);
  });
});

describe('detectCacheWriteDominant', () => {
  test('flags when cacheWrite cost exceeds the dominant ratio of total', () => {
    const turns = Array.from({ length: 5 }, (_, i) => mkTurn(i, { cacheRead: 30000, cacheWrite: 120000 }));
    const f = detectCacheWriteDominant(mkSession(turns), CFG);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('critical');
    expect(f[0].range.turnCount).toBe(5);
  });

  test('does NOT flag a mixed session below the ratio', () => {
    // Heavy reads, light writes -> write share well under 0.7.
    const turns = Array.from({ length: 5 }, (_, i) => mkTurn(i, { cacheRead: 200000, cacheWrite: 2000 }));
    expect(detectCacheWriteDominant(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('returns nothing when there are no anthropic turns', () => {
    const turns = Array.from({ length: 5 }, (_, i) => mkTurn(i, { input: 100000, cachingModel: 'openai' }));
    expect(detectCacheWriteDominant(mkSession(turns), CFG)).toHaveLength(0);
  });
});

describe('detectTtlExpiry', () => {
  test('flags a cacheRead->0 drop after an idle gap longer than the TTL', () => {
    const turns = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 90000, gap: 1300 }),
      mkTurn(2, { cacheRead: 90000, cacheWrite: 1000, gap: 30 }),
    ];
    const f = detectTtlExpiry(mkSession(turns), CFG);
    expect(f).toHaveLength(1);
    expect(f[0].range.startIndex).toBe(1);
    expect(f[0].dollarsAttributed).toBeCloseTo(turns[1].cost!.cacheWrite, 6);
  });

  test('does NOT flag a cacheRead->0 drop within the TTL (content mutation, not idle)', () => {
    const turns = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 90000, gap: 80 }),
    ];
    expect(detectTtlExpiry(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('does NOT flag an empty turn with no re-write', () => {
    const turns = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 0, output: 0, gap: 1300 }),
    ];
    expect(detectTtlExpiry(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('does NOT flag when the predecessor was not warm', () => {
    const turns = [
      mkTurn(0, { cacheRead: 0, cacheWrite: 0, output: 0 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 90000, gap: 1300 }),
    ];
    expect(detectTtlExpiry(mkSession(turns), CFG)).toHaveLength(0);
  });
});

describe('detectCacheBust', () => {
  test('flags a cacheRead->0 collapse WITHIN the TTL (non-idle bust)', () => {
    const turns = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 90000, gap: 80 }), // 80s < 300s TTL
      mkTurn(2, { cacheRead: 90000, cacheWrite: 1000, gap: 30 }),
    ];
    const f = detectCacheBust(mkSession(turns), CFG);
    expect(f).toHaveLength(1);
    expect(f[0].detector).toBe('cache-bust');
    expect(f[0].range.startIndex).toBe(1);
    expect(f[0].dollarsAttributed).toBeCloseTo(turns[1].cost!.cacheWrite, 6);
  });

  test('is mutually exclusive with ttl-expiry by the gap threshold', () => {
    // gap >= TTL -> ttl-expiry, not a bust.
    const idle = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 90000, gap: 1300 }),
    ];
    expect(detectCacheBust(mkSession(idle), CFG)).toHaveLength(0);
    expect(detectTtlExpiry(mkSession(idle), CFG)).toHaveLength(1);

    // gap < TTL -> bust, not ttl-expiry.
    const bust = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 90000, gap: 80 }),
    ];
    expect(detectTtlExpiry(mkSession(bust), CFG)).toHaveLength(0);
    expect(detectCacheBust(mkSession(bust), CFG)).toHaveLength(1);
  });

  test('does NOT flag an empty turn with no re-write', () => {
    const turns = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 0, output: 0, gap: 80 }),
    ];
    expect(detectCacheBust(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('does NOT flag when the gap is unknown (cannot rule out idle)', () => {
    const turns = [
      mkTurn(0, { cacheRead: 50000, cacheWrite: 1000 }),
      mkTurn(1, { cacheRead: 0, cacheWrite: 90000 }), // no gap
    ];
    expect(detectCacheBust(mkSession(turns), CFG)).toHaveLength(0);
  });
});

describe('detectLargeContextCarry', () => {
  test('flags a sustained large-context stretch', () => {
    const turns = Array.from({ length: 10 }, (_, i) => mkTurn(i, { cacheRead: 200000, cacheWrite: 2000 }));
    const f = detectLargeContextCarry(mkSession(turns), CFG);
    expect(f).toHaveLength(1);
    expect(f[0].range.turnCount).toBe(10);
    const expected = turns.reduce((a, t) => a + t.cost!.cacheRead, 0);
    expect(f[0].dollarsAttributed).toBeCloseTo(expected, 6);
  });

  test('does NOT flag a small-context session', () => {
    const turns = Array.from({ length: 10 }, (_, i) => mkTurn(i, { cacheRead: 40000, cacheWrite: 2000 }));
    expect(detectLargeContextCarry(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('does NOT flag a large-context run shorter than largeContextMinRun', () => {
    const turns = Array.from({ length: 4 }, (_, i) => mkTurn(i, { cacheRead: 200000, cacheWrite: 2000 }));
    expect(detectLargeContextCarry(mkSession(turns), CFG)).toHaveLength(0);
  });

  test('a single TTL re-write turn inside the stretch does not fragment the run', () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      i === 5
        ? mkTurn(i, { cacheRead: 0, cacheWrite: 210000, gap: 1300 }) // TTL re-write, still large context
        : mkTurn(i, { cacheRead: 200000, cacheWrite: 2000 }),
    );
    const f = detectLargeContextCarry(mkSession(turns), CFG);
    expect(f).toHaveLength(1);
    expect(f[0].range.turnCount).toBe(10);
  });
});

describe('runDetectors', () => {
  test('aggregates findings sorted by first turn', () => {
    const turns = [
      ...Array.from({ length: 6 }, (_, i) => mkTurn(i, { cacheRead: 40000, cacheWrite: 110000 })),
      ...Array.from({ length: 10 }, (_, i) => mkTurn(6 + i, { cacheRead: 200000, cacheWrite: 2000 })),
    ];
    const findings = runDetectors(mkSession(turns));
    const ids = findings.map((f) => f.detector);
    expect(ids).toContain('cache-poisoning');
    expect(ids).toContain('large-context-carry');
    // sorted by startIndex non-decreasing
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i].range.startIndex).toBeGreaterThanOrEqual(findings[i - 1].range.startIndex);
    }
  });
});
