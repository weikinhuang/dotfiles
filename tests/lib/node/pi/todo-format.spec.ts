/**
 * Tests for lib/node/pi/todo-format.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  formatText,
  formatTodoProgress,
  groupTodos,
  statusGlyph,
  transitionGlyphs,
} from '../../../../lib/node/pi/todo-format.ts';
import {
  actAdd,
  actClear,
  actList,
  cloneState,
  emptyState,
  type Todo,
  type TodoState,
} from '../../../../lib/node/pi/todo-reducer.ts';
import { assertOk } from './helpers.ts';

const mkState = (todos: Todo[], nextId?: number): TodoState => ({
  todos: todos.map((t) => ({ ...t })),
  nextId: nextId ?? todos.reduce((m, t) => Math.max(m, t.id), 0) + 1,
});

function seeded(): TodoState {
  const s = actAdd(emptyState(), undefined, ['first', 'second', 'third']);
  assertOk(s);
  return s.state;
}

// transitionGlyphs
// ──────────────────────────────────────────────────────────────────────

test('transitionGlyphs: cancel returns ⊘ as the to glyph', () => {
  const g = transitionGlyphs('cancel');

  expect(g).not.toBe(null);
  expect(g!.to).toBe('⊘');
  expect(typeof g!.from).toBe('string');
  expect(g!.from.length).toBeGreaterThan(0);
});

test('transitionGlyphs: known actions return non-null pairs', () => {
  for (const action of ['start', 'review', 'complete', 'block', 'cancel', 'reopen']) {
    expect(transitionGlyphs(action)).not.toBe(null);
  }
});

test('transitionGlyphs: non-transition actions return null', () => {
  expect(transitionGlyphs('add')).toBe(null);
  expect(transitionGlyphs('list')).toBe(null);
  expect(transitionGlyphs('clear')).toBe(null);
  expect(transitionGlyphs('unknown')).toBe(null);
});

test('transitionGlyphs: to glyph matches statusGlyph mapping', () => {
  expect(transitionGlyphs('start')!.to).toBe(statusGlyph('in_progress'));
  expect(transitionGlyphs('review')!.to).toBe(statusGlyph('review'));
  expect(transitionGlyphs('complete')!.to).toBe(statusGlyph('completed'));
  expect(transitionGlyphs('block')!.to).toBe(statusGlyph('blocked'));
  expect(transitionGlyphs('cancel')!.to).toBe(statusGlyph('cancelled'));
  expect(transitionGlyphs('reopen')!.to).toBe(statusGlyph('pending'));
});

// ──────────────────────────────────────────────────────────────────────
// groupTodos
// ──────────────────────────────────────────────────────────────────────

test('groupTodos: empty state returns empty buckets', () => {
  const g = groupTodos(emptyState());

  expect(g.in_progress).toEqual([]);
  expect(g.review).toEqual([]);
  expect(g.pending).toEqual([]);
  expect(g.blocked).toEqual([]);
  expect(g.cancelled).toEqual([]);
  expect(g.completed).toEqual([]);
});

test('groupTodos: returns the cancelled bucket', () => {
  const s = mkState([
    { id: 1, text: 'a', status: 'pending' },
    { id: 2, text: 'b', status: 'cancelled', note: 'superseded' },
    { id: 3, text: 'c', status: 'cancelled', note: 'duplicate' },
  ]);
  const g = groupTodos(s);

  expect(g.cancelled.map((t) => t.id)).toEqual([2, 3]);
  expect(g.cancelled[0].note).toBe('superseded');
});

test('groupTodos: buckets every status correctly', () => {
  const s = mkState([
    { id: 1, text: 'a', status: 'pending' },
    { id: 2, text: 'b', status: 'in_progress' },
    { id: 3, text: 'c', status: 'review' },
    { id: 4, text: 'd', status: 'completed' },
    { id: 5, text: 'e', status: 'blocked', note: 'why' },
    { id: 6, text: 'f', status: 'cancelled', note: 'why' },
  ]);
  const g = groupTodos(s);

  expect(g.pending.map((t) => t.id)).toEqual([1]);
  expect(g.in_progress.map((t) => t.id)).toEqual([2]);
  expect(g.review.map((t) => t.id)).toEqual([3]);
  expect(g.completed.map((t) => t.id)).toEqual([4]);
  expect(g.blocked.map((t) => t.id)).toEqual([5]);
  expect(g.cancelled.map((t) => t.id)).toEqual([6]);
});

test('groupTodos: returns defensive copies', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const g = groupTodos(s);
  g.pending[0].text = 'mutated';

  expect(s.todos[0].text).toBe('a');
});

// ──────────────────────────────────────────────────────────────────────
// formatTodoProgress
// ──────────────────────────────────────────────────────────────────────

test('formatTodoProgress: empty state -> 0% with empty bar', () => {
  const r = formatTodoProgress(emptyState(), { width: 8 });

  expect(r.pct).toBe(0);
  expect(r.bar).toBe('▱'.repeat(8));
  expect(r.summary).toBe('');
});

test('formatTodoProgress: matches the planned 8-cell bar shape', () => {
  const s = mkState([
    { id: 1, text: 'a', status: 'completed' },
    { id: 2, text: 'b', status: 'completed' },
    { id: 3, text: 'c', status: 'completed' },
    { id: 4, text: 'd', status: 'in_progress' },
    { id: 5, text: 'e', status: 'review' },
    { id: 6, text: 'f', status: 'pending' },
    { id: 7, text: 'g', status: 'pending' },
    { id: 8, text: 'h', status: 'blocked', note: 'x' },
    { id: 9, text: 'i', status: 'cancelled', note: 'x' },
    { id: 10, text: 'j', status: 'cancelled', note: 'x' },
  ]);
  const r = formatTodoProgress(s, { width: 8 });

  expect(r.pct).toBe(30);
  expect(r.bar).toMatch(/^▰+▱+$/);
  expect(r.bar.length).toBe(8);
  expect(r.summary).toBe('1 active · 1 review · 2 pending · 1 blocked · 2 cancelled');
});

test('formatTodoProgress: omits zero-count chips', () => {
  const s = mkState([
    { id: 1, text: 'a', status: 'completed' },
    { id: 2, text: 'b', status: 'pending' },
  ]);
  const r = formatTodoProgress(s);

  expect(r.summary).toBe('1 pending');
});

test('formatTodoProgress: cancelled chip appears when non-zero', () => {
  const s = mkState([
    { id: 1, text: 'a', status: 'pending' },
    { id: 2, text: 'b', status: 'cancelled', note: 'x' },
  ]);
  const r = formatTodoProgress(s);

  expect(r.summary).toMatch(/1 cancelled/);
});

test('formatTodoProgress: width is configurable', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'completed' }]);
  const r = formatTodoProgress(s, { width: 20 });

  expect(r.bar.length).toBe(20);
});

test('formatTodoProgress: 100% completion fills the bar', () => {
  const s = mkState([
    { id: 1, text: 'a', status: 'completed' },
    { id: 2, text: 'b', status: 'completed' },
  ]);
  const r = formatTodoProgress(s, { width: 8 });

  expect(r.pct).toBe(100);
  expect(r.bar).toBe('▰'.repeat(8));
});

// ──────────────────────────────────────────────────────────────────────
// actClear
// ──────────────────────────────────────────────────────────────────────

test('actClear: empties populated state and resets nextId', () => {
  const r = actClear(seeded());
  assertOk(r);

  expect(r.state.todos).toEqual([]);
  expect(r.state.nextId).toBe(1);
});

test('actClear: returns "Nothing to clear" on empty state', () => {
  const r = actClear(emptyState());
  assertOk(r);

  expect(r.summary).toMatch(/Nothing to clear/);
});

// ──────────────────────────────────────────────────────────────────────
// actList / formatText
// ──────────────────────────────────────────────────────────────────────

test('actList: returns "No todos" for empty state', () => {
  const r = actList(emptyState());
  assertOk(r);

  expect(r.summary).toBe('No todos');
});

test('formatText: renders each status with its marker', () => {
  const s = mkState(
    [
      { id: 1, text: 'a', status: 'pending' },
      { id: 2, text: 'b', status: 'in_progress' },
      { id: 3, text: 'c', status: 'completed' },
      { id: 4, text: 'd', status: 'blocked', note: 'why' },
      { id: 5, text: 'e', status: 'review', note: 'awaiting ci' },
    ],
    6,
  );
  const out = formatText(s);

  expect(out).toMatch(/\[ \] #1 a/);
  expect(out).toMatch(/\[\*\] #2 b/);
  expect(out).toMatch(/\[x\] #3 c/);
  expect(out).toMatch(/\[!\] #4 d - why/);
  expect(out).toMatch(/\[\?\] #5 e - awaiting ci/);
});

// ──────────────────────────────────────────────────────────────────────
// cloneState: defensive deep copy
// ──────────────────────────────────────────────────────────────────────

test('cloneState: new state references do not alias the input', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const c = cloneState(s);
  c.todos[0].text = 'mutated';

  expect(s.todos[0].text).toBe('a');

  c.todos.push({ id: 2, text: 'new', status: 'pending' });

  expect(s.todos.length).toBe(1);
});
