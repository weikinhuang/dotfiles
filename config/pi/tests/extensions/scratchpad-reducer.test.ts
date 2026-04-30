/**
 * Tests for config/pi/extensions/lib/scratchpad-reducer.ts.
 *
 * Run:  node --test config/pi/tests/extensions/scratchpad-reducer.test.ts
 *   or: node --test config/pi/tests/
 *
 * Pure module — no pi runtime needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actAppend,
  actClear,
  actList,
  actRemove,
  actUpdate,
  type BranchEntry,
  cloneState,
  emptyState,
  formatText,
  isScratchpadStateShape,
  reduceBranch,
  SCRATCHPAD_CUSTOM_TYPE,
  SCRATCHPAD_TOOL_NAME,
  type ScratchNote,
  type ScratchpadState,
  stateFromEntry,
} from '../../extensions/lib/scratchpad-reducer.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const mkState = (notes: ScratchNote[], nextId?: number): ScratchpadState => ({
  notes: notes.map((n) => ({ ...n })),
  nextId: nextId ?? notes.reduce((m, n) => Math.max(m, n.id), 0) + 1,
});

const mkToolResult = (state: ScratchpadState): BranchEntry => ({
  type: 'message',
  message: { role: 'toolResult', toolName: SCRATCHPAD_TOOL_NAME, details: state },
});

const mkCustom = (state: ScratchpadState): BranchEntry => ({
  type: 'custom',
  customType: SCRATCHPAD_CUSTOM_TYPE,
  data: state,
});

const mkAssistant = (): BranchEntry => ({ type: 'message', message: { role: 'assistant' } });

const mkUnrelatedToolResult = (): BranchEntry => ({
  type: 'message',
  message: { role: 'toolResult', toolName: 'read', details: { path: 'x' } },
});

// ──────────────────────────────────────────────────────────────────────
// isScratchpadStateShape
// ──────────────────────────────────────────────────────────────────────

test('isScratchpadStateShape: accepts valid empty state', () => {
  assert.equal(isScratchpadStateShape({ notes: [], nextId: 1 }), true);
});

test('isScratchpadStateShape: accepts note with heading', () => {
  assert.equal(isScratchpadStateShape({ notes: [{ id: 1, body: 'b', heading: 'h' }], nextId: 2 }), true);
});

test('isScratchpadStateShape: accepts note without heading', () => {
  assert.equal(isScratchpadStateShape({ notes: [{ id: 1, body: 'b' }], nextId: 2 }), true);
});

test('isScratchpadStateShape: rejects non-object', () => {
  assert.equal(isScratchpadStateShape(null), false);
  assert.equal(isScratchpadStateShape(undefined), false);
  assert.equal(isScratchpadStateShape('nope'), false);
  assert.equal(isScratchpadStateShape(42), false);
});

test('isScratchpadStateShape: rejects missing nextId', () => {
  assert.equal(isScratchpadStateShape({ notes: [] }), false);
});

test('isScratchpadStateShape: rejects non-array notes', () => {
  assert.equal(isScratchpadStateShape({ notes: 'x', nextId: 1 }), false);
});

test('isScratchpadStateShape: rejects missing body', () => {
  assert.equal(isScratchpadStateShape({ notes: [{ id: 1 }], nextId: 2 }), false);
});

test('isScratchpadStateShape: rejects non-string heading', () => {
  assert.equal(isScratchpadStateShape({ notes: [{ id: 1, body: 'b', heading: 42 }], nextId: 2 }), false);
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
    message: { role: 'toolResult', toolName: SCRATCHPAD_TOOL_NAME, details: { garbage: true } },
  };
  assert.equal(stateFromEntry(entry), null);
});

test('stateFromEntry: returns null when custom data is malformed', () => {
  const entry: BranchEntry = { type: 'custom', customType: SCRATCHPAD_CUSTOM_TYPE, data: 'nope' };
  assert.equal(stateFromEntry(entry), null);
});

test('stateFromEntry: extracts state from tool-result details', () => {
  const s = mkState([{ id: 1, body: 'a' }]);
  assert.deepEqual(stateFromEntry(mkToolResult(s)), s);
});

test('stateFromEntry: extracts state from custom mirror', () => {
  const s = mkState([{ id: 7, body: 'zz', heading: 'decisions' }], 8);
  assert.deepEqual(stateFromEntry(mkCustom(s)), s);
});

test('stateFromEntry: returns a clone, not the same reference', () => {
  const s = mkState([{ id: 1, body: 'a' }]);
  const out = stateFromEntry(mkToolResult(s))!;
  out.notes[0]!.body = 'mutated';
  assert.equal(s.notes[0]!.body, 'a');
});

test('reduceBranch: empty branch returns empty state', () => {
  assert.deepEqual(reduceBranch([]), emptyState());
});

test('reduceBranch: skips entries with no valid snapshot', () => {
  assert.deepEqual(reduceBranch([mkAssistant(), mkUnrelatedToolResult(), mkAssistant()]), emptyState());
});

test('reduceBranch: picks the last tool-result snapshot on the branch', () => {
  const first = mkState([{ id: 1, body: 'a' }]);
  const last = mkState(
    [
      { id: 1, body: 'a' },
      { id: 2, body: 'b' },
    ],
    3,
  );
  assert.deepEqual(reduceBranch([mkToolResult(first), mkAssistant(), mkToolResult(last), mkAssistant()]), last);
});

test('reduceBranch: falls back to custom mirror when only it exists (post-compaction)', () => {
  const s = mkState([{ id: 3, body: 'y', heading: 'paths' }], 4);
  assert.deepEqual(reduceBranch([mkAssistant(), mkCustom(s), mkAssistant()]), s);
});

test('reduceBranch: later entry wins regardless of kind', () => {
  const older = mkState([{ id: 1, body: 'old' }]);
  const newer = mkState([{ id: 1, body: 'new' }]);
  assert.deepEqual(reduceBranch([mkToolResult(older), mkCustom(newer)]), newer);
  assert.deepEqual(reduceBranch([mkCustom(older), mkToolResult(newer)]), newer);
});

test('reduceBranch: ignores malformed entries and keeps scanning', () => {
  const good = mkState([{ id: 1, body: 'keep' }]);
  const bad: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: SCRATCHPAD_TOOL_NAME, details: { garbage: true } },
  };
  assert.deepEqual(reduceBranch([mkToolResult(good), bad]), good);
});

// ──────────────────────────────────────────────────────────────────────
// actAppend
// ──────────────────────────────────────────────────────────────────────

test('actAppend: adds a note without heading', () => {
  const r = actAppend(emptyState(), 'first note', undefined);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.state.notes.length, 1);
    assert.deepEqual(r.state.notes[0], { id: 1, body: 'first note' });
    assert.equal(r.state.nextId, 2);
  }
});

test('actAppend: adds a note with heading', () => {
  const r = actAppend(emptyState(), 'ran it', 'test commands');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.state.notes[0], { id: 1, body: 'ran it', heading: 'test commands' });
  }
});

test('actAppend: trims body and heading', () => {
  const r = actAppend(emptyState(), '  body  ', '  head  ');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.state.notes[0]!.body, 'body');
    assert.equal(r.state.notes[0]!.heading, 'head');
  }
});

test('actAppend: ids stay monotonic after intermediate removals', () => {
  const s1 = actAppend(emptyState(), 'a', undefined);
  const s2 = s1.ok ? actAppend(s1.state, 'b', undefined) : null;
  const rm = s2 && s2.ok ? actRemove(s2.state, 1) : null;
  const s3 = rm && rm.ok ? actAppend(rm.state, 'c', undefined) : null;
  assert.ok(s3 && s3.ok);
  if (s3 && s3.ok) {
    assert.deepEqual(
      s3.state.notes.map((n) => n.id),
      [2, 3],
    );
    assert.equal(s3.state.nextId, 4);
  }
});

test('actAppend: missing body returns error', () => {
  const r = actAppend(emptyState(), undefined, undefined);
  assert.equal(r.ok, false);
});

test('actAppend: whitespace-only body returns error', () => {
  const r = actAppend(emptyState(), '   ', 'h');
  assert.equal(r.ok, false);
});

test('actAppend: empty heading is ignored (no heading stored)', () => {
  const r = actAppend(emptyState(), 'body', '   ');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.notes[0]!.heading, undefined);
});

// ──────────────────────────────────────────────────────────────────────
// actUpdate
// ──────────────────────────────────────────────────────────────────────

function seeded(): ScratchpadState {
  const a = actAppend(emptyState(), 'one', 'heading-a');
  assert.equal(a.ok, true);
  if (!a.ok) return emptyState();
  const b = actAppend(a.state, 'two', undefined);
  assert.equal(b.ok, true);
  return b.ok ? b.state : a.state;
}

test('actUpdate: updates body', () => {
  const r = actUpdate(seeded(), 1, 'new body', undefined);
  assert.equal(r.ok, true);
  if (r.ok) {
    const n = r.state.notes.find((x) => x.id === 1)!;
    assert.equal(n.body, 'new body');
    assert.equal(n.heading, 'heading-a', 'heading untouched when omitted');
  }
});

test('actUpdate: updates heading alone', () => {
  const r = actUpdate(seeded(), 1, undefined, 'h2');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.state.notes.find((n) => n.id === 1)!.heading, 'h2');
    assert.equal(r.state.notes.find((n) => n.id === 1)!.body, 'one', 'body untouched');
  }
});

test('actUpdate: clears heading when passed whitespace', () => {
  const r = actUpdate(seeded(), 1, undefined, '   ');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.notes.find((n) => n.id === 1)!.heading, undefined);
});

test('actUpdate: adds heading to a note that had none', () => {
  const r = actUpdate(seeded(), 2, undefined, 'new-head');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.notes.find((n) => n.id === 2)!.heading, 'new-head');
});

test('actUpdate: missing id returns error', () => {
  const r = actUpdate(seeded(), undefined, 'x', undefined);
  assert.equal(r.ok, false);
});

test('actUpdate: unknown id returns error', () => {
  const r = actUpdate(seeded(), 99, 'x', undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /#99/);
});

test('actUpdate: both body and heading undefined returns error', () => {
  const r = actUpdate(seeded(), 1, undefined, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /body.*heading/i);
});

test('actUpdate: empty body returns error (points at `remove`)', () => {
  const r = actUpdate(seeded(), 1, '   ', undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /remove/);
});

// ──────────────────────────────────────────────────────────────────────
// actRemove
// ──────────────────────────────────────────────────────────────────────

test('actRemove: removes a note by id', () => {
  const r = actRemove(seeded(), 1);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.state.notes.length, 1);
    assert.equal(r.state.notes[0]!.id, 2);
  }
});

test('actRemove: does NOT reset nextId when removing the last note', () => {
  const s = seeded();
  const r1 = actRemove(s, 1);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  const r2 = actRemove(r1.state, 2);
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.deepEqual(r2.state.notes, []);
    // nextId intentionally does NOT reset — prevents id collisions if
    // the model references an old note number across a later append.
    assert.equal(r2.state.nextId, 3);
  }
});

test('actRemove: missing id returns error', () => {
  const r = actRemove(seeded(), undefined);
  assert.equal(r.ok, false);
});

test('actRemove: unknown id returns error', () => {
  const r = actRemove(seeded(), 99);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /#99/);
});

// ──────────────────────────────────────────────────────────────────────
// actClear
// ──────────────────────────────────────────────────────────────────────

test('actClear: empties populated state and resets nextId', () => {
  const r = actClear(seeded());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.state.notes, []);
    assert.equal(r.state.nextId, 1);
  }
});

test('actClear: returns a friendly message on empty state', () => {
  const r = actClear(emptyState());
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.summary, /empty/i);
});

// ──────────────────────────────────────────────────────────────────────
// actList / formatText
// ──────────────────────────────────────────────────────────────────────

test('actList: returns empty marker for empty state', () => {
  const r = actList(emptyState());
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.summary, /empty/i);
});

test('formatText: renders headings when present', () => {
  const s = mkState([
    { id: 1, body: 'a', heading: 'h' },
    { id: 2, body: 'b' },
  ]);
  const out = formatText(s);
  assert.match(out, /#1 \[h\] a/);
  assert.match(out, /#2 b/);
  assert.ok(!/\[.*\] b/.test(out), 'no heading brackets when heading absent');
});

// ──────────────────────────────────────────────────────────────────────
// cloneState: defensive deep copy
// ──────────────────────────────────────────────────────────────────────

test('cloneState: new state references do not alias the input', () => {
  const s = mkState([{ id: 1, body: 'a', heading: 'h' }]);
  const c = cloneState(s);
  c.notes[0]!.body = 'mutated';
  c.notes[0]!.heading = 'mutated-h';
  assert.equal(s.notes[0]!.body, 'a');
  assert.equal(s.notes[0]!.heading, 'h');
  c.notes.push({ id: 2, body: 'new' });
  assert.equal(s.notes.length, 1);
});
