/**
 * Tests for lib/node/pi/scratchpad-reducer.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

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
} from '../../../../lib/node/pi/scratchpad-reducer.ts';
import { assertErr, assertOk } from './helpers.ts';

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

// Two-step builder used by most of the action-handler tests below. Throws
// (via `assertOk`) if the seed action fails, so tests that depend on it
// can't accidentally run against an empty state.
function seeded(): ScratchpadState {
  const a = actAppend(emptyState(), 'one', 'heading-a');
  assertOk(a);
  const b = actAppend(a.state, 'two', undefined);
  assertOk(b);
  return b.state;
}

// ──────────────────────────────────────────────────────────────────────
// isScratchpadStateShape
// ──────────────────────────────────────────────────────────────────────

test('isScratchpadStateShape: accepts valid empty state', () => {
  expect(isScratchpadStateShape({ notes: [], nextId: 1 })).toBe(true);
});

test('isScratchpadStateShape: accepts note with heading', () => {
  expect(isScratchpadStateShape({ notes: [{ id: 1, body: 'b', heading: 'h' }], nextId: 2 })).toBe(true);
});

test('isScratchpadStateShape: accepts note without heading', () => {
  expect(isScratchpadStateShape({ notes: [{ id: 1, body: 'b' }], nextId: 2 })).toBe(true);
});

test('isScratchpadStateShape: rejects non-object', () => {
  expect(isScratchpadStateShape(null)).toBe(false);
  expect(isScratchpadStateShape(undefined)).toBe(false);
  expect(isScratchpadStateShape('nope')).toBe(false);
  expect(isScratchpadStateShape(42)).toBe(false);
});

test('isScratchpadStateShape: rejects missing nextId', () => {
  expect(isScratchpadStateShape({ notes: [] })).toBe(false);
});

test('isScratchpadStateShape: rejects non-array notes', () => {
  expect(isScratchpadStateShape({ notes: 'x', nextId: 1 })).toBe(false);
});

test('isScratchpadStateShape: rejects missing body', () => {
  expect(isScratchpadStateShape({ notes: [{ id: 1 }], nextId: 2 })).toBe(false);
});

test('isScratchpadStateShape: rejects non-string heading', () => {
  expect(isScratchpadStateShape({ notes: [{ id: 1, body: 'b', heading: 42 }], nextId: 2 })).toBe(false);
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
    message: { role: 'toolResult', toolName: SCRATCHPAD_TOOL_NAME, details: { garbage: true } },
  };

  expect(stateFromEntry(entry)).toBe(null);
});

test('stateFromEntry: returns null when custom data is malformed', () => {
  const entry: BranchEntry = { type: 'custom', customType: SCRATCHPAD_CUSTOM_TYPE, data: 'nope' };

  expect(stateFromEntry(entry)).toBe(null);
});

test('stateFromEntry: extracts state from tool-result details', () => {
  const s = mkState([{ id: 1, body: 'a' }]);

  expect(stateFromEntry(mkToolResult(s))).toEqual(s);
});

test('stateFromEntry: extracts state from custom mirror', () => {
  const s = mkState([{ id: 7, body: 'zz', heading: 'decisions' }], 8);

  expect(stateFromEntry(mkCustom(s))).toEqual(s);
});

test('stateFromEntry: returns a clone, not the same reference', () => {
  const s = mkState([{ id: 1, body: 'a' }]);
  const out = stateFromEntry(mkToolResult(s))!;
  out.notes[0].body = 'mutated';

  expect(s.notes[0].body).toBe('a');
});

test('reduceBranch: empty branch returns empty state', () => {
  expect(reduceBranch([])).toEqual(emptyState());
});

test('reduceBranch: skips entries with no valid snapshot', () => {
  expect(reduceBranch([mkAssistant(), mkUnrelatedToolResult(), mkAssistant()])).toEqual(emptyState());
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

  expect(reduceBranch([mkToolResult(first), mkAssistant(), mkToolResult(last), mkAssistant()])).toEqual(last);
});

test('reduceBranch: falls back to custom mirror when only it exists (post-compaction)', () => {
  const s = mkState([{ id: 3, body: 'y', heading: 'paths' }], 4);

  expect(reduceBranch([mkAssistant(), mkCustom(s), mkAssistant()])).toEqual(s);
});

test('reduceBranch: later entry wins regardless of kind', () => {
  const older = mkState([{ id: 1, body: 'old' }]);
  const newer = mkState([{ id: 1, body: 'new' }]);

  expect(reduceBranch([mkToolResult(older), mkCustom(newer)])).toEqual(newer);
  expect(reduceBranch([mkCustom(older), mkToolResult(newer)])).toEqual(newer);
});

test('reduceBranch: ignores malformed entries and keeps scanning', () => {
  const good = mkState([{ id: 1, body: 'keep' }]);
  const bad: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: SCRATCHPAD_TOOL_NAME, details: { garbage: true } },
  };

  expect(reduceBranch([mkToolResult(good), bad])).toEqual(good);
});

// ──────────────────────────────────────────────────────────────────────
// actAppend
// ──────────────────────────────────────────────────────────────────────

test('actAppend: adds a note without heading', () => {
  const r = actAppend(emptyState(), 'first note', undefined);
  assertOk(r);

  expect(r.state.notes.length).toBe(1);
  expect(r.state.notes[0]).toEqual({ id: 1, body: 'first note' });
  expect(r.state.nextId).toBe(2);
});

test('actAppend: adds a note with heading', () => {
  const r = actAppend(emptyState(), 'ran it', 'test commands');
  assertOk(r);

  expect(r.state.notes[0]).toEqual({ id: 1, body: 'ran it', heading: 'test commands' });
});

test('actAppend: trims body and heading', () => {
  const r = actAppend(emptyState(), '  body  ', '  head  ');
  assertOk(r);

  expect(r.state.notes[0].body).toBe('body');
  expect(r.state.notes[0].heading).toBe('head');
});

test('actAppend: ids stay monotonic after intermediate removals', () => {
  const s1 = actAppend(emptyState(), 'a', undefined);
  assertOk(s1);
  const s2 = actAppend(s1.state, 'b', undefined);
  assertOk(s2);
  const rm = actRemove(s2.state, 1);
  assertOk(rm);
  const s3 = actAppend(rm.state, 'c', undefined);
  assertOk(s3);

  expect(s3.state.notes.map((n) => n.id)).toEqual([2, 3]);
  expect(s3.state.nextId).toBe(4);
});

test('actAppend: missing body returns error', () => {
  const r = actAppend(emptyState(), undefined, undefined);

  expect(r.ok).toBe(false);
});

test('actAppend: whitespace-only body returns error', () => {
  const r = actAppend(emptyState(), '   ', 'h');

  expect(r.ok).toBe(false);
});

test('actAppend: empty heading is ignored (no heading stored)', () => {
  const r = actAppend(emptyState(), 'body', '   ');
  assertOk(r);

  expect(r.state.notes[0].heading).toBe(undefined);
});

// ──────────────────────────────────────────────────────────────────────
// actUpdate
// ──────────────────────────────────────────────────────────────────────

test('actUpdate: updates body', () => {
  const r = actUpdate(seeded(), 1, 'new body', undefined);
  assertOk(r);
  const n = r.state.notes.find((x) => x.id === 1)!;

  expect(n.body).toBe('new body');
  expect(n.heading, 'heading untouched when omitted').toBe('heading-a');
});

test('actUpdate: updates heading alone', () => {
  const r = actUpdate(seeded(), 1, undefined, 'h2');
  assertOk(r);

  expect(r.state.notes.find((n) => n.id === 1)!.heading).toBe('h2');
  expect(r.state.notes.find((n) => n.id === 1)!.body, 'body untouched').toBe('one');
});

test('actUpdate: clears heading when passed whitespace', () => {
  const r = actUpdate(seeded(), 1, undefined, '   ');
  assertOk(r);

  expect(r.state.notes.find((n) => n.id === 1)!.heading).toBe(undefined);
});

test('actUpdate: adds heading to a note that had none', () => {
  const r = actUpdate(seeded(), 2, undefined, 'new-head');
  assertOk(r);

  expect(r.state.notes.find((n) => n.id === 2)!.heading).toBe('new-head');
});

test('actUpdate: missing id returns error', () => {
  const r = actUpdate(seeded(), undefined, 'x', undefined);

  expect(r.ok).toBe(false);
});

test('actUpdate: unknown id returns error', () => {
  const r = actUpdate(seeded(), 99, 'x', undefined);
  assertErr(r);

  expect(r.error).toMatch(/#99/);
});

test('actUpdate: both body and heading undefined returns error', () => {
  const r = actUpdate(seeded(), 1, undefined, undefined);
  assertErr(r);

  expect(r.error).toMatch(/body.*heading/i);
});

test('actUpdate: empty body returns error (points at `remove`)', () => {
  const r = actUpdate(seeded(), 1, '   ', undefined);
  assertErr(r);

  expect(r.error).toMatch(/remove/);
});

// ──────────────────────────────────────────────────────────────────────
// actRemove
// ──────────────────────────────────────────────────────────────────────

test('actRemove: removes a note by id', () => {
  const r = actRemove(seeded(), 1);
  assertOk(r);

  expect(r.state.notes.length).toBe(1);
  expect(r.state.notes[0].id).toBe(2);
});

test('actRemove: does NOT reset nextId when removing the last note', () => {
  const s = seeded();
  const r1 = actRemove(s, 1);
  assertOk(r1);
  const r2 = actRemove(r1.state, 2);
  assertOk(r2);

  expect(r2.state.notes).toEqual([]);
  // nextId intentionally does NOT reset - prevents id collisions if
  // the model references an old note number across a later append.
  expect(r2.state.nextId).toBe(3);
});

test('actRemove: missing id returns error', () => {
  const r = actRemove(seeded(), undefined);

  expect(r.ok).toBe(false);
});

test('actRemove: unknown id returns error', () => {
  const r = actRemove(seeded(), 99);
  assertErr(r);

  expect(r.error).toMatch(/#99/);
});

// ──────────────────────────────────────────────────────────────────────
// actClear
// ──────────────────────────────────────────────────────────────────────

test('actClear: empties populated state and resets nextId', () => {
  const r = actClear(seeded());
  assertOk(r);

  expect(r.state.notes).toEqual([]);
  expect(r.state.nextId).toBe(1);
});

test('actClear: returns a friendly message on empty state', () => {
  const r = actClear(emptyState());
  assertOk(r);

  expect(r.summary).toMatch(/empty/i);
});

// ──────────────────────────────────────────────────────────────────────
// actList / formatText
// ──────────────────────────────────────────────────────────────────────

test('actList: returns empty marker for empty state', () => {
  const r = actList(emptyState());
  assertOk(r);

  expect(r.summary).toMatch(/empty/i);
});

test('formatText: renders headings when present', () => {
  const s = mkState([
    { id: 1, body: 'a', heading: 'h' },
    { id: 2, body: 'b' },
  ]);
  const out = formatText(s);

  expect(out).toMatch(/#1 \[h\] a/);
  expect(out).toMatch(/#2 b/);
  expect(out, 'no heading brackets when heading absent').not.toMatch(/\[.*\] b/);
});

// ──────────────────────────────────────────────────────────────────────
// cloneState: defensive deep copy
// ──────────────────────────────────────────────────────────────────────

test('cloneState: new state references do not alias the input', () => {
  const s = mkState([{ id: 1, body: 'a', heading: 'h' }]);
  const c = cloneState(s);
  c.notes[0].body = 'mutated';
  c.notes[0].heading = 'mutated-h';

  expect(s.notes[0].body).toBe('a');
  expect(s.notes[0].heading).toBe('h');

  c.notes.push({ id: 2, body: 'new' });

  expect(s.notes.length).toBe(1);
});
