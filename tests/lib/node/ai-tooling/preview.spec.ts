import { describe, expect, test } from 'vitest';

import { makeSessionPreview } from '../../../../lib/node/ai-tooling/preview.ts';

describe('makeSessionPreview', () => {
  test('returns empty string for missing / whitespace input', () => {
    expect(makeSessionPreview(undefined)).toBe('');
    expect(makeSessionPreview(null)).toBe('');
    expect(makeSessionPreview('')).toBe('');
    expect(makeSessionPreview('   \n\t  ')).toBe('');
  });

  test('passes short single-line prompts through verbatim', () => {
    expect(makeSessionPreview('fix the auth bug')).toBe('fix the auth bug');
  });

  test('collapses internal whitespace and newlines to single spaces', () => {
    expect(makeSessionPreview('hello\n\n  world\tfoo')).toBe('hello world foo');
  });

  test('truncates long input with a trailing ellipsis', () => {
    const long = 'a'.repeat(200);
    const out = makeSessionPreview(long, 50);

    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  test('prefers a word boundary inside the last ~20% of the window', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog and keeps jumping everywhere.';
    const out = makeSessionPreview(sentence, 40);

    // Should break at a space, not mid-word.
    expect(out.endsWith('\u2026')).toBe(true);

    // The character right before the ellipsis must not be a letter that
    // starts a word — i.e. we should have landed on a space boundary.
    const body = out.slice(0, -1);

    expect(body.endsWith(' ')).toBe(false);
    expect(body).toMatch(/[a-z]$/); // last kept char is a real word-ending letter
  });

  test('falls back to a hard cut when no word boundary is close enough', () => {
    const wordy = 'x'.repeat(200);
    const out = makeSessionPreview(wordy, 30);

    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  test('strips Claude Code system-reminder envelopes', () => {
    const raw = '<system-reminder>stop doing that</system-reminder>fix the auth bug';

    expect(makeSessionPreview(raw)).toBe('fix the auth bug');
  });

  test('strips local-command-… envelopes', () => {
    const raw = '<local-command-stdout>fetching…</local-command-stdout>then retry the build';

    expect(makeSessionPreview(raw)).toBe('then retry the build');
  });

  test('returns empty string when the entire message is pure harness noise', () => {
    expect(makeSessionPreview('<system-reminder>compacting context</system-reminder>')).toBe('');
  });

  test('strips stray XML-ish tags but keeps the inner text', () => {
    const raw = '<task>refactor the <b>loader</b> to stream JSONL</task>';

    expect(makeSessionPreview(raw)).toBe('refactor the loader to stream JSONL');
  });
});
