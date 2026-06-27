import { describe, expect, test } from 'vitest';

import { piToNormalized, type PiEntry } from '../../../../../lib/node/ai-tooling/adapters/pi-adapter.ts';

// Minimal synthetic pi session: header, model_change, two assistant turns
// with precomputed cost, and an interleaved user message that carries no
// usage (must be ignored by the turn series).
function fixtureEntries(): PiEntry[] {
  return [
    { type: 'session', id: 'sess-abc', timestamp: '2026-06-26T00:00:00.000Z', cwd: '/home/u/proj' },
    { type: 'model_change', provider: 'amazon-bedrock', modelId: 'us.anthropic.claude-opus-4-8' },
    {
      type: 'message',
      timestamp: '2026-06-26T00:00:05.000Z',
      message: {
        role: 'assistant',
        usage: {
          input: 2,
          output: 100,
          cacheRead: 0,
          cacheWrite: 30000,
          cost: { input: 0.00001, output: 0.0025, cacheRead: 0, cacheWrite: 0.1875, total: 0.19 },
        },
      },
    },
    { type: 'message', timestamp: '2026-06-26T00:00:30.000Z', message: { role: 'user', content: 'hi' } },
    {
      type: 'message',
      timestamp: '2026-06-26T00:01:05.000Z',
      message: {
        role: 'assistant',
        usage: {
          input: 2,
          output: 50,
          cacheRead: 30000,
          cacheWrite: 500,
          cost: { input: 0.00001, output: 0.00125, cacheRead: 0.0009, cacheWrite: 0.003125, total: 0.005 },
        },
      },
    },
  ];
}

describe('piToNormalized', () => {
  test('extracts only assistant turns carrying usage', () => {
    const s = piToNormalized(fixtureEntries(), 'fallback');
    expect(s.turns).toHaveLength(2);
    expect(s.turns.every((t) => t.role === 'assistant')).toBe(true);
  });

  test('carries session id, model, and chronological bounds', () => {
    const s = piToNormalized(fixtureEntries(), 'fallback');
    expect(s.harness).toBe('pi');
    expect(s.sessionId).toBe('sess-abc');
    expect(s.model).toBe('us.anthropic.claude-opus-4-8');
    expect(s.startTime).toBe('2026-06-26T00:00:00.000Z');
    expect(s.endTime).toBe('2026-06-26T00:01:05.000Z');
  });

  test('classifies a Bedrock-served Claude model as anthropic caching', () => {
    const s = piToNormalized(fixtureEntries(), 'fallback');
    expect(s.turns[0].cachingModel).toBe('anthropic');
  });

  test('maps pi usage fields onto the neutral token + cost model', () => {
    const s = piToNormalized(fixtureEntries(), 'fallback');
    const [t0] = s.turns;
    expect(t0.tokens).toEqual({ input: 2, output: 100, cacheReadInput: 0, cacheWriteInput: 30000 });
    expect(t0.cost).toEqual({ input: 0.00001, output: 0.0025, cacheRead: 0, cacheWrite: 0.1875, total: 0.19 });
  });

  test('cost is precomputed so no backfill is flagged', () => {
    const s = piToNormalized(fixtureEntries(), 'fallback');
    expect(s.costNeedsBackfill).toBe(false);
  });

  test('annotates wall-clock gap between consecutive turns', () => {
    const s = piToNormalized(fixtureEntries(), 'fallback');
    expect(s.turns[0].gapSecFromPrev).toBeUndefined();
    // 00:01:05 - 00:00:05 = 60s
    expect(s.turns[1].gapSecFromPrev).toBe(60);
  });

  test('falls back to the supplied session id when no header id is present', () => {
    const entries = fixtureEntries().filter((e) => e.type !== 'session');
    const s = piToNormalized(entries, 'from-filename');
    expect(s.sessionId).toBe('from-filename');
  });

  test('flags backfill when an assistant turn lacks cost', () => {
    const entries: PiEntry[] = [
      { type: 'model_change', provider: 'amazon-bedrock', modelId: 'us.anthropic.claude-opus-4-8' },
      {
        type: 'message',
        timestamp: '2026-06-26T00:00:05.000Z',
        message: { role: 'assistant', usage: { input: 2, output: 100, cacheRead: 0, cacheWrite: 30000 } },
      },
    ];
    const s = piToNormalized(entries, 'x');
    expect(s.costNeedsBackfill).toBe(true);
    expect(s.turns[0].cost).toBeUndefined();
  });

  test('previews assistant text, falling back to a tool-call summary', () => {
    const entries: PiEntry[] = [
      { type: 'model_change', provider: 'amazon-bedrock', modelId: 'claude-opus-4-8' },
      {
        type: 'message',
        timestamp: '2026-06-26T00:00:05.000Z',
        message: {
          role: 'assistant',
          usage: { input: 2, output: 10, cacheRead: 0, cacheWrite: 100, cost: { total: 0.01 } },
          content: [{ type: 'text', text: 'Let me check the auth flow' }],
        },
      },
      {
        type: 'message',
        timestamp: '2026-06-26T00:00:10.000Z',
        message: {
          role: 'assistant',
          usage: { input: 2, output: 10, cacheRead: 100, cacheWrite: 10, cost: { total: 0.01 } },
          content: [
            { type: 'toolCall', name: 'read' },
            { type: 'toolCall', name: 'bash' },
          ],
        },
      },
    ];
    const s = piToNormalized(entries, 'x');
    expect(s.turns[0].preview).toBe('Let me check the auth flow');
    expect(s.turns[1].preview).toBe('\u2192 read, bash');
  });
});
