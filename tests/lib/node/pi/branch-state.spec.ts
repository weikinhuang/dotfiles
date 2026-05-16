/**
 * Tests for lib/node/pi/branch-state.ts.
 *
 * Pure module - no pi runtime needed. The helper exercised here is what
 * backs both `todo-reducer.reduceBranch` and
 * `scratchpad-reducer.reduceBranch`; this spec pins the generic
 * extraction behaviour independently of either caller.
 */

import { expect, test } from 'vitest';

import {
  type BranchEntry,
  findLatestStateInBranch,
  stateFromEntryGeneric,
} from '../../../../lib/node/pi/branch-state.ts';

interface Foo {
  value: number;
}

const isFoo = (v: unknown): v is Foo =>
  typeof v === 'object' && v !== null && typeof (v as { value?: unknown }).value === 'number';

const cloneFoo = (f: Foo): Foo => ({ value: f.value });

const TOOL = 'foo-tool';
const CUSTOM = 'foo-state';

// ──────────────────────────────────────────────────────────────────────
// stateFromEntryGeneric
// ──────────────────────────────────────────────────────────────────────

test('stateFromEntryGeneric: extracts state from a matching custom entry', () => {
  const entry: BranchEntry = { type: 'custom', customType: CUSTOM, data: { value: 7 } };

  expect(stateFromEntryGeneric(entry, TOOL, CUSTOM, isFoo, cloneFoo)).toEqual({ value: 7 });
});

test('stateFromEntryGeneric: extracts state from a matching toolResult entry', () => {
  const entry: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: TOOL, details: { value: 3 } },
  };

  expect(stateFromEntryGeneric(entry, TOOL, CUSTOM, isFoo, cloneFoo)).toEqual({ value: 3 });
});

test('stateFromEntryGeneric: returns a defensive copy via the clone fn', () => {
  const data = { value: 1 };
  const entry: BranchEntry = { type: 'custom', customType: CUSTOM, data };
  const got = stateFromEntryGeneric(entry, TOOL, CUSTOM, isFoo, cloneFoo);

  expect(got).not.toBe(data);
  expect(got).toEqual(data);
});

test('stateFromEntryGeneric: rejects mismatched customType', () => {
  const entry: BranchEntry = { type: 'custom', customType: 'other-state', data: { value: 1 } };

  expect(stateFromEntryGeneric(entry, TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
});

test('stateFromEntryGeneric: rejects mismatched toolName', () => {
  const entry: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: 'other', details: { value: 1 } },
  };

  expect(stateFromEntryGeneric(entry, TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
});

test('stateFromEntryGeneric: rejects non-toolResult message entries', () => {
  const entry: BranchEntry = {
    type: 'message',
    message: { role: 'assistant', toolName: TOOL, details: { value: 1 } },
  };

  expect(stateFromEntryGeneric(entry, TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
});

test('stateFromEntryGeneric: rejects payloads failing isShape', () => {
  const bad1: BranchEntry = { type: 'custom', customType: CUSTOM, data: { value: 'nope' } };
  const bad2: BranchEntry = {
    type: 'message',
    message: { role: 'toolResult', toolName: TOOL, details: null },
  };

  expect(stateFromEntryGeneric(bad1, TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
  expect(stateFromEntryGeneric(bad2, TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
});

test('stateFromEntryGeneric: returns null for unrelated entries', () => {
  expect(stateFromEntryGeneric({}, TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
  expect(
    stateFromEntryGeneric({ type: 'message', message: { role: 'user' } }, TOOL, CUSTOM, isFoo, cloneFoo),
  ).toBeNull();
});

// ──────────────────────────────────────────────────────────────────────
// findLatestStateInBranch
// ──────────────────────────────────────────────────────────────────────

test('findLatestStateInBranch: returns null on empty branch', () => {
  expect(findLatestStateInBranch([], TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
});

test('findLatestStateInBranch: returns the last valid snapshot', () => {
  const branch: BranchEntry[] = [
    { type: 'custom', customType: CUSTOM, data: { value: 1 } },
    { type: 'message', message: { role: 'user' } },
    { type: 'custom', customType: CUSTOM, data: { value: 2 } },
    { type: 'message', message: { role: 'assistant' } },
  ];

  expect(findLatestStateInBranch(branch, TOOL, CUSTOM, isFoo, cloneFoo)).toEqual({ value: 2 });
});

test('findLatestStateInBranch: skips malformed entries and uses the newest valid one', () => {
  const branch: BranchEntry[] = [
    { type: 'custom', customType: CUSTOM, data: { value: 5 } },
    { type: 'custom', customType: CUSTOM, data: { value: 'nope' } },
  ];

  expect(findLatestStateInBranch(branch, TOOL, CUSTOM, isFoo, cloneFoo)).toEqual({ value: 5 });
});

test('findLatestStateInBranch: returns null when no entry matches', () => {
  const branch: BranchEntry[] = [
    { type: 'message', message: { role: 'user' } },
    { type: 'custom', customType: 'other', data: { value: 1 } },
  ];

  expect(findLatestStateInBranch(branch, TOOL, CUSTOM, isFoo, cloneFoo)).toBeNull();
});

test('findLatestStateInBranch: toolResult and custom entries are equivalent sources', () => {
  const branch: BranchEntry[] = [
    { type: 'message', message: { role: 'toolResult', toolName: TOOL, details: { value: 42 } } },
  ];

  expect(findLatestStateInBranch(branch, TOOL, CUSTOM, isFoo, cloneFoo)).toEqual({ value: 42 });
});
