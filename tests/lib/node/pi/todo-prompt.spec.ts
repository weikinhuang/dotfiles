/**
 * Tests for lib/node/pi/todo-prompt.ts.
 */

import { expect, test } from 'vitest';

import { formatActivePlan, looksLikeCompletionClaim } from '../../../../lib/node/pi/todo-prompt.ts';
import { type Todo, type TodoState } from '../../../../lib/node/pi/todo-reducer.ts';

const mkState = (todos: Todo[]): TodoState => ({
  todos: todos.map((t) => ({ ...t })),
  nextId: todos.reduce((m, t) => Math.max(m, t.id), 0) + 1,
});

// ──────────────────────────────────────────────────────────────────────
// formatActivePlan
// ──────────────────────────────────────────────────────────────────────

test('formatActivePlan: returns null for empty state', () => {
  expect(formatActivePlan(mkState([]))).toBe(null);
});

test('formatActivePlan: returns null when everything is completed', () => {
  expect(
    formatActivePlan(
      mkState([
        { id: 1, text: 'a', status: 'completed' },
        { id: 2, text: 'b', status: 'completed' },
      ]),
    ),
  ).toBe(null);
});

test('formatActivePlan: renders in_progress items first', () => {
  const out = formatActivePlan(
    mkState([
      { id: 1, text: 'queued', status: 'pending' },
      { id: 2, text: 'doing it', status: 'in_progress' },
    ]),
  )!;
  const idx1 = out.indexOf('In progress:');
  const idx2 = out.indexOf('Pending:');

  expect(idx1).toBeGreaterThanOrEqual(0);
  expect(idx2, 'In progress must come before Pending').toBeGreaterThan(idx1);
  expect(out).toMatch(/→ #2 doing it/);
  expect(out).toMatch(/• #1 queued/);
});

test('formatActivePlan: renders blocked items with note in parentheses', () => {
  const out = formatActivePlan(mkState([{ id: 4, text: 'deploy', status: 'blocked', note: 'awaiting approval' }]))!;

  expect(out).toMatch(/Blocked/);
  expect(out).toMatch(/⛔ #4 deploy {2}\(awaiting approval\)/);
});

test('formatActivePlan: omits pending section when none pending', () => {
  const out = formatActivePlan(mkState([{ id: 1, text: 'x', status: 'in_progress' }]))!;

  expect(out).not.toMatch(/Pending:/);
});

test('formatActivePlan: caps pending list and shows "… and N more"', () => {
  const todos: Todo[] = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    text: `task ${i + 1}`,
    status: 'pending' as const,
  }));
  const out = formatActivePlan(mkState(todos), { maxItems: 5 })!;
  // 5 bulleted pending lines
  const bulletCount = (out.match(/^\s+• /gm) ?? []).length;

  expect(bulletCount).toBe(5);
  expect(out).toMatch(/… and 20 more/);
});

test('formatActivePlan: maxItems default is 10', () => {
  const todos: Todo[] = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1,
    text: `t${i + 1}`,
    status: 'pending' as const,
  }));
  const out = formatActivePlan(mkState(todos))!;
  const bulletCount = (out.match(/^\s+• /gm) ?? []).length;

  expect(bulletCount).toBe(10);
  expect(out).toMatch(/… and 5 more/);
});

test('formatActivePlan: maxItems floored to 1', () => {
  const todos: Todo[] = [
    { id: 1, text: 'a', status: 'pending' },
    { id: 2, text: 'b', status: 'pending' },
  ];
  const out = formatActivePlan(mkState(todos), { maxItems: 0 })!;
  const bulletCount = (out.match(/^\s+• /gm) ?? []).length;

  expect(bulletCount).toBe(1);
});

test('formatActivePlan: includes guidance footer reminding the model of the workflow', () => {
  const out = formatActivePlan(mkState([{ id: 1, text: 'x', status: 'in_progress' }]))!;

  expect(out).toMatch(/one item `in_progress` at a time/i);
  expect(out).toMatch(/move it to `review`/);
  expect(out).toMatch(/Mark `complete` after verification/);
  expect(out).toMatch(/`block` with a `note`/);
});

