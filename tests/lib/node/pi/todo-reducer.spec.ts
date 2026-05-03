/**
 * Tests for lib/node/pi/todo-reducer.ts.
 *
 * The lib module has zero pi dependencies so these tests run without the
 * pi runtime. Branch entries are duck-typed fakes with just the fields
 * the reducer actually inspects — no SessionManager mocking.
 */

import { expect, test } from 'vitest';

import {
  actAdd,
  actBlock,
  actClear,
  actComplete,
  actList,
  actReopen,
  actReview,
  actStart,
  type BranchEntry,
  cloneState,
  emptyState,
  formatText,
  isTodoStateShape,
  reduceBranch,
  stateFromEntry,
  TODO_CUSTOM_TYPE,
  TODO_TOOL_NAME,
  type Todo,
  type TodoState,
} from '../../../../lib/node/pi/todo-reducer.ts';
import { assertErr, assertOk } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const mkState = (todos: Todo[], nextId?: number): TodoState => ({
  todos: todos.map((t) => ({ ...t })),
  nextId: nextId ?? todos.reduce((m, t) => Math.max(m, t.id), 0) + 1,
});

const mkToolResult = (state: TodoState): BranchEntry => ({
  type: 'message',
  message: { role: 'toolResult', toolName: TODO_TOOL_NAME, details: state },
});

const mkCustom = (state: TodoState): BranchEntry => ({
  type: 'custom',
  customType: TODO_CUSTOM_TYPE,
  data: state,
});

const mkAssistant = (): BranchEntry => ({ type: 'message', message: { role: 'assistant' } });

const mkUnrelatedToolResult = (): BranchEntry => ({
  type: 'message',
  message: { role: 'toolResult', toolName: 'read', details: { path: 'x' } },
});

// Three-item seed used by most of the action tests below. Throws via
// `assertOk` if the seed action fails so dependent tests cannot run
// against an empty state.
function seeded(): TodoState {
  const s = actAdd(emptyState(), undefined, ['first', 'second', 'third']);
  assertOk(s);
  return s.state;
}

// Seed + `actStart(id)` — ready-made state with one in_progress todo.
function startedSeed(id = 1): TodoState {
  const r = actStart(seeded(), id);
  assertOk(r);
  return r.state;
}

// ──────────────────────────────────────────────────────────────────────
// isTodoStateShape
// ──────────────────────────────────────────────────────────────────────

test('isTodoStateShape: accepts valid empty state', () => {
  expect(isTodoStateShape({ todos: [], nextId: 1 })).toBe(true);
});

test('isTodoStateShape: accepts valid populated state', () => {
  expect(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'pending' }], nextId: 2 })).toBe(true);
});

test('isTodoStateShape: accepts note field', () => {
  expect(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'blocked', note: 'why' }], nextId: 2 })).toBe(true);
});

test('isTodoStateShape: rejects non-object', () => {
  expect(isTodoStateShape(null)).toBe(false);
  expect(isTodoStateShape(undefined)).toBe(false);
  expect(isTodoStateShape('nope')).toBe(false);
  expect(isTodoStateShape(42)).toBe(false);
});

test('isTodoStateShape: rejects missing nextId', () => {
  expect(isTodoStateShape({ todos: [] })).toBe(false);
});

test('isTodoStateShape: rejects non-array todos', () => {
  expect(isTodoStateShape({ todos: 'x', nextId: 1 })).toBe(false);
});

test('isTodoStateShape: accepts review status', () => {
  expect(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'review', note: 'awaiting ci' }], nextId: 2 })).toBe(
    true,
  );
});

test('isTodoStateShape: rejects bad status', () => {
  expect(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'doing' }], nextId: 2 })).toBe(false);
});

test('isTodoStateShape: rejects non-string note', () => {
  expect(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'pending', note: 42 }], nextId: 2 })).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// stateFromEntry / reduceBranch
// ──────────────────────────────────────────────────────────────────────

