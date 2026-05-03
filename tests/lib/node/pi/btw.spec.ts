/**
 * Tests for lib/node/pi/btw.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  buildSideQuestionUserContent,
  BTW_USAGE,
  extractAnswerText,
  formatDuration,
  formatFooter,
  formatTokens,
  parseModelSpec,
  SIDE_QUESTION_DIRECTIVE,
} from '../../../../lib/node/pi/btw.ts';

// ──────────────────────────────────────────────────────────────────────
// buildSideQuestionUserContent
// ──────────────────────────────────────────────────────────────────────

describe('buildSideQuestionUserContent', () => {
  test('wraps the question with the directive', () => {
    const out = buildSideQuestionUserContent('what did we edit?');

    expect(out).toContain(SIDE_QUESTION_DIRECTIVE);
    expect(out).toContain('what did we edit?');
    // Directive comes first, question after a blank line.
    expect(out?.indexOf(SIDE_QUESTION_DIRECTIVE)).toBe(0);
    expect(out).toBe(`${SIDE_QUESTION_DIRECTIVE}\n\nwhat did we edit?`);
  });

  test('trims surrounding whitespace from the question', () => {
    const out = buildSideQuestionUserContent('   foo?\n  ');

    expect(out).toBe(`${SIDE_QUESTION_DIRECTIVE}\n\nfoo?`);
  });

  test('empty / whitespace-only question returns undefined', () => {
    expect(buildSideQuestionUserContent('')).toBeUndefined();
    expect(buildSideQuestionUserContent('   ')).toBeUndefined();
    expect(buildSideQuestionUserContent('\n\t')).toBeUndefined();
  });

  test('preserves inner whitespace, including blank lines', () => {
    const out = buildSideQuestionUserContent('line one\n\nline two');

    expect(out).toBe(`${SIDE_QUESTION_DIRECTIVE}\n\nline one\n\nline two`);
  });

  test('directive mentions no-tools and no-history so the model knows what mode it is in', () => {
    expect(SIDE_QUESTION_DIRECTIVE.toLowerCase()).toContain('tool');
    expect(SIDE_QUESTION_DIRECTIVE.toLowerCase()).toContain('saved');
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseModelSpec
// ──────────────────────────────────────────────────────────────────────

describe('parseModelSpec', () => {
  test('parses provider/modelId', () => {
    expect(parseModelSpec('anthropic/claude-opus-4-7')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
  });

  test('trims whitespace around each component', () => {
    expect(parseModelSpec('  anthropic  /  claude-opus-4-7  ')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
  });

  test('accepts modelIds that themselves contain slashes', () => {
    // Provider ends at the FIRST slash; the rest is the modelId.
    // Some model IDs (e.g. HuggingFace) legitimately have slashes.
    expect(parseModelSpec('huggingface/meta-llama/Llama-3.1-70B')).toEqual({
      provider: 'huggingface',
      modelId: 'meta-llama/Llama-3.1-70B',
    });
  });

  test('returns undefined for missing slash', () => {
    expect(parseModelSpec('claude-opus-4-7')).toBeUndefined();
  });

  test('returns undefined for empty provider or modelId', () => {
    expect(parseModelSpec('/claude-opus-4-7')).toBeUndefined();
    expect(parseModelSpec('anthropic/')).toBeUndefined();
    expect(parseModelSpec('/')).toBeUndefined();
  });

  test('returns undefined for empty / whitespace / undefined input', () => {
    expect(parseModelSpec('')).toBeUndefined();
    expect(parseModelSpec('   ')).toBeUndefined();
    expect(parseModelSpec(undefined)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// extractAnswerText
// ──────────────────────────────────────────────────────────────────────

describe('extractAnswerText', () => {
  test('joins consecutive text parts with no separator', () => {
    const out = extractAnswerText([
      { type: 'text', text: 'Hello, ' },
      { type: 'text', text: 'world.' },
    ]);

    expect(out).toBe('Hello, world.');
  });

  test('drops thinking parts', () => {
    const out = extractAnswerText([
      { type: 'thinking', text: 'hmm...' },
      { type: 'text', text: 'The answer is 42.' },
    ]);

    expect(out).toBe('The answer is 42.');
  });

  test('drops toolCall parts', () => {
    const out = extractAnswerText([
      { type: 'toolCall', text: '{ "name": "bash" }' },
      { type: 'text', text: 'done' },
    ]);

    expect(out).toBe('done');
  });

  test('trims the joined result', () => {
    const out = extractAnswerText([{ type: 'text', text: '  foo  \n' }]);

    expect(out).toBe('foo');
  });

  test('returns empty string for empty / missing content', () => {
    expect(extractAnswerText(undefined)).toBe('');
    expect(extractAnswerText([])).toBe('');
    expect(extractAnswerText([{ type: 'text' }])).toBe('');
    expect(extractAnswerText([{ type: 'text', text: '' }])).toBe('');
  });

  test('skips non-text parts even if they carry a text field', () => {
    const out = extractAnswerText([
      // pi-ai's ToolCall has `arguments`, not `text`, but a custom shape
      // could still carry `text`. Any non-"text" type is dropped.
      { type: 'weird', text: 'ignore me' },
      { type: 'text', text: 'keep me' },
    ]);

    expect(out).toBe('keep me');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatTokens / formatDuration
// ──────────────────────────────────────────────────────────────────────

describe('formatTokens', () => {
  test('sub-1000 renders as integer', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  test('1000–9999 uses one decimal k', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(9999)).toBe('10.0k');
  });

  test('10000–999999 uses integer k', () => {
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(45_678)).toBe('46k');
    expect(formatTokens(999_000)).toBe('999k');
  });

  test('≥1M uses two decimals M', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M');
    expect(formatTokens(1_234_567)).toBe('1.23M');
    expect(formatTokens(12_500_000)).toBe('12.50M');
  });

  test('non-finite or negative clamps to 0', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(-1)).toBe('0');
  });
});

describe('formatDuration', () => {
  test('sub-second uses ms', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  test('1–10 seconds uses one decimal', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(9999)).toBe('10.0s');
  });

  test('≥10 seconds rounds to integer seconds', () => {
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(34_500)).toBe('35s');
  });

  test('non-finite or negative clamps to 0ms', () => {
    expect(formatDuration(Number.NaN)).toBe('0ms');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
    expect(formatDuration(-1)).toBe('0ms');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatFooter
// ──────────────────────────────────────────────────────────────────────

describe('formatFooter', () => {
  test('renders all fields when provided', () => {
    const out = formatFooter({
      model: 'claude-opus-4-7',
      totalTokens: 12_345,
      cacheReadTokens: 10_000,
      outputTokens: 180,
      costUsd: 0.00234,
      durationMs: 1200,
    });

    expect(out).toBe('[model: claude-opus-4-7 · 12k tokens · 10k cached · 180 out · $0.0023 · 1.2s · ephemeral]');
  });

  test('omits missing fields', () => {
    const out = formatFooter({ model: 'qwen3-6-35b-a3b' });

    expect(out).toBe('[model: qwen3-6-35b-a3b · ephemeral]');
  });

  test('omits zero cache read (only worth surfacing when caching engaged)', () => {
    const out = formatFooter({
      model: 'foo',
      totalTokens: 1000,
      cacheReadTokens: 0,
      outputTokens: 100,
    });

    expect(out).not.toContain('cached');
    expect(out).toContain('1.0k tokens');
    expect(out).toContain('100 out');
  });

  test('omits zero cost but keeps zero duration (long/short is interesting even at 0)', () => {
    const out = formatFooter({ model: 'foo', costUsd: 0, durationMs: 0 });

    expect(out).not.toContain('$');
    expect(out).toContain('0ms');
  });

  test('always labels the call as ephemeral so the user remembers it was not saved', () => {
    expect(formatFooter({ model: 'x' })).toContain('ephemeral');
  });
});

// ──────────────────────────────────────────────────────────────────────
// BTW_USAGE
// ──────────────────────────────────────────────────────────────────────

describe('BTW_USAGE', () => {
  test('mentions the command name and gives an example', () => {
    expect(BTW_USAGE).toContain('/btw');
    expect(BTW_USAGE.toLowerCase()).toContain('usage');
    expect(BTW_USAGE).toContain('Example');
  });

  test('calls out the ephemeral-and-no-tools contract', () => {
    const lower = BTW_USAGE.toLowerCase();

    expect(lower).toContain('history');
    expect(lower).toContain('tools');
  });
});
