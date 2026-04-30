/**
 * Tests for lib/node/pi/scratchpad-prompt.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';
import { formatWorkingNotes } from '../../../../lib/node/pi/scratchpad-prompt.ts';
import { type ScratchpadState } from '../../../../lib/node/pi/scratchpad-reducer.ts';

const state = (notes: ScratchpadState['notes'], nextId?: number): ScratchpadState => ({
  notes,
  nextId: nextId ?? notes.reduce((m, n) => Math.max(m, n.id), 0) + 1,
});

test('formatWorkingNotes: returns null for empty state', () => {
  expect(formatWorkingNotes(state([]))).toBe(null);
});

test('formatWorkingNotes: renders a simple ungrouped note list', () => {
  const out = formatWorkingNotes(
    state([
      { id: 1, body: 'alpha' },
      { id: 2, body: 'beta' },
    ]),
  )!;

  expect(out).toMatch(/## Working Notes/);
  expect(out).toMatch(/\*\*Notes\*\*/);
  expect(out).toMatch(/#1 alpha/);
  expect(out).toMatch(/#2 beta/);
  expect(out).toMatch(/scratchpad/);
});

test('formatWorkingNotes: groups notes by heading in first-seen order', () => {
  const out = formatWorkingNotes(
    state([
      { id: 1, body: 'a', heading: 'decisions' },
      { id: 2, body: 'b', heading: 'paths' },
      { id: 3, body: 'c', heading: 'decisions' },
      { id: 4, body: 'd' },
    ]),
  )!;
  const idx = (needle: string): number => out.indexOf(needle);

  expect(idx('**decisions**')).toBeGreaterThanOrEqual(0);
  expect(idx('**paths**')).toBeGreaterThanOrEqual(0);
  expect(idx('**Notes**')).toBeGreaterThanOrEqual(0);
  // decisions header appears before paths header (first-seen order).
  expect(idx('**decisions**')).toBeLessThan(idx('**paths**'));

  // Grouped notes appear under the right header.
  const decisionsBlock = out.slice(idx('**decisions**'), idx('**paths**'));

  expect(decisionsBlock).toMatch(/#1 a/);
  expect(decisionsBlock).toMatch(/#3 c/);
  expect(decisionsBlock.includes('#2 b')).toBe(false);
});

test('formatWorkingNotes: soft cap truncates and emits trailer', () => {
  // 40 notes, each ~100 chars of body, way over the default cap of 2000.
  const notes = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    body: `note body ${i + 1} ` + 'x'.repeat(100),
  }));
  const out = formatWorkingNotes(state(notes))!;

  // Truncation trailer must mention skipped count and the tool hint.
  expect(out).toMatch(/more note\(s\) not shown/i);
  expect(out).toMatch(/scratchpad.*list/);
  // Output is soft-capped — allow some overshoot, but it must not
  // contain every note.
  expect(out.length).toBeLessThan(3000);
  expect(out.includes('#40 ')).toBe(false);
});

test('formatWorkingNotes: always renders at least one note even under a tiny cap', () => {
  const out = formatWorkingNotes(
    state([
      { id: 1, body: 'first' },
      { id: 2, body: 'second' },
    ]),
    { maxChars: 200 },
  )!;

  expect(out).toMatch(/#1 first/);
});

test('formatWorkingNotes: enforces a 200-char floor on the cap', () => {
  // Passing an absurdly small cap should not produce an empty block.
  const out = formatWorkingNotes(state([{ id: 1, body: 'only note' }]), { maxChars: 10 })!;

  expect(out).toMatch(/#1 only note/);
});

test('formatWorkingNotes: does NOT emit the "keep notes accurate" trailer when truncated', () => {
  const notes = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    body: `filler ${i + 1} ` + 'x'.repeat(100),
  }));
  const out = formatWorkingNotes(state(notes))!;

  expect(out).toMatch(/more note\(s\) not shown/i);
  expect(out).not.toMatch(/Keep these notes accurate/);
});

test('formatWorkingNotes: emits the guidance trailer when nothing is truncated', () => {
  const out = formatWorkingNotes(state([{ id: 1, body: 'x' }]))!;

  expect(out).toMatch(/Keep these notes accurate/);
});
