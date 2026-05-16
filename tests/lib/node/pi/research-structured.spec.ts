/**
 * Tests for lib/node/pi/research-structured.ts.
 *
 * Mock session drives the full retry state machine without pi. The
 * session is a hand-rolled stub: each `prompt()` call pushes the
 * next scripted assistant message onto `state.messages`; the
 * module extracts the trailing text via the default
 * `extractFinalAssistantText` path.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  callTyped,
  parseTolerant,
  renderValidationNudge,
  type ResearchSessionLike,
  type SchemaLike,
} from '../../../../lib/node/pi/research-structured.ts';
import { STUCK_STATUS } from '../../../../lib/node/pi/research-stuck.ts';

interface Shape {
  color: string;
  count: number;
}

const shapeSchema: SchemaLike<Shape> = {
  validate(v) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'not an object' };
    const o = v as Record<string, unknown>;
    if (typeof o.color !== 'string') return { ok: false, error: 'color must be string' };
    if (typeof o.count !== 'number') return { ok: false, error: 'count must be number' };
    return { ok: true, value: { color: o.color, count: o.count } };
  },
};

function makeSession(scripted: string[]): ResearchSessionLike & {
  prompts: string[];
  messages: { role: string; content: { type: string; text: string }[] }[];
} {
  const messages: { role: string; content: { type: string; text: string }[] }[] = [];
  const prompts: string[] = [];
  let next = 0;
  return {
    prompts,
    messages,
    state: { messages },
    prompt: (task: string) => {
      prompts.push(task);
      const reply = scripted[next++] ?? '';
      messages.push({ role: 'user', content: [{ type: 'text', text: task }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      return Promise.resolve();
    },
  };
}

describe('parseTolerant', () => {
  test('parses a bare JSON object', () => {
    expect(parseTolerant('{"a":1}')).toEqual({ a: 1 });
  });

  test('strips a multi-line ```json fence', () => {
    const raw = '```json\n{"color":"red","count":3}\n```';

    expect(parseTolerant(raw)).toEqual({ color: 'red', count: 3 });
  });

  test('strips a single-line fence', () => {
    // Model emits everything on one line.
    const raw = '```json {"color":"blue","count":2} ```';

    expect(parseTolerant(raw)).toEqual({ color: 'blue', count: 2 });
  });

  test('absorbs qwen3-style double-wrapped fences', () => {
    const raw = '```json\n```json\n{"color":"green","count":4}\n```\n```';

    expect(parseTolerant(raw)).toEqual({ color: 'green', count: 4 });
  });

  test('slices the first JSON object out of trailing prose', () => {
    const raw = 'Sure - here you go: {"color":"amber","count":1}\n\nLet me know if you need more.';

    expect(parseTolerant(raw)).toEqual({ color: 'amber', count: 1 });
  });

  test('returns null on pure prose', () => {
    expect(parseTolerant('I think the answer is red.')).toBeNull();
  });

  test('returns null on empty / whitespace input', () => {
    expect(parseTolerant('')).toBeNull();
    expect(parseTolerant('   \n  ')).toBeNull();
  });

  test('returns null on truncated / unbalanced JSON', () => {
    expect(parseTolerant('{"color":"red","count":')).toBeNull();
  });
});

describe('renderValidationNudge', () => {
  test('echoes the error back into the prompt verbatim', () => {
    const msg = renderValidationNudge('color must be string');

    expect(msg).toContain('color must be string');
    expect(msg).toContain('failed validation');
    expect(msg).toContain('Re-emit');
  });
});

describe('callTyped', () => {
  test('(a) valid first try returns the parsed value', async () => {
    const session = makeSession(['{"color":"red","count":1}']);
    const fallback = vi.fn(() => ({ color: 'fallback', count: 0 }));
    const out = await callTyped({
      session,
      prompt: 'give me a shape',
      schema: shapeSchema,
      fallback,
    });

    expect(out).toEqual({ color: 'red', count: 1 });
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toBe('give me a shape');
    expect(fallback).not.toHaveBeenCalled();
  });

  test('(b) malformed then valid retries once and returns', async () => {
    // First response is unparseable prose; second is a valid JSON object.
    const session = makeSession(['I think red is best.', '{"color":"red","count":2}']);
    const onRetry = vi.fn();
    const out = await callTyped({
      session,
      prompt: 'give me a shape',
      schema: shapeSchema,
      fallback: () => ({ color: 'fallback', count: 0 }),
      onRetry,
    });

    expect(out).toEqual({ color: 'red', count: 2 });
    expect(session.prompts).toHaveLength(2);
    // Nudge prompt echoes the error string.
    expect(session.prompts[1]).toContain('failed validation');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(String), 1);
  });

  test('(c) malformed three times returns fallback()', async () => {
    const session = makeSession(['nope', 'still nope', 'really nope', 'this attempt never runs']);
    const fallback = vi.fn(() => ({ color: 'fallback', count: 42 }));
    const onRetry = vi.fn();
    const out = await callTyped({
      session,
      prompt: 'give me a shape',
      schema: shapeSchema,
      fallback,
      onRetry,
    });

    expect(out).toEqual({ color: 'fallback', count: 42 });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(session.prompts).toHaveLength(3);
    // Two nudges fired after the first and second attempts.
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls[0][1]).toBe(1);
    expect(onRetry.mock.calls[1][1]).toBe(2);
    expect(onRetry.mock.calls[2][1]).toBe(3);
  });

  test('(d) fenced JSON is parsed correctly', async () => {
    const session = makeSession(['```json\n{"color":"teal","count":7}\n```']);
    const out = await callTyped({
      session,
      prompt: 'give me a shape',
      schema: shapeSchema,
      fallback: () => ({ color: 'fallback', count: 0 }),
    });

    expect(out).toEqual({ color: 'teal', count: 7 });
  });

  test('(e) valid stuck shape is returned unchanged', async () => {
    const session = makeSession([`{"status":"${STUCK_STATUS}","reason":"no signal"}`]);
    const fallback = vi.fn();
    const out = await callTyped({
      session,
      prompt: 'give me a shape',
      schema: shapeSchema,
      fallback: () => ({ color: 'fallback', count: 0 }),
    });

    expect(out).toEqual({ status: STUCK_STATUS, reason: 'no signal' });
    expect(fallback).not.toHaveBeenCalled();
  });

  test('(f) invalid stuck shape counts as malformed and retries', async () => {
    // Missing `reason` → isStuckShape false → validator runs → rejects.
    const session = makeSession([`{"status":"${STUCK_STATUS}"}`, '{"color":"gold","count":9}']);
    const onRetry = vi.fn();
    const out = await callTyped({
      session,
      prompt: 'give me a shape',
      schema: shapeSchema,
      fallback: () => ({ color: 'fallback', count: 0 }),
      onRetry,
    });

    expect(out).toEqual({ color: 'gold', count: 9 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(session.prompts[1]).toContain('failed validation');
  });

  test('respects maxRetries override', async () => {
    // maxRetries=1 → one attempt, no retries; malformed immediately falls back.
    const session = makeSession(['nope']);
    const fallback = vi.fn(() => ({ color: 'fb', count: 0 }));
    const out = await callTyped({
      session,
      prompt: 'x',
      schema: shapeSchema,
      fallback,
      maxRetries: 1,
    });

    expect(out).toEqual({ color: 'fb', count: 0 });
    expect(session.prompts).toHaveLength(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
