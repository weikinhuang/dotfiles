/**
 * Tests for config/pi/extensions/lib/scratchpad-prompt.ts.
 *
 * Run:  node --test config/pi/tests/extensions/scratchpad-prompt.test.ts
 *   or: node --test config/pi/tests/
 *
 * Pure module — no pi runtime needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWorkingNotes } from '../../extensions/lib/scratchpad-prompt.ts';
import { type ScratchpadState } from '../../extensions/lib/scratchpad-reducer.ts';

const state = (notes: ScratchpadState['notes'], nextId?: number): ScratchpadState => ({
  notes,
  nextId: nextId ?? notes.reduce((m, n) => Math.max(m, n.id), 0) + 1,
});

test('formatWorkingNotes: returns null for empty state', () => {
  assert.equal(formatWorkingNotes(state([])), null);
});

test('formatWorkingNotes: renders a simple ungrouped note list', () => {
  const out = formatWorkingNotes(
    state([
      { id: 1, body: 'alpha' },
      { id: 2, body: 'beta' },
    ]),
  )!;
  assert.match(out, /## Working Notes/);
  assert.match(out, /\*\*Notes\*\*/);
  assert.match(out, /#1 alpha/);
  assert.match(out, /#2 beta/);
  assert.match(out, /scratchpad/);
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
  assert.ok(idx('**decisions**') >= 0);
  assert.ok(idx('**paths**') >= 0);
  assert.ok(idx('**Notes**') >= 0);
  // decisions header appears before paths header (first-seen order).
  assert.ok(idx('**decisions**') < idx('**paths**'));
  // Grouped notes appear under the right header.
  const decisionsBlock = out.slice(idx('**decisions**'), idx('**paths**'));
  assert.match(decisionsBlock, /#1 a/);
  assert.match(decisionsBlock, /#3 c/);
  assert.ok(!decisionsBlock.includes('#2 b'));
});

test('formatWorkingNotes: soft cap truncates and emits trailer', () => {
  // 40 notes, each ~100 chars of body, way over the default cap of 2000.
  const notes = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    body: `note body ${i + 1} ` + 'x'.repeat(100),
  }));
  const out = formatWorkingNotes(state(notes))!;
  // Truncation trailer must mention skipped count and the tool hint.
  assert.match(out, /more note\(s\) not shown/i);
  assert.match(out, /scratchpad.*list/);
  // Output is soft-capped — allow some overshoot, but it must not
  // contain every note.
  assert.ok(out.length < 3000, `output too large: ${out.length}`);
  assert.ok(!out.includes('#40 '), 'last note should be skipped');
});

test('formatWorkingNotes: always renders at least one note even under a tiny cap', () => {
  const out = formatWorkingNotes(
    state([
      { id: 1, body: 'first' },
      { id: 2, body: 'second' },
    ]),
    { maxChars: 200 },
  )!;
  assert.match(out, /#1 first/);
});

test('formatWorkingNotes: enforces a 200-char floor on the cap', () => {
  // Passing an absurdly small cap should not produce an empty block.
  const out = formatWorkingNotes(state([{ id: 1, body: 'only note' }]), { maxChars: 10 })!;
  assert.match(out, /#1 only note/);
});

test('formatWorkingNotes: does NOT emit the "keep notes accurate" trailer when truncated', () => {
  const notes = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    body: `filler ${i + 1} ` + 'x'.repeat(100),
  }));
  const out = formatWorkingNotes(state(notes))!;
  assert.match(out, /more note\(s\) not shown/i);
  assert.ok(!/Keep these notes accurate/.test(out));
});

test('formatWorkingNotes: emits the guidance trailer when nothing is truncated', () => {
  const out = formatWorkingNotes(state([{ id: 1, body: 'x' }]))!;
  assert.match(out, /Keep these notes accurate/);
});