test('stateFromEntry: returns null for unrelated entries', () => {
  expect(stateFromEntry(mkAssistant())).toBe(null);
  expect(stateFromEntry(mkUnrelatedToolResult())).toBe(null);
  expect(stateFromEntry({})).toBe(null);
});

test('stateFromEntry: returns null when tool-result details is malformed', () => {
  const entry: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: TODO_TOOL_NAME, details: { garbage: true } },
  };

  expect(stateFromEntry(entry)).toBe(null);
});

test('stateFromEntry: returns null when custom data is malformed', () => {
  const entry: BranchEntry = { type: 'custom', customType: TODO_CUSTOM_TYPE, data: 'nope' };

  expect(stateFromEntry(entry)).toBe(null);
});

test('stateFromEntry: extracts state from tool-result details', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'pending' }]);

  expect(stateFromEntry(mkToolResult(s))).toEqual(s);
});

test('stateFromEntry: extracts state from custom mirror', () => {
  const s = mkState([{ id: 7, text: 'z', status: 'completed' }], 8);

  expect(stateFromEntry(mkCustom(s))).toEqual(s);
});

test('stateFromEntry: returns a clone, not the same reference', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const out = stateFromEntry(mkToolResult(s))!;
  out.todos[0].text = 'mutated';

  expect(s.todos[0].text).toBe('a');
});

test('reduceBranch: empty branch returns empty state', () => {
  expect(reduceBranch([])).toEqual(emptyState());
});

test('reduceBranch: skips entries with no valid snapshot', () => {
  expect(reduceBranch([mkAssistant(), mkUnrelatedToolResult(), mkAssistant()])).toEqual(emptyState());
});

test('reduceBranch: picks the last tool-result snapshot on the branch', () => {
  const first = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const last = mkState([
    { id: 1, text: 'a', status: 'completed' },
    { id: 2, text: 'b', status: 'pending' },
  ]);

  expect(reduceBranch([mkToolResult(first), mkAssistant(), mkToolResult(last), mkAssistant()])).toEqual(last);
});

test('reduceBranch: falls back to custom mirror when only it exists (post-compaction)', () => {
  const s = mkState([{ id: 3, text: 'y', status: 'in_progress' }], 4);

  expect(reduceBranch([mkAssistant(), mkCustom(s), mkAssistant()])).toEqual(s);
});

test('reduceBranch: later entry wins regardless of kind', () => {
  const older = mkState([{ id: 1, text: 'old', status: 'pending' }]);
  const newer = mkState([{ id: 1, text: 'new', status: 'completed' }]);

  // tool-result older, custom newer
  expect(reduceBranch([mkToolResult(older), mkCustom(newer)])).toEqual(newer);
  // custom older, tool-result newer
  expect(reduceBranch([mkCustom(older), mkToolResult(newer)])).toEqual(newer);
});

test('reduceBranch: ignores malformed entries and keeps scanning', () => {
  const good = mkState([{ id: 1, text: 'keep', status: 'pending' }]);
  const bad: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: TODO_TOOL_NAME, details: { garbage: true } },
  };

  expect(reduceBranch([mkToolResult(good), bad])).toEqual(good);
});

// ──────────────────────────────────────────────────────────────────────
// actAdd
// ──────────────────────────────────────────────────────────────────────

