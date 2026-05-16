/**
 * Tests for lib/node/pi/request-options.ts - pure helper that
 * deep-merges per-persona / per-agent `requestOptions` into the
 * outgoing provider payload, with an optional `apis` filter.
 */

import { describe, expect, test } from 'vitest';

import { applyRequestOptions, parseRequestOptions } from '../../../../lib/node/pi/request-options.ts';

// ──────────────────────────────────────────────────────────────────────
// applyRequestOptions
// ──────────────────────────────────────────────────────────────────────

describe('applyRequestOptions', () => {
  test('undefined options → payload returned unchanged (same reference)', () => {
    const payload = { messages: [], temperature: 0.5 };

    expect(applyRequestOptions({ payload, options: undefined })).toBe(payload);
  });

  test('non-object payload returned unchanged', () => {
    expect(applyRequestOptions({ payload: 'string', options: { temperature: 0.7 } })).toBe('string');
    expect(applyRequestOptions({ payload: 42, options: { temperature: 0.7 } })).toBe(42);
    expect(applyRequestOptions({ payload: null, options: { temperature: 0.7 } })).toBe(null);
    expect(applyRequestOptions({ payload: [1, 2], options: { temperature: 0.7 } })).toEqual([1, 2]);
  });

  test('shallow override merges new top-level keys', () => {
    const payload = { messages: [], model: 'qwen3' };
    const result = applyRequestOptions({ payload, options: { temperature: 0.7, top_p: 0.95, top_k: 40 } });

    expect(result).toEqual({ messages: [], model: 'qwen3', temperature: 0.7, top_p: 0.95, top_k: 40 });
  });

  test('override wins when key already exists', () => {
    const payload = { temperature: 0.2 };

    expect(applyRequestOptions({ payload, options: { temperature: 0.7 } })).toEqual({ temperature: 0.7 });
  });

  test('nested objects deep-merge - sibling keys preserved', () => {
    // Mirrors the qwen-chat-template thinking case: pi-ai sets
    // `chat_template_kwargs: { enable_thinking, preserve_thinking }`,
    // and the persona may want to add or override `enable_thinking`
    // without nuking `preserve_thinking`.
    const payload = {
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    };
    const result = applyRequestOptions({
      payload,
      options: { chat_template_kwargs: { enable_thinking: true } },
    });

    expect(result).toEqual({
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    });
  });

  test('arrays from override replace the original, not concatenate', () => {
    const payload = { stop: ['</done>'] };
    const result = applyRequestOptions({ payload, options: { stop: ['END', 'STOP'] } });

    expect(result).toEqual({ stop: ['END', 'STOP'] });
  });

  test('apis filter - match → merge applies', () => {
    const payload = { temperature: 0.2 };
    const result = applyRequestOptions({
      payload,
      options: { apis: ['openai-completions'], temperature: 0.7 },
      api: 'openai-completions',
    });

    expect(result).toEqual({ temperature: 0.7 });
  });

  test('apis filter - mismatch → payload unchanged', () => {
    const payload = { temperature: 0.2 };
    const result = applyRequestOptions({
      payload,
      options: { apis: ['openai-completions'], temperature: 0.7 },
      api: 'anthropic-messages',
    });

    expect(result).toBe(payload);
  });

  test('apis filter without a known live api → skip merge (safe default)', () => {
    const payload = { temperature: 0.2 };
    const result = applyRequestOptions({
      payload,
      options: { apis: ['openai-completions'], temperature: 0.7 },
      api: undefined,
    });

    expect(result).toBe(payload);
  });

  test('empty apis list is treated as no filter (apply to every provider)', () => {
    const payload = { temperature: 0.2 };
    const result = applyRequestOptions({
      payload,
      options: { apis: [], temperature: 0.7 },
      api: 'anthropic-messages',
    });

    expect(result).toEqual({ temperature: 0.7 });
  });

  test('options containing only `apis` (no merge keys) → unchanged', () => {
    const payload = { temperature: 0.2 };

    expect(applyRequestOptions({ payload, options: { apis: ['openai-completions'] }, api: 'openai-completions' })).toBe(
      payload,
    );
  });

  test('original payload is not mutated', () => {
    const payload = {
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    };
    const before = JSON.stringify(payload);
    applyRequestOptions({
      payload,
      options: { chat_template_kwargs: { enable_thinking: true } },
    });

    expect(JSON.stringify(payload)).toBe(before);
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseRequestOptions
// ──────────────────────────────────────────────────────────────────────

describe('parseRequestOptions', () => {
  const collectWarnings = (): { warnings: string[]; push: (reason: string) => void } => {
    const warnings: string[] = [];
    const push = (reason: string): void => {
      warnings.push(reason);
    };
    return { warnings, push };
  };

  test('undefined / null → undefined, no warning', () => {
    const { warnings, push } = collectWarnings();

    expect(parseRequestOptions(undefined, push)).toBeUndefined();
    expect(parseRequestOptions(null, push)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test('empty object → undefined (no override)', () => {
    const { warnings, push } = collectWarnings();

    expect(parseRequestOptions({}, push)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test('plain key/value pairs → passed through verbatim', () => {
    const { push } = collectWarnings();

    expect(parseRequestOptions({ temperature: 0.7, top_p: 0.95 }, push)).toEqual({ temperature: 0.7, top_p: 0.95 });
  });

  test('nested object preserved', () => {
    const { push } = collectWarnings();

    expect(parseRequestOptions({ chat_template_kwargs: { enable_thinking: true } }, push)).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  test('apis: valid string list kept', () => {
    const { push } = collectWarnings();

    expect(parseRequestOptions({ apis: ['openai-completions', 'anthropic-messages'], temperature: 0.7 }, push)).toEqual(
      {
        apis: ['openai-completions', 'anthropic-messages'],
        temperature: 0.7,
      },
    );
  });

  test('apis: non-array drops with a warning, other keys preserved', () => {
    const { warnings, push } = collectWarnings();

    expect(parseRequestOptions({ apis: 'openai-completions', temperature: 0.7 }, push)).toEqual({ temperature: 0.7 });
    expect(warnings).toEqual(['`requestOptions.apis` must be an array of strings (dropped)']);
  });

  test('apis: non-string entries dropped per-entry', () => {
    const { warnings, push } = collectWarnings();

    expect(parseRequestOptions({ apis: ['openai-completions', 42, '', 'anthropic-messages'] }, push)).toEqual({
      apis: ['openai-completions', 'anthropic-messages'],
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('42');
    expect(warnings[1]).toContain('""');
  });

  test('non-object input → undefined with a warning', () => {
    const { warnings, push } = collectWarnings();

    expect(parseRequestOptions('temperature=0.7', push)).toBeUndefined();
    expect(parseRequestOptions(['temperature', 0.7], push)).toBeUndefined();
    expect(warnings).toEqual(['`requestOptions` must be an object', '`requestOptions` must be an object']);
  });

  test('apis present but empty after filtering, no other keys → undefined', () => {
    const { push } = collectWarnings();

    expect(parseRequestOptions({ apis: [42, ''] }, push)).toBeUndefined();
  });
});
