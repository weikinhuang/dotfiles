import { describe, expect, test } from 'vitest';

import { claudeToNormalized, type ClaudeEntry } from '../../../../../lib/node/ai-tooling/adapters/claude-adapter.ts';
import { codexToNormalized, type CodexEntry } from '../../../../../lib/node/ai-tooling/adapters/codex-adapter.ts';
import {
  opencodeToNormalized,
  type OpencodeMessage,
} from '../../../../../lib/node/ai-tooling/adapters/opencode-adapter.ts';

describe('claudeToNormalized', () => {
  function entries(): ClaudeEntry[] {
    return [
      {
        type: 'assistant',
        timestamp: '2026-04-29T00:00:00.000Z',
        sessionId: 'cl-1',
        message: {
          id: 'msg_a',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 5330,
            cache_read_input_tokens: 9663,
            output_tokens: 170,
          },
        },
      },
      // Same message id repeated on a follow-up chunk: usage must NOT recount.
      {
        type: 'assistant',
        timestamp: '2026-04-29T00:00:01.000Z',
        message: { id: 'msg_a', model: 'claude-sonnet-4-6', usage: { input_tokens: 3, output_tokens: 170 } },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-29T00:00:30.000Z',
        message: {
          id: 'msg_b',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 15000,
            output_tokens: 50,
          },
        },
      },
    ];
  }

  test('counts each message id once and maps anthropic usage fields', () => {
    const s = claudeToNormalized(entries(), 'fallback');
    expect(s.harness).toBe('claude');
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0].cachingModel).toBe('anthropic');
    expect(s.turns[0].tokens).toEqual({ input: 3, output: 170, cacheReadInput: 9663, cacheWriteInput: 5330 });
    expect(s.sessionId).toBe('cl-1');
    expect(s.model).toBe('claude-sonnet-4-6');
  });

  test('always requests a cost backfill (Claude Code logs omit cost)', () => {
    expect(claudeToNormalized(entries(), 'x').costNeedsBackfill).toBe(true);
    expect(claudeToNormalized(entries(), 'x').turns[0].cost).toBeUndefined();
  });

  test('annotates the inter-turn gap from distinct message timestamps', () => {
    const s = claudeToNormalized(entries(), 'x');
    expect(s.turns[1].gapSecFromPrev).toBe(30);
  });
});

describe('codexToNormalized', () => {
  function entries(): CodexEntry[] {
    return [
      { type: 'session_meta', timestamp: '2026-03-16T20:00:00.000Z', payload: { id: 'cx-1' } },
      { type: 'turn_context', payload: { model: 'gpt-5.4' } },
      {
        type: 'event_msg',
        timestamp: '2026-03-16T20:00:10.000Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 14800,
              cached_input_tokens: 8960,
              output_tokens: 651,
              reasoning_output_tokens: 331,
            },
            model_context_window: 258400,
          },
        },
      },
      // Quota-ping event: info null -> must be skipped.
      { type: 'event_msg', timestamp: '2026-03-16T20:00:11.000Z', payload: { type: 'token_count', info: null } },
    ];
  }

  test('emits one turn per token_count event and maps openai usage', () => {
    const s = codexToNormalized(entries(), 'fallback');
    expect(s.harness).toBe('codex');
    expect(s.turns).toHaveLength(1);
    const [t] = s.turns;
    expect(t.cachingModel).toBe('openai');
    // input is the grand total; reasoning folds into output; no cache-write.
    expect(t.tokens).toEqual({ input: 14800, output: 651 + 331, cacheReadInput: 8960, cacheWriteInput: 0 });
    expect(s.sessionId).toBe('cx-1');
    expect(s.model).toBe('gpt-5.4');
  });

  test('skips quota-ping token_count events with null info', () => {
    expect(codexToNormalized(entries(), 'x').turns).toHaveLength(1);
  });

  test('requests a cost backfill (codex logs omit cost)', () => {
    expect(codexToNormalized(entries(), 'x').costNeedsBackfill).toBe(true);
  });
});

describe('opencodeToNormalized', () => {
  function messages(): OpencodeMessage[] {
    return [
      { role: 'user' },
      {
        role: 'assistant',
        modelID: 'claude-opus-4-8',
        providerID: 'anthropic',
        cost: 0.42,
        time: { created: Date.UTC(2026, 4, 1, 0, 0, 0), completed: Date.UTC(2026, 4, 1, 0, 0, 2) },
        tokens: { input: 5, output: 200, reasoning: 50, cache: { read: 40000, write: 1200 } },
      },
      {
        role: 'assistant',
        modelID: 'qwen3-5-35b-a3b',
        providerID: 'llama.cpp',
        cost: 0,
        time: { created: Date.UTC(2026, 4, 1, 0, 0, 30) },
        tokens: { input: 1000, output: 100, cache: { read: 0, write: 0 } },
      },
    ];
  }

  test('maps assistant rows, derives caching model from providerID', () => {
    const s = opencodeToNormalized(messages(), { sessionId: 'oc-1' });
    expect(s.harness).toBe('opencode');
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0].cachingModel).toBe('anthropic');
    expect(s.turns[0].tokens).toEqual({ input: 5, output: 250, cacheReadInput: 40000, cacheWriteInput: 1200 });
    expect(s.turns[1].cachingModel).toBe('none'); // local llama.cpp
  });

  test('skips non-assistant rows and converts epoch-ms to ISO', () => {
    const s = opencodeToNormalized(messages(), { sessionId: 'oc-1' });
    expect(s.turns.every((t) => t.role === 'assistant')).toBe(true);
    expect(s.turns[0].timestamp).toBe(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)).toISOString());
  });

  test('requests a cost backfill to derive the cacheRead/cacheWrite split', () => {
    expect(opencodeToNormalized(messages(), { sessionId: 'oc-1' }).costNeedsBackfill).toBe(true);
  });
});
