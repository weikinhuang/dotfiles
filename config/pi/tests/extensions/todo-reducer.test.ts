/**
 * Tests for config/pi/extensions/lib/todo-reducer.ts.
 *
 * Run:  node --test config/pi/tests/extensions/todo-reducer.test.ts
 *   or: node --test config/pi/tests/
 *
 * The lib module has zero pi dependencies so these tests run without the
 * pi runtime. Branch entries are duck-typed fakes with just the fields
 * the reducer actually inspects — no SessionManager mocking.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
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
} from '../../extensions/lib/todo-reducer.ts';

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

// ──────────────────────────────────────────────────────────────────────
// isTodoStateShape
// ──────────────────────────────────────────────────────────────────────

test('isTodoStateShape: accepts valid empty state', () => {
  assert.equal(isTodoStateShape({ todos: [], nextId: 1 }), true);
});

test('isTodoStateShape: accepts valid populated state', () => {
  assert.equal(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'pending' }], nextId: 2 }), true);
});

test('isTodoStateShape: accepts note field', () => {
  assert.equal(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'blocked', note: 'why' }], nextId: 2 }), true);
});

test('isTodoStateShape: rejects non-object', () => {
  assert.equal(isTodoStateShape(null), false);
  assert.equal(isTodoStateShape(undefined), false);
  assert.equal(isTodoStateShape('nope'), false);
  assert.equal(isTodoStateShape(42), false);
});

test('isTodoStateShape: rejects missing nextId', () => {
  assert.equal(isTodoStateShape({ todos: [] }), false);
});

test('isTodoStateShape: rejects non-array todos', () => {
  assert.equal(isTodoStateShape({ todos: 'x', nextId: 1 }), false);
});

test('isTodoStateShape: accepts review status', () => {
  assert.equal(
    isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'review', note: 'awaiting ci' }], nextId: 2 }),
    true,
  );
});

test('isTodoStateShape: rejects bad status', () => {
  assert.equal(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'doing' }], nextId: 2 }), false);
});

test('isTodoStateShape: rejects non-string note', () => {
  assert.equal(isTodoStateShape({ todos: [{ id: 1, text: 'x', status: 'pending', note: 42 }], nextId: 2 }), false);
});

// ──────────────────────────────────────────────────────────────────────
// stateFromEntry / reduceBranch
// ──────────────────────────────────────────────────────────────────────

test('stateFromEntry: returns null for unrelated entries', () => {
  assert.equal(stateFromEntry(mkAssistant()), null);
  assert.equal(stateFromEntry(mkUnrelatedToolResult()), null);
  assert.equal(stateFromEntry({}), null);
});

test('stateFromEntry: returns null when tool-result details is malformed', () => {
  const entry: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: TODO_TOOL_NAME, details: { garbage: true } },
  };
  assert.equal(stateFromEntry(entry), null);
});

test('stateFromEntry: returns null when custom data is malformed', () => {
  const entry: BranchEntry = { type: 'custom', customType: TODO_CUSTOM_TYPE, data: 'nope' };
  assert.equal(stateFromEntry(entry), null);
});

test('stateFromEntry: extracts state from tool-result details', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const out = stateFromEntry(mkToolResult(s));
  assert.deepEqual(out, s);
});

test('stateFromEntry: extracts state from custom mirror', () => {
  const s = mkState([{ id: 7, text: 'z', status: 'completed' }], 8);
  const out = stateFromEntry(mkCustom(s));
  assert.deepEqual(out, s);
});

test('stateFromEntry: returns a clone, not the same reference', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const out = stateFromEntry(mkToolResult(s))!;
  out.todos[0]!.text = 'mutated';
  assert.equal(s.todos[0]!.text, 'a');
});

test('reduceBranch: empty branch returns empty state', () => {
  assert.deepEqual(reduceBranch([]), emptyState());
});

test('reduceBranch: skips entries with no valid snapshot', () => {
  assert.deepEqual(reduceBranch([mkAssistant(), mkUnrelatedToolResult(), mkAssistant()]), emptyState());
});

test('reduceBranch: picks the last tool-result snapshot on the branch', () => {
  const first = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const last = mkState([
    { id: 1, text: 'a', status: 'completed' },
    { id: 2, text: 'b', status: 'pending' },
  ]);
  assert.deepEqual(reduceBranch([mkToolResult(first), mkAssistant(), mkToolResult(last), mkAssistant()]), last);
});

test('reduceBranch: falls back to custom mirror when only it exists (post-compaction)', () => {
  const s = mkState([{ id: 3, text: 'y', status: 'in_progress' }], 4);
  assert.deepEqual(reduceBranch([mkAssistant(), mkCustom(s), mkAssistant()]), s);
});

test('reduceBranch: later entry wins regardless of kind', () => {
  const older = mkState([{ id: 1, text: 'old', status: 'pending' }]);
  const newer = mkState([{ id: 1, text: 'new', status: 'completed' }]);
  // tool-result older, custom newer
  assert.deepEqual(reduceBranch([mkToolResult(older), mkCustom(newer)]), newer);
  // custom older, tool-result newer
  assert.deepEqual(reduceBranch([mkCustom(older), mkToolResult(newer)]), newer);
});

test('reduceBranch: ignores malformed entries and keeps scanning', () => {
  const good = mkState([{ id: 1, text: 'keep', status: 'pending' }]);
  const bad: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: TODO_TOOL_NAME, details: { garbage: true } },
  };
  assert.deepEqual(reduceBranch([mkToolResult(good), bad]), good);
});

// ──────────────────────────────────────────────────────────────────────
// actAdd
// ──────────────────────────────────────────────────────────────────────

test('actAdd: single text', () => {
  const r = actAdd(emptyState(), 'first', undefined);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.state.todos.length, 1);
    assert.deepEqual(r.state.todos[0], { id: 1, text: 'first', status: 'pending' });
    assert.equal(r.state.nextId, 2);
    assert.match(r.summary, /#1/);
  }
});

test('actAdd: items array', () => {
  const r = actAdd(emptyState(), undefined, ['a', 'b', 'c']);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(
      r.state.todos.map((t) => t.id),
      [1, 2, 3],
    );
    assert.equal(r.state.nextId, 4);
  }
});

test('actAdd: text + items combine, text first', () => {
  const r = actAdd(emptyState(), 'solo', ['one', 'two']);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(
      r.state.todos.map((t) => t.text),
      ['solo', 'one', 'two'],
    );
  }
});

test('actAdd: ids stay monotonic after intermediate completions', () => {
  const start = actAdd(emptyState(), undefined, ['a', 'b']);
  assert.equal(start.ok, true);
  if (!start.ok) return;
  const afterComplete = actComplete(start.state, 1, undefined);
  assert.equal(afterComplete.ok, true);
  if (!afterComplete.ok) return;
  const more = actAdd(afterComplete.state, 'c', undefined);
  assert.equal(more.ok, true);
  if (more.ok) {
    assert.deepEqual(
      more.state.todos.map((t) => t.id),
      [1, 2, 3],
    );
    assert.equal(more.state.nextId, 4);
  }
});

test('actAdd: trims whitespace, skips empty strings', () => {
  const r = actAdd(emptyState(), '  ', ['', '  valid  ', '   ']);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.state.todos.length, 1);
    assert.equal(r.state.todos[0]!.text, 'valid');
  }
});

test('actAdd: empty args returns error', () => {
  const r = actAdd(emptyState(), undefined, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /text.*items/);
});

test('actAdd: all-whitespace input returns error', () => {
  const r = actAdd(emptyState(), '   ', ['', '  ']);
  assert.equal(r.ok, false);
});

// ──────────────────────────────────────────────────────────────────────
// actStart
// ──────────────────────────────────────────────────────────────────────

function seeded(): TodoState {
  const s = actAdd(emptyState(), undefined, ['first', 'second', 'third']);
  assert.equal(s.ok, true);
  return s.ok ? s.state : emptyState();
}

test('actStart: marks pending todo in_progress', () => {
  const r = actStart(seeded(), 1);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.todos.find((t) => t.id === 1)!.status, 'in_progress');
});

test('actStart: enforces at-most-one in_progress invariant', () => {
  const after1 = actStart(seeded(), 1);
  assert.equal(after1.ok, true);
  if (!after1.ok) return;
  const after2 = actStart(after1.state, 2);
  assert.equal(after2.ok, false);
  if (!after2.ok) {
    assert.match(after2.error, /#1.*in_progress/);
    assert.match(after2.error, /complete|block|reopen/i);
  }
});

test('actStart: idempotent when already in_progress', () => {
  const s1 = actStart(seeded(), 1);
  assert.equal(s1.ok, true);
  if (!s1.ok) return;
  const s2 = actStart(s1.state, 1);
  assert.equal(s2.ok, true);
  if (s2.ok) assert.equal(s2.state.todos.find((t) => t.id === 1)!.status, 'in_progress');
});

test('actStart: missing id returns error', () => {
  const r = actStart(seeded(), undefined);
  assert.equal(r.ok, false);
});

test('actStart: unknown id returns error', () => {
  const r = actStart(seeded(), 99);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /#99/);
});

test('actStart: clears prior note when (re)starting a blocked item after reopen', () => {
  const s = seeded();
  const blocked = actBlock(s, 1, 'network');
  assert.equal(blocked.ok, true);
  if (!blocked.ok) return;
  const reopened = actReopen(blocked.state, 1);
  assert.equal(reopened.ok, true);
  if (!reopened.ok) return;
  const started = actStart(reopened.state, 1);
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.state.todos.find((t) => t.id === 1)!.note, undefined);
});

test('actStart: transitions a review item back to in_progress (for more work)', () => {
  const started = actStart(seeded(), 1);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const parked = actReview(started.state, 1, 'waiting on tests');
  assert.equal(parked.ok, true);
  if (!parked.ok) return;
  const restarted = actStart(parked.state, 1);
  assert.equal(restarted.ok, true);
  if (restarted.ok) {
    const t = restarted.state.todos.find((x) => x.id === 1)!;
    assert.equal(t.status, 'in_progress');
    assert.equal(t.note, undefined, 'start clears the review-era note');
  }
});

test('actStart: does not count a review item against the in_progress WIP limit', () => {
  const started = actStart(seeded(), 1);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const parked = actReview(started.state, 1, 'verifying');
  assert.equal(parked.ok, true);
  if (!parked.ok) return;
  // #1 is in review (not in_progress), so starting #2 should succeed.
  const startTwo = actStart(parked.state, 2);
  assert.equal(startTwo.ok, true);
  if (startTwo.ok) {
    assert.equal(startTwo.state.todos.find((t) => t.id === 1)!.status, 'review');
    assert.equal(startTwo.state.todos.find((t) => t.id === 2)!.status, 'in_progress');
  }
});

// ──────────────────────────────────────────────────────────────────────
// actComplete
// ──────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// actReview
// ───────────────────────────────────────────────────────────────────────

function startedSeed(id = 1): TodoState {
  const seed = seeded();
  const r = actStart(seed, id);
  assert.equal(r.ok, true);
  return r.ok ? r.state : seed;
}

test('actReview: transitions an in_progress item to review', () => {
  const r = actReview(startedSeed(1), 1, undefined);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.todos.find((t) => t.id === 1)!.status, 'review');
});

test('actReview: stores trimmed optional note', () => {
  const r = actReview(startedSeed(1), 1, '  waiting on CI  ');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.todos.find((t) => t.id === 1)!.note, 'waiting on CI');
});

test('actReview: missing id returns error', () => {
  const r = actReview(startedSeed(1), undefined, undefined);
  assert.equal(r.ok, false);
});

test('actReview: unknown id returns error', () => {
  const r = actReview(startedSeed(1), 99, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /#99/);
});

test('actReview: rejects item in pending', () => {
  const r = actReview(seeded(), 1, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /pending/);
    assert.match(r.error, /start/);
  }
});

test('actReview: rejects item in completed', () => {
  const done = actComplete(seeded(), 1, undefined);
  assert.equal(done.ok, true);
  if (!done.ok) return;
  const r = actReview(done.state, 1, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /completed/);
});

test('actReview: rejects item in blocked', () => {
  const b = actBlock(seeded(), 1, 'stuck');
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const r = actReview(b.state, 1, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /blocked/);
});

test('actReview: idempotent when already in review, updates note if provided', () => {
  const s1 = actReview(startedSeed(1), 1, 'first');
  assert.equal(s1.ok, true);
  if (!s1.ok) return;
  const s2 = actReview(s1.state, 1, 'second');
  assert.equal(s2.ok, true);
  if (s2.ok) {
    assert.equal(s2.state.todos.find((t) => t.id === 1)!.status, 'review');
    assert.equal(s2.state.todos.find((t) => t.id === 1)!.note, 'second');
  }
});

test('actReview: idempotent clears note when called with undefined', () => {
  const s1 = actReview(startedSeed(1), 1, 'first');
  assert.equal(s1.ok, true);
  if (!s1.ok) return;
  const s2 = actReview(s1.state, 1, undefined);
  assert.equal(s2.ok, true);
  if (s2.ok) assert.equal(s2.state.todos.find((t) => t.id === 1)!.note, undefined);
});

test('actReview: enforces at-most-one review invariant', () => {
  // Park #1 in review.
  const s1 = startedSeed(1);
  const parked = actReview(s1, 1, undefined);
  assert.equal(parked.ok, true);
  if (!parked.ok) return;
  // Start + try to review #2 while #1 is still in review.
  const started2 = actStart(parked.state, 2);
  assert.equal(started2.ok, true);
  if (!started2.ok) return;
  const parked2 = actReview(started2.state, 2, undefined);
  assert.equal(parked2.ok, false);
  if (!parked2.ok) {
    assert.match(parked2.error, /#1.*review/);
    assert.match(parked2.error, /complete|reopen|block/i);
  }
});

// ───────────────────────────────────────────────────────────────────────
// actComplete: note requirement from in_progress
// ───────────────────────────────────────────────────────────────────────

test('actComplete: requires note when transitioning directly from in_progress', () => {
  const r = actComplete(startedSeed(1), 1, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /in_progress/);
    assert.match(r.error, /note/);
    assert.match(r.error, /review/);
  }
});

test('actComplete: requires non-whitespace note from in_progress', () => {
  const r = actComplete(startedSeed(1), 1, '   ');
  assert.equal(r.ok, false);
});

test('actComplete: succeeds from in_progress with evidence note', () => {
  const r = actComplete(startedSeed(1), 1, 'all 42 tests pass');
  assert.equal(r.ok, true);
  if (r.ok) {
    const t = r.state.todos.find((x) => x.id === 1)!;
    assert.equal(t.status, 'completed');
    assert.equal(t.note, 'all 42 tests pass');
  }
});

test('actComplete: does NOT require note when coming from review', () => {
  const s1 = startedSeed(1);
  const parked = actReview(s1, 1, 'ran tests, green');
  assert.equal(parked.ok, true);
  if (!parked.ok) return;
  const r = actComplete(parked.state, 1, undefined);
  assert.equal(r.ok, true, 'review parking counts as verification');
  if (r.ok) {
    const t = r.state.todos.find((x) => x.id === 1)!;
    assert.equal(t.status, 'completed');
    // undefined note on complete clears the review-era note
    assert.equal(t.note, undefined);
  }
});

test('actComplete: accepts override note when coming from review', () => {
  const s1 = startedSeed(1);
  const parked = actReview(s1, 1, 'first');
  assert.equal(parked.ok, true);
  if (!parked.ok) return;
  const r = actComplete(parked.state, 1, 'final: green on CI');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.todos.find((t) => t.id === 1)!.note, 'final: green on CI');
});

test('actComplete: id check precedes in_progress note check', () => {
  // Unknown id must return #id not found, not the in_progress-note error,
  // even when the note is missing.
  const r = actComplete(startedSeed(1), 99, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /#99 not found/);
});

// ───────────────────────────────────────────────────────────────────────
// actComplete (legacy: existing transitions)
// ───────────────────────────────────────────────────────────────────────

test('actComplete: marks todo completed', () => {
  const r = actComplete(seeded(), 2, undefined);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.todos.find((t) => t.id === 2)!.status, 'completed');
});

test('actComplete: stores optional note', () => {
  const r = actComplete(seeded(), 2, 'verified by tests');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.todos.find((t) => t.id === 2)!.note, 'verified by tests');
});

test('actComplete: omitted note clears any prior note', () => {
  const blocked = actBlock(seeded(), 2, 'waiting');
  assert.equal(blocked.ok, true);
  if (!blocked.ok) return;
  const done = actComplete(blocked.state, 2, undefined);
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.state.todos.find((t) => t.id === 2)!.note, undefined);
});

test('actComplete: whitespace-only note clears prior note', () => {
  const b = actBlock(seeded(), 2, 'waiting');
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const d = actComplete(b.state, 2, '   ');
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.state.todos.find((t) => t.id === 2)!.note, undefined);
});

test('actComplete: missing id returns error', () => {
  const r = actComplete(seeded(), undefined, undefined);
  assert.equal(r.ok, false);
});

test('actComplete: unknown id returns error', () => {
  const r = actComplete(seeded(), 99, undefined);
  assert.equal(r.ok, false);
});

// ──────────────────────────────────────────────────────────────────────
// actBlock
// ──────────────────────────────────────────────────────────────────────

test('actBlock: requires note', () => {
  const r = actBlock(seeded(), 1, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /note/);
});

test('actBlock: rejects whitespace-only note', () => {
  const r = actBlock(seeded(), 1, '   ');
  assert.equal(r.ok, false);
});

test('actBlock: marks todo blocked with trimmed note', () => {
  const r = actBlock(seeded(), 1, '  flaky CI  ');
  assert.equal(r.ok, true);
  if (r.ok) {
    const t = r.state.todos.find((x) => x.id === 1)!;
    assert.equal(t.status, 'blocked');
    assert.equal(t.note, 'flaky CI');
  }
});

test('actBlock: unknown id returns error', () => {
  const r = actBlock(seeded(), 99, 'reason');
  assert.equal(r.ok, false);
});

// ──────────────────────────────────────────────────────────────────────
// actReopen
// ──────────────────────────────────────────────────────────────────────

test('actReopen: restores todo to pending from completed', () => {
  const done = actComplete(seeded(), 1, 'note');
  assert.equal(done.ok, true);
  if (!done.ok) return;
  const r = actReopen(done.state, 1);
  assert.equal(r.ok, true);
  if (r.ok) {
    const t = r.state.todos.find((x) => x.id === 1)!;
    assert.equal(t.status, 'pending');
    assert.equal(t.note, undefined);
  }
});

test('actReopen: restores todo to pending from blocked, clearing note', () => {
  const b = actBlock(seeded(), 1, 'stuck');
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const r = actReopen(b.state, 1);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.todos.find((t) => t.id === 1)!.note, undefined);
});

test('actReopen: missing id returns error', () => {
  const r = actReopen(seeded(), undefined);
  assert.equal(r.ok, false);
});

// ──────────────────────────────────────────────────────────────────────
// actClear
// ──────────────────────────────────────────────────────────────────────

test('actClear: empties populated state and resets nextId', () => {
  const r = actClear(seeded());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.state.todos, []);
    assert.equal(r.state.nextId, 1);
  }
});

test('actClear: returns "Nothing to clear" on empty state', () => {
  const r = actClear(emptyState());
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.summary, /Nothing to clear/);
});

// ──────────────────────────────────────────────────────────────────────
// actList / formatText
// ──────────────────────────────────────────────────────────────────────

test('actList: returns "No todos" for empty state', () => {
  const r = actList(emptyState());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.summary, 'No todos');
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
  assert.match(out, /\[ \] #1 a/);
  assert.match(out, /\[\*\] #2 b/);
  assert.match(out, /\[x\] #3 c/);
  assert.match(out, /\[!\] #4 d — why/);
  assert.match(out, /\[\?\] #5 e — awaiting ci/);
});

// ──────────────────────────────────────────────────────────────────────
// cloneState: defensive deep copy
// ──────────────────────────────────────────────────────────────────────

test('cloneState: new state references do not alias the input', () => {
  const s = mkState([{ id: 1, text: 'a', status: 'pending' }]);
  const c = cloneState(s);
  c.todos[0]!.text = 'mutated';
  assert.equal(s.todos[0]!.text, 'a');
  c.todos.push({ id: 2, text: 'new', status: 'pending' });
  assert.equal(s.todos.length, 1);
});
