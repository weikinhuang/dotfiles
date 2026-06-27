import { describe, expect, test } from 'vitest';

import { detectHarness } from '../../../../../lib/node/ai-tooling/analyze/detect-harness.ts';

describe('detectHarness', () => {
  test('detects opencode from a .db / .sqlite path regardless of content', () => {
    expect(detectHarness('/data/opencode.db', [])).toBe('opencode');
    expect(detectHarness('/x/foo.sqlite', [])).toBe('opencode');
  });

  test('detects pi from a session header line', () => {
    const line = JSON.stringify({ type: 'session', id: 'abc', cwd: '/home/u/proj', timestamp: 't' });
    expect(detectHarness('/x/s.jsonl', [line])).toBe('pi');
  });

  test('detects pi from a model_change line', () => {
    const line = JSON.stringify({ type: 'model_change', provider: 'amazon-bedrock', modelId: 'claude' });
    expect(detectHarness('/x/s.jsonl', [line])).toBe('pi');
  });

  test('detects pi from camelCase cacheRead usage', () => {
    const line = JSON.stringify({
      type: 'message',
      message: { role: 'assistant', usage: { cacheRead: 100, cacheWrite: 5 } },
    });
    expect(detectHarness('/x/s.jsonl', [line])).toBe('pi');
  });

  test('detects claude from snake_case cache_creation usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_x', usage: { input_tokens: 3, cache_creation_input_tokens: 100 } },
    });
    expect(detectHarness('/x/s.jsonl', [line])).toBe('claude');
  });

  test('detects claude from Claude Code top-level fields', () => {
    const line = JSON.stringify({ type: 'user', sessionId: 'cl', gitBranch: 'main', message: { content: 'hi' } });
    expect(detectHarness('/x/s.jsonl', [line])).toBe('claude');
  });

  test('detects codex from a payload-wrapped line', () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { id: 'cx', cwd: '/x' } });
    expect(detectHarness('/x/s.jsonl', [line])).toBe('codex');
  });

  test('detects codex from a token_count event', () => {
    const line = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } });
    expect(detectHarness('/x/s.jsonl', [line])).toBe('codex');
  });

  test('skips malformed leading lines and matches on a later valid one', () => {
    const lines = ['not json', '{bad', JSON.stringify({ type: 'session', id: 'a', cwd: '/p' })];
    expect(detectHarness('/x/s.jsonl', lines)).toBe('pi');
  });

  test('returns undefined when nothing matches', () => {
    expect(detectHarness('/x/s.jsonl', [JSON.stringify({ hello: 'world' })])).toBeUndefined();
    expect(detectHarness('/x/s.jsonl', [])).toBeUndefined();
  });
});
