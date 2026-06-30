/**
 * Tests for lib/node/pi/memory-recall.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { type MemoryEntry, type MemoryState, emptyState } from '../../../../lib/node/pi/memory-reducer.ts';
import { selectRecall } from '../../../../lib/node/pi/memory-recall.ts';

const entry = (
  id: string,
  name = id,
  description = `desc for ${id}`,
  extra: Partial<MemoryEntry> = {},
): MemoryEntry => ({ id, scope: 'global', type: 'feedback', name, description, ...extra });

/** Build a state with the given entries dropped into the global bucket. */
const stateOf = (entries: MemoryEntry[]): MemoryState => ({
  ...emptyState(),
  index: { global: entries, project: [], session: [] },
});

const noBody = (): string | null => null;

test('selectRecall: prompt matching a name surfaces that id, ranked first', () => {
  const state = stateOf([
    entry('widgets', 'widgets overview', 'unrelated description'),
    entry('other', 'unrelated title', 'something else entirely'),
  ]);
  const { markedIds } = selectRecall(state, 'widgets', noBody);
  expect(markedIds[0]).toBe('widgets');
});

test('selectRecall: name match outranks a description-only match', () => {
  const state = stateOf([
    entry('desc-hit', 'unrelated title', 'all about widgets'),
    entry('name-hit', 'widgets overview', 'unrelated description'),
  ]);
  const { markedIds } = selectRecall(state, 'widgets', noBody);
  expect(markedIds).toEqual(['name-hit', 'desc-hit']);
});

test('selectRecall: non-substring prompt that fuzzy-matches the description is still selected', () => {
  // The prompt token ("port") does not appear in the name, only fuzzy/lexically
  // in the description - this is the keyword-only gap recall closes.
  const state = stateOf([
    entry('net', 'service networking', 'host port mapping conflicts in compose'),
    entry('unrelated', 'release freeze', 'merge freeze after thursday'),
  ]);
  const { markedIds } = selectRecall(state, 'port', noBody);
  expect(markedIds).toContain('net');
  expect(markedIds).not.toContain('unrelated');
});

test('selectRecall: a natural-language prompt surfaces the relevant memory', () => {
  // Real prompts are sentences, not keywords. The whole sentence is not a
  // subsequence of the name/description, but its content words are - this
  // is the case plain whole-string matching missed entirely.
  const state = stateOf([
    entry('auth-mock-policy', 'Auth mock policy', 'Do not mock the database in auth tests'),
    entry('release-freeze', 'release freeze', 'merge freeze after thursday'),
  ]);
  const { markedIds } = selectRecall(state, 'tell me about the auth mock policy', noBody);
  expect(markedIds).toContain('auth-mock-policy');
  expect(markedIds).not.toContain('release-freeze');
});

test('selectRecall: an unrelated prompt surfaces nothing', () => {
  const state = stateOf([entry('auth-mock-policy', 'Auth mock policy', 'Do not mock the database in auth tests')]);
  expect(selectRecall(state, 'what is our deploy schedule', noBody).markedIds).toEqual([]);
});

test('selectRecall: topK caps the number of surfaced ids', () => {
  const state = stateOf([
    entry('widget-a', 'widget config a', 'widget config notes'),
    entry('widget-b', 'widget config b', 'widget config notes'),
    entry('widget-c', 'widget config c', 'widget config notes'),
    entry('widget-d', 'widget config d', 'widget config notes'),
  ]);
  const { markedIds } = selectRecall(state, 'widget', noBody, { topK: 2 });
  expect(markedIds).toHaveLength(2);
});

test('selectRecall: entries below minScore are excluded', () => {
  const state = stateOf([entry('weak', 'unrelated title', 'unrelated description')]);
  // A high minScore drops the weak/zero match; expect nothing surfaced.
  const { markedIds, block } = selectRecall(state, 'widgets', noBody, { minScore: 1000 });
  expect(markedIds).toEqual([]);
  expect(block).toBeNull();
});

test('selectRecall: injectBodies off yields a null block', () => {
  const getBody = (e: MemoryEntry): string | null => `body for ${e.id}`;
  const state = stateOf([entry('widgets', 'widgets overview', 'about widgets')]);
  const { markedIds, block } = selectRecall(state, 'widgets', getBody);
  expect(markedIds).toEqual(['widgets']);
  expect(block).toBeNull();
});

test('selectRecall: injectBodies on renders bodies under the heading, within budget', () => {
  const longBody = 'x'.repeat(5000);
  const getBody = (): string | null => longBody;
  const state = stateOf([entry('widgets', 'widgets overview', 'about widgets')]);
  const { markedIds, block } = selectRecall(state, 'widgets', getBody, { injectBodies: true, bodyBudget: 100 });
  expect(markedIds).toEqual(['widgets']);
  expect(block).not.toBeNull();
  expect(block).toContain('## Relevant memory');
  expect(block).toContain('`widgets`');
  // The rendered body slice must respect the per-body budget.
  const bodyLine = block!.split('\n').find((l) => l.startsWith('x'));
  expect(bodyLine!.length).toBeLessThanOrEqual(100);
});

test('selectRecall: empty prompt surfaces nothing', () => {
  const state = stateOf([entry('widgets', 'widgets overview', 'about widgets')]);
  expect(selectRecall(state, '', noBody)).toEqual({ markedIds: [], block: null });
  expect(selectRecall(state, '   ', noBody)).toEqual({ markedIds: [], block: null });
});

test('selectRecall: no memories surfaces nothing', () => {
  expect(selectRecall(emptyState(), 'widgets', noBody)).toEqual({ markedIds: [], block: null });
});

test('selectRecall: recency tie-break prefers the more recently updated entry', () => {
  // Two entries with identical name/description score equally; the more
  // recently `updated` one must rank first.
  const state = stateOf([
    entry('stale', 'widgets overview', 'about widgets', { updated: '2026-01-01T00:00:00Z' }),
    entry('fresh', 'widgets overview', 'about widgets', { updated: '2026-06-01T00:00:00Z' }),
  ]);
  const { markedIds } = selectRecall(state, 'widgets', noBody);
  expect(markedIds[0]).toBe('fresh');
});