test('actAdd: single text', () => {
  const r = actAdd(emptyState(), 'first', undefined);
  assertOk(r);

  expect(r.state.todos.length).toBe(1);
  expect(r.state.todos[0]).toEqual({ id: 1, text: 'first', status: 'pending' });
  expect(r.state.nextId).toBe(2);
  expect(r.summary).toMatch(/#1/);
});

test('actAdd: items array', () => {
  const r = actAdd(emptyState(), undefined, ['a', 'b', 'c']);
  assertOk(r);

  expect(r.state.todos.map((t) => t.id)).toEqual([1, 2, 3]);
  expect(r.state.nextId).toBe(4);
});

test('actAdd: text + items combine, text first', () => {
  const r = actAdd(emptyState(), 'solo', ['one', 'two']);
  assertOk(r);

  expect(r.state.todos.map((t) => t.text)).toEqual(['solo', 'one', 'two']);
});

test('actAdd: ids stay monotonic after intermediate completions', () => {
  const start = actAdd(emptyState(), undefined, ['a', 'b']);
  assertOk(start);
  const afterComplete = actComplete(start.state, 1, undefined);
  assertOk(afterComplete);
  const more = actAdd(afterComplete.state, 'c', undefined);
  assertOk(more);

  expect(more.state.todos.map((t) => t.id)).toEqual([1, 2, 3]);
  expect(more.state.nextId).toBe(4);
});

test('actAdd: trims whitespace, skips empty strings', () => {
  const r = actAdd(emptyState(), '  ', ['', '  valid  ', '   ']);
  assertOk(r);

  expect(r.state.todos.length).toBe(1);
  expect(r.state.todos[0].text).toBe('valid');
});

test('actAdd: empty args returns error', () => {
  const r = actAdd(emptyState(), undefined, undefined);
  assertErr(r);

  expect(r.error).toMatch(/text.*items/);
});

test('actAdd: all-whitespace input returns error', () => {
  const r = actAdd(emptyState(), '   ', ['', '  ']);

  expect(r.ok).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// actStart
// ──────────────────────────────────────────────────────────────────────

test('actStart: marks pending todo in_progress', () => {
  const r = actStart(seeded(), 1);
  assertOk(r);

  expect(r.state.todos.find((t) => t.id === 1)!.status).toBe('in_progress');
});

test('actStart: enforces at-most-one in_progress invariant', () => {
  const after1 = actStart(seeded(), 1);
  assertOk(after1);
  const after2 = actStart(after1.state, 2);
  assertErr(after2);

  expect(after2.error).toMatch(/#1.*in_progress/);
  expect(after2.error).toMatch(/complete|block|reopen/i);
});

test('actStart: idempotent when already in_progress', () => {
  const s1 = actStart(seeded(), 1);
  assertOk(s1);
  const s2 = actStart(s1.state, 1);
  assertOk(s2);

  expect(s2.state.todos.find((t) => t.id === 1)!.status).toBe('in_progress');
});

test('actStart: missing id returns error', () => {
  const r = actStart(seeded(), undefined);

  expect(r.ok).toBe(false);
});

test('actStart: unknown id returns error', () => {
  const r = actStart(seeded(), 99);
  assertErr(r);

  expect(r.error).toMatch(/#99/);
});

test('actStart: clears prior note when (re)starting a blocked item after reopen', () => {
  const blocked = actBlock(seeded(), 1, 'network');
  assertOk(blocked);
  const reopened = actReopen(blocked.state, 1);
  assertOk(reopened);
  const started = actStart(reopened.state, 1);
  assertOk(started);

  expect(started.state.todos.find((t) => t.id === 1)!.note).toBe(undefined);
});

test('actStart: transitions a review item back to in_progress (for more work)', () => {
  const started = actStart(seeded(), 1);
  assertOk(started);
  const parked = actReview(started.state, 1, 'waiting on tests');
  assertOk(parked);
  const restarted = actStart(parked.state, 1);
  assertOk(restarted);
  const t = restarted.state.todos.find((x) => x.id === 1)!;

  expect(t.status).toBe('in_progress');
  expect(t.note, 'start clears the review-era note').toBe(undefined);
});

test('actStart: does not count a review item against the in_progress WIP limit', () => {
  const started = actStart(seeded(), 1);
  assertOk(started);
  const parked = actReview(started.state, 1, 'verifying');
  assertOk(parked);
  // #1 is in review (not in_progress), so starting #2 should succeed.
  const startTwo = actStart(parked.state, 2);
  assertOk(startTwo);

  expect(startTwo.state.todos.find((t) => t.id === 1)!.status).toBe('review');
  expect(startTwo.state.todos.find((t) => t.id === 2)!.status).toBe('in_progress');
});

// ──────────────────────────────────────────────────────────────────────
// actReview
// ──────────────────────────────────────────────────────────────────────

test('actReview: transitions an in_progress item to review', () => {
  const r = actReview(startedSeed(1), 1, undefined);
  assertOk(r);

  expect(r.state.todos.find((t) => t.id === 1)!.status).toBe('review');
});

test('actReview: stores trimmed optional note', () => {
  const r = actReview(startedSeed(1), 1, '  waiting on CI  ');
  assertOk(r);

  expect(r.state.todos.find((t) => t.id === 1)!.note).toBe('waiting on CI');
});

test('actReview: missing id returns error', () => {
  const r = actReview(startedSeed(1), undefined, undefined);

  expect(r.ok).toBe(false);
});

test('actReview: unknown id returns error', () => {
  const r = actReview(startedSeed(1), 99, undefined);
  assertErr(r);

  expect(r.error).toMatch(/#99/);
});

test('actReview: rejects item in pending', () => {
  const r = actReview(seeded(), 1, undefined);
  assertErr(r);

  expect(r.error).toMatch(/pending/);
  expect(r.error).toMatch(/start/);
});

test('actReview: rejects item in completed', () => {
  const done = actComplete(seeded(), 1, undefined);
  assertOk(done);
  const r = actReview(done.state, 1, undefined);
  assertErr(r);

  expect(r.error).toMatch(/completed/);
});

test('actReview: rejects item in blocked', () => {
  const b = actBlock(seeded(), 1, 'stuck');
  assertOk(b);
  const r = actReview(b.state, 1, undefined);
  assertErr(r);

  expect(r.error).toMatch(/blocked/);
});

test('actReview: idempotent when already in review, updates note if provided', () => {
  const s1 = actReview(startedSeed(1), 1, 'first');
  assertOk(s1);
  const s2 = actReview(s1.state, 1, 'second');
  assertOk(s2);

  expect(s2.state.todos.find((t) => t.id === 1)!.status).toBe('review');
  expect(s2.state.todos.find((t) => t.id === 1)!.note).toBe('second');
});

test('actReview: idempotent clears note when called with undefined', () => {
  const s1 = actReview(startedSeed(1), 1, 'first');
  assertOk(s1);
  const s2 = actReview(s1.state, 1, undefined);
  assertOk(s2);

  expect(s2.state.todos.find((t) => t.id === 1)!.note).toBe(undefined);
});

test('actReview: enforces at-most-one review invariant', () => {
  // Park #1 in review.
  const parked = actReview(startedSeed(1), 1, undefined);
  assertOk(parked);
  // Start + try to review #2 while #1 is still in review.
  const started2 = actStart(parked.state, 2);
  assertOk(started2);
  const parked2 = actReview(started2.state, 2, undefined);
  assertErr(parked2);

  expect(parked2.error).toMatch(/#1.*review/);
  expect(parked2.error).toMatch(/complete|reopen|block/i);
});

// ──────────────────────────────────────────────────────────────────────
// actComplete: note requirement from in_progress
// ──────────────────────────────────────────────────────────────────────

test('actComplete: requires note when transitioning directly from in_progress', () => {
  const r = actComplete(startedSeed(1), 1, undefined);
  assertErr(r);

  expect(r.error).toMatch(/in_progress/);
  expect(r.error).toMatch(/note/);
  expect(r.error).toMatch(/review/);
});

test('actComplete: requires non-whitespace note from in_progress', () => {
  const r = actComplete(startedSeed(1), 1, '   ');

  expect(r.ok).toBe(false);
});

test('actComplete: succeeds from in_progress with evidence note', () => {
  const r = actComplete(startedSeed(1), 1, 'all 42 tests pass');
  assertOk(r);
  const t = r.state.todos.find((x) => x.id === 1)!;

  expect(t.status).toBe('completed');
  expect(t.note).toBe('all 42 tests pass');
});

test('actComplete: does NOT require note when coming from review', () => {
  const parked = actReview(startedSeed(1), 1, 'ran tests, green');
  assertOk(parked);
  const r = actComplete(parked.state, 1, undefined);
  assertOk(r);
  const t = r.state.todos.find((x) => x.id === 1)!;

  expect(t.status).toBe('completed');
  // undefined note on complete clears the review-era note
  expect(t.note).toBe(undefined);
});

test('actComplete: accepts override note when coming from review', () => {
  const parked = actReview(startedSeed(1), 1, 'first');
  assertOk(parked);
  const r = actComplete(parked.state, 1, 'final: green on CI');
  assertOk(r);

  expect(r.state.todos.find((t) => t.id === 1)!.note).toBe('final: green on CI');
});

test('actComplete: id check precedes in_progress note check', () => {
  // Unknown id must return #id not found, not the in_progress-note error,
  // even when the note is missing.
  const r = actComplete(startedSeed(1), 99, undefined);
  assertErr(r);

  expect(r.error).toMatch(/#99 not found/);
});

// ──────────────────────────────────────────────────────────────────────
// actComplete (legacy: existing transitions)
// ──────────────────────────────────────────────────────────────────────

test('actComplete: marks todo completed', () => {
  const r = actComplete(seeded(), 2, undefined);
  assertOk(r);

  expect(r.state.todos.find((t) => t.id === 2)!.status).toBe('completed');
});

test('actComplete: stores optional note', () => {
  const r = actComplete(seeded(), 2, 'verified by tests');
  assertOk(r);

  expect(r.state.todos.find((t) => t.id === 2)!.note).toBe('verified by tests');
});

test('actComplete: omitted note clears any prior note', () => {
  const blocked = actBlock(seeded(), 2, 'waiting');
  assertOk(blocked);
  const done = actComplete(blocked.state, 2, undefined);
  assertOk(done);

  expect(done.state.todos.find((t) => t.id === 2)!.note).toBe(undefined);
});

test('actComplete: whitespace-only note clears prior note', () => {
  const b = actBlock(seeded(), 2, 'waiting');
  assertOk(b);
  const d = actComplete(b.state, 2, '   ');
  assertOk(d);

  expect(d.state.todos.find((t) => t.id === 2)!.note).toBe(undefined);
});

test('actComplete: missing id returns error', () => {
  const r = actComplete(seeded(), undefined, undefined);

  expect(r.ok).toBe(false);
});

test('actComplete: unknown id returns error', () => {
  const r = actComplete(seeded(), 99, undefined);

  expect(r.ok).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// actBlock
// ──────────────────────────────────────────────────────────────────────

test('actBlock: requires note', () => {
  const r = actBlock(seeded(), 1, undefined);
  assertErr(r);

  expect(r.error).toMatch(/note/);
});

test('actBlock: rejects whitespace-only note', () => {
  const r = actBlock(seeded(), 1, '   ');

  expect(r.ok).toBe(false);
});

test('actBlock: marks todo blocked with trimmed note', () => {
  const r = actBlock(seeded(), 1, '  flaky CI  ');
  assertOk(r);
  const t = r.state.todos.find((x) => x.id === 1)!;

  expect(t.status).toBe('blocked');
  expect(t.note).toBe('flaky CI');
});

test('actBlock: unknown id returns error', () => {
  const r = actBlock(seeded(), 99, 'reason');

  expect(r.ok).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// actReopen
// ──────────────────────────────────────────────────────────────────────

test('actReopen: restores todo to pending from completed', () => {
  const done = actComplete(seeded(), 1, 'note');
  assertOk(done);
  const r = actReopen(done.state, 1);
  assertOk(r);
  const t = r.state.todos.find((x) => x.id === 1)!;

  expect(t.status).toBe('pending');
  expect(t.note).toBe(undefined);
});

test('actReopen: restores todo to pending from blocked, clearing note', () => {
  const b = actBlock(seeded(), 1, 'stuck');
  assertOk(b);
  const r = actReopen(b.state, 1);
  assertOk(r);

  expect(r.state.todos.find((t) => t.id === 1)!.note).toBe(undefined);
});

test('actReopen: missing id returns error', () => {
  const r = actReopen(seeded(), undefined);

  expect(r.ok).toBe(false);
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
  expect(out).toMatch(/\[!\] #4 d — why/);
  expect(out).toMatch(/\[\?\] #5 e — awaiting ci/);
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
