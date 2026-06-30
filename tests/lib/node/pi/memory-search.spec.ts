/**
 * Tests for lib/node/pi/memory-search.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test, vi } from 'vitest';

import { findSimilarMemories, searchMemories, tokenizeQuery } from '../../../../lib/node/pi/memory-search.ts';
import { type MemoryEntry } from '../../../../lib/node/pi/memory-reducer.ts';

const entry = (
  id: string,
  name = id,
  description = `desc for ${id}`,
  type: MemoryEntry['type'] = 'feedback',
  scope: MemoryEntry['scope'] = 'global',
): MemoryEntry => ({ id, scope, type, name, description });

const noBody = (): string | null => null;

test('tokenizeQuery: drops stopwords and short tokens, keeps content words', () => {
  expect(tokenizeQuery('tell me about the auth mock policy')).toEqual(['auth', 'mock', 'policy']);
  // Splits on non-alphanumerics too (hyphens, slashes, dots).
  expect(tokenizeQuery('grafana.internal/d/api-latency')).toEqual(['grafana', 'internal', 'api', 'latency']);
});

test('tokenizeQuery: falls back to the whole query when filtering empties it', () => {
  // A single short token would otherwise vanish; keep it so a deliberate
  // short query still matches.
  expect(tokenizeQuery('x')).toEqual(['x']);
  expect(tokenizeQuery('   ')).toEqual([]);
});

test('searchMemories: natural-language query matches on its content words', () => {
  // The whole sentence is not a subsequence of the name, but the content
  // word "widgets" is - tokenization is what makes this fire.
  const entries = [
    entry('widgets', 'widgets overview', 'unrelated description'),
    entry('other', 'release freeze', 'merge freeze after thursday'),
  ];
  const out = searchMemories(entries, noBody, 'tell me about the widgets overview');
  expect(out).toHaveLength(1);
  expect(out[0].entry.id).toBe('widgets');
});

test('searchMemories: empty query returns no matches', () => {
  expect(searchMemories([entry('a')], noBody, '')).toEqual([]);
  expect(searchMemories([entry('a')], noBody, '   ')).toEqual([]);
});

test('searchMemories: no-match query returns empty', () => {
  const out = searchMemories([entry('auth', 'auth policy', 'mock rules')], noBody, 'zzqqxx');
  expect(out).toEqual([]);
});

test('searchMemories: name match ranks above description match', () => {
  const entries = [
    entry('desc-hit', 'unrelated title', 'all about widgets'),
    entry('name-hit', 'widgets overview', 'unrelated description'),
  ];
  const out = searchMemories(entries, noBody, 'widgets');
  expect(out).toHaveLength(2);
  expect(out[0].entry.id).toBe('name-hit');
  expect(out[1].entry.id).toBe('desc-hit');
  expect(out[0].score).toBeGreaterThan(out[1].score);
});

test('searchMemories: description match ranks above body-only match', () => {
  const bodies: Record<string, string> = {
    'body-hit': 'the widgets live here in the body text',
  };
  const getBody = (e: MemoryEntry): string | null => bodies[e.id] ?? null;
  const entries = [
    entry('body-hit', 'unrelated', 'unrelated'),
    entry('desc-hit', 'unrelated', 'widgets in the description'),
  ];
  const out = searchMemories(entries, getBody, 'widgets');
  expect(out[0].entry.id).toBe('desc-hit');
  expect(out[1].entry.id).toBe('body-hit');
});

test('searchMemories: lazy body read is skipped for a strong header match', () => {
  const getBody = vi.fn((): string | null => 'irrelevant body');
  const entries = [entry('strong', 'database connection pooling', 'database connection pooling notes')];
  const out = searchMemories(entries, getBody, 'database connection');
  expect(out).toHaveLength(1);
  // Name + description already clear the threshold, so the body is never read.
  expect(getBody).not.toHaveBeenCalled();
});

test('searchMemories: body is read when the header score is below threshold', () => {
  const getBody = vi.fn((): string | null => 'mentions the keyword raft consensus');
  const entries = [entry('weak', 'unrelated', 'unrelated')];
  const out = searchMemories(entries, getBody, 'raft');
  expect(getBody).toHaveBeenCalledTimes(1);
  expect(out).toHaveLength(1);
  expect(out[0].entry.id).toBe('weak');
});

test('searchMemories: respects an explicit bodyReadThreshold', () => {
  const getBody = vi.fn((): string | null => null);
  // threshold 0 means "never read the body".
  searchMemories([entry('x', 'totally unrelated', 'nope')], getBody, 'x', { bodyReadThreshold: 0 });
  expect(getBody).not.toHaveBeenCalled();
});

test('findSimilarMemories: near-duplicate name triggers a hit', () => {
  const existing = [entry('auth-mock-policy', 'auth mock policy', 'do not mock the auth db')];
  const out = findSimilarMemories(
    { name: 'auth mock policy', description: 'never mock auth', body: 'because prod failed' },
    existing,
    noBody,
  );
  expect(out).toHaveLength(1);
  expect(out[0].entry.id).toBe('auth-mock-policy');
});

test('findSimilarMemories: distinct memory produces no hit', () => {
  const existing = [entry('release-freeze', 'release freeze', 'merge freeze after thursday')];
  const out = findSimilarMemories(
    { name: 'grafana dashboard', description: 'api latency board', body: 'grafana.internal/d/api' },
    existing,
    noBody,
  );
  expect(out).toEqual([]);
});

test('findSimilarMemories: empty candidate name returns no hits', () => {
  expect(findSimilarMemories({ name: '   ', description: 'x', body: 'y' }, [entry('a')], noBody)).toEqual([]);
});

test('findSimilarMemories: caps results at opts.max', () => {
  const existing = [
    entry('widget-a', 'widget config notes'),
    entry('widget-b', 'widget config notes'),
    entry('widget-c', 'widget config notes'),
    entry('widget-d', 'widget config notes'),
  ];
  const out = findSimilarMemories({ name: 'widget config notes', description: 'x', body: 'y' }, existing, noBody, {
    max: 2,
  });
  expect(out).toHaveLength(2);
});
