/**
 * Tests for lib/node/pi/scheduled-prompts/template.ts.
 */

import { describe, expect, test } from 'vitest';

import { renderPrompt } from '../../../../../lib/node/pi/scheduled-prompts/template.ts';

const NOW = new Date(2026, 0, 1, 9, 0, 0).getTime();

describe('renderPrompt', () => {
  test('replaces ${t} with the formatted elapsed span', () => {
    expect(renderPrompt('continue - last run ${t} ago', { now: NOW, elapsedMs: 15_000 })).toBe(
      'continue - last run 15s ago',
    );
    expect(renderPrompt('${t}', { now: NOW, elapsedMs: 90 * 60_000 })).toBe('1h30m');
  });

  test('renders ${t} as 0s when no elapsed span is given', () => {
    expect(renderPrompt('idle for ${t}', { now: NOW })).toBe('idle for 0s');
  });

  test('replaces ${d} with a non-empty date string', () => {
    const out = renderPrompt('now is ${d}', { now: NOW });
    expect(out).not.toContain('${d}');
    expect(out).toMatch(/now is .*\d/);
  });

  test('leaves unknown tokens untouched', () => {
    expect(renderPrompt('keep ${foo} and ${t}', { now: NOW, elapsedMs: 1000 })).toBe('keep ${foo} and 1s');
  });

  test('returns text unchanged when it has no tokens', () => {
    expect(renderPrompt('just continue', { now: NOW, elapsedMs: 5000 })).toBe('just continue');
  });

  test('substitutes every occurrence', () => {
    expect(renderPrompt('${t} ... still ${t}', { now: NOW, elapsedMs: 2000 })).toBe('2s ... still 2s');
  });
});