test('formatActivePlan: renders In review section with ⋯ marker', () => {
  const out = formatActivePlan(
    mkState([
      { id: 1, text: 'x', status: 'pending' },
      { id: 2, text: 'awaiting tests', status: 'review', note: 'ran npm test - waiting for ci' },
    ]),
  )!;

  expect(out).toMatch(/In review/);
  expect(out).toMatch(/⋯ #2 awaiting tests {2}\(ran npm test - waiting for ci\)/);
});

test('formatActivePlan: returns non-null when only review items exist', () => {
  const out = formatActivePlan(mkState([{ id: 1, text: 'x', status: 'review' }]));

  expect(out).not.toBe(null);
  expect(out!).toMatch(/In review/);
});

test('formatActivePlan: section order is in_progress → review → pending → blocked', () => {
  const out = formatActivePlan(
    mkState([
      { id: 1, text: 'p', status: 'pending' },
      { id: 2, text: 'r', status: 'review' },
      { id: 3, text: 'a', status: 'in_progress' },
      { id: 4, text: 'b', status: 'blocked', note: 'why' },
    ]),
  )!;
  const idxActive = out.indexOf('In progress:');
  const idxReview = out.indexOf('In review');
  const idxPending = out.indexOf('Pending:');
  const idxBlocked = out.indexOf('Blocked');

  expect(idxActive).toBeGreaterThanOrEqual(0);
  expect(idxReview, 'review must follow in_progress').toBeGreaterThan(idxActive);
  expect(idxPending, 'pending must follow review').toBeGreaterThan(idxReview);
  expect(idxBlocked, 'blocked must follow pending').toBeGreaterThan(idxPending);
});

test('formatActivePlan: keeps completed items out of the rendered sections', () => {
  const out = formatActivePlan(
    mkState([
      { id: 1, text: 'done-item', status: 'completed' },
      { id: 2, text: 'pending-item', status: 'pending' },
    ]),
  )!;

  expect(out).not.toMatch(/done-item/);
  expect(out).toMatch(/pending-item/);
});

// ──────────────────────────────────────────────────────────────────────
// looksLikeCompletionClaim: positive cases
// ──────────────────────────────────────────────────────────────────────

for (const text of [
  'All done.',
  'All set!',
  'All finished.',
  "I'm all done here.",
  'The task is complete.',
  'Everything is done.',
  'Work complete.',
  'Done.',
  'Done!',
  'Finished.',
  'Completed.',
  'Ready to go.',
  'Ready to ship.',
  'Ready to merge.',
  'Ready to commit.',
  'Good to go.',
  'Shipped it.',
  'Ship it!',
  'This is complete.',
  'It is done.',
  'Done and dusted.',
  // Trailing markdown formatting / quotes
  '...and that wraps it up. **Done.**',
  '...which means: "all set"',
  'That should do it. Ready to merge!',
  // Multi-paragraph reply ending in sign-off
  'I refactored the loop and inlined the helper.\n\nAll done.',
]) {
  test(`looksLikeCompletionClaim: matches ${JSON.stringify(text)}`, () => {
    expect(looksLikeCompletionClaim(text)).toBe(true);
  });
}

// ──────────────────────────────────────────────────────────────────────
// looksLikeCompletionClaim: negative cases
// ──────────────────────────────────────────────────────────────────────

for (const text of [
  '',
  '   ',
  // Questions
  'Are you done with this?',
  'Is the task complete?',
  'Should I mark it done?',
  // Future / conditional
  "I'll let you know when I'm done.",
  "Once the tests are done I'll update the docs.",
  'After the build finishes we can proceed.',
  'If the migration is complete, move on.',
  // In-progress / next-step narration
  "I'm working on the refactor now.",
  'Let me start by reading the file.',
  "Next, I'll run the tests.",
  // Past-tense mid-message without closing sign-off
  "I finished the first pass earlier, but I'm still investigating the flaky test. Let me keep digging.",
]) {
  test(`looksLikeCompletionClaim: rejects ${JSON.stringify(text)}`, () => {
    expect(looksLikeCompletionClaim(text)).toBe(false);
  });
}

test('looksLikeCompletionClaim: only inspects the tail of long messages', () => {
  // An early false-positive phrase buried 500 chars up should NOT trigger.
  const filler = 'x'.repeat(600);
  const text = `All done.\n\n${filler}\n\nStill investigating.`;

  expect(looksLikeCompletionClaim(text)).toBe(false);
});
