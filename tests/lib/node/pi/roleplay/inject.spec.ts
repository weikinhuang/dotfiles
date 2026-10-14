/**
 * Tests for lib/node/pi/roleplay/inject.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  applyInsertions,
  buildInsertions,
  DEFAULT_AUTHOR_NOTE_DEPTH,
  formatAuthorNote,
  formatDepthLore,
  isNarrativeRoleplayStart,
  planDepthTailMerge,
  resolveDepthInsertions,
} from '../../../../../lib/node/pi/roleplay/inject.ts';
import { applyContextReminder, type ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';
import { createReminderLifecycle, reminderMessageAnchor } from '../../../../../lib/node/pi/reminder-lifecycle.ts';

// ── Formatters ────────────────────────────────────────────────────────────

test('formatters frame author note + lore', () => {
  expect(formatAuthorNote('  stay terse ')).toBe("[Author's note: stay terse]");
  expect(formatDepthLore('Rhodes', '  the org ')).toBe('[Lore — Rhodes: the org]');
});

test('only user and scheduled-prompt starts advance narrative state', () => {
  expect(isNarrativeRoleplayStart({ messageType: 'user' })).toBe(true);
  expect(isNarrativeRoleplayStart({ messageType: 'custom', message: { customType: 'scheduled-prompt' } })).toBe(true);
  for (const customType of ['bg-bash-completion', 'verify-before-claim-steer', 'stall-recovery-steer']) {
    expect(isNarrativeRoleplayStart({ messageType: 'custom', message: { customType } })).toBe(false);
  }
});

test('depth resolves against clean message anchors and persists without following the tool tail', () => {
  const history: ReminderMessage[] = [
    { role: 'user', content: 'old scene', timestamp: 1 },
    { role: 'assistant', content: 'old reply', timestamp: 2 },
    { role: 'user', content: 'new scene', timestamp: 3 },
  ];
  const withProducer = applyContextReminder(history, { id: 'todo-plan', body: 'a plan' });
  const placements = resolveDepthInsertions(withProducer, [
    { depth: 0, text: 'tail lore' },
    { depth: 1, text: 'before input' },
    { depth: 2, text: 'before reply' },
    { depth: 99, text: 'before history' },
  ]);
  expect(placements).toEqual([
    { anchor: reminderMessageAnchor(history[2]), before: false, text: 'tail lore' },
    { anchor: reminderMessageAnchor(history[2]), before: true, text: 'before input' },
    { anchor: reminderMessageAnchor(history[1]), before: true, text: 'before reply' },
    { anchor: reminderMessageAnchor(history[0]), before: true, text: 'before history' },
  ]);
  const lifecycle = createReminderLifecycle();
  lifecycle.stagePlacements(placements);
  const first = lifecycle.project(history).messages;
  const tools: ReminderMessage[] = [
    { role: 'assistant', content: 'tool call', timestamp: 4 },
    { role: 'toolResult', content: 'tool result', timestamp: 5 },
  ];
  expect(lifecycle.project([...history, ...tools]).messages).toEqual([...first, ...tools]);
  expect(resolveDepthInsertions([], [{ depth: 0, text: 'unused' }])).toEqual([]);
});

test('placement anchors survive reasoning overlays after producer resolution', () => {
  const assistant: ReminderMessage = {
    role: 'assistant',
    timestamp: 1,
    content: [
      { type: 'thinking', thinking: 'fixture rationale' },
      { type: 'text', text: 'spoken reply' },
    ],
  };
  const stripped: ReminderMessage = { ...assistant, content: [{ type: 'text', text: 'spoken reply' }] };
  expect(reminderMessageAnchor(assistant)).toBe(reminderMessageAnchor(stripped));
});

test('depth cannot insert a user instruction inside a tool-result batch', () => {
  const history: ReminderMessage[] = [
    { role: 'user', content: 'old scene', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'a' }], timestamp: 2 },
    { role: 'toolResult', content: 'a result', timestamp: 3 },
    { role: 'toolResult', content: 'another result', timestamp: 4 },
    { role: 'user', content: 'new scene', timestamp: 5 },
  ];
  expect(resolveDepthInsertions(history, [{ depth: 2, text: 'note' }])).toEqual([
    { anchor: reminderMessageAnchor(history[1]), before: true, text: 'note' },
  ]);
});

// ── buildInsertions ───────────────────────────────────────────────────────

test('buildInsertions returns nothing when empty', () => {
  expect(buildInsertions({})).toStrictEqual([]);
  expect(buildInsertions({ authorNote: '   ', lore: [] })).toStrictEqual([]);
});

test('buildInsertions emits lore then author note with default depth', () => {
  const ins = buildInsertions({ authorNote: 'be cool', lore: [{ name: 'RI', body: 'org', depth: 2 }] });
  expect(ins).toStrictEqual([
    { depth: 2, text: '[Lore — RI: org]' },
    { depth: DEFAULT_AUTHOR_NOTE_DEPTH, text: "[Author's note: be cool]" },
  ]);
});

test('buildInsertions honors an explicit author-note depth and skips empty lore bodies', () => {
  const ins = buildInsertions({
    authorNote: 'x',
    authorNoteDepth: 1,
    lore: [{ name: 'A', body: '   ', depth: 3 }],
  });
  expect(ins).toStrictEqual([{ depth: 1, text: "[Author's note: x]" }]);
});

// ── applyInsertions ───────────────────────────────────────────────────────

const msgs = ['m0', 'm1', 'm2', 'm3'];
const wrap = (text: string): string => `<${text}>`;

test('depth 0 appends at the very end', () => {
  expect(applyInsertions(msgs, [{ depth: 0, text: 'X' }], wrap)).toStrictEqual(['m0', 'm1', 'm2', 'm3', '<X>']);
});

test('depth 1 inserts before the last message', () => {
  expect(applyInsertions(msgs, [{ depth: 1, text: 'X' }], wrap)).toStrictEqual(['m0', 'm1', 'm2', '<X>', 'm3']);
});

test('depth clamps to the start when larger than the history', () => {
  expect(applyInsertions(msgs, [{ depth: 99, text: 'X' }], wrap)).toStrictEqual(['<X>', 'm0', 'm1', 'm2', 'm3']);
});

test('does not mutate the input array', () => {
  const original = [...msgs];
  applyInsertions(msgs, [{ depth: 2, text: 'X' }], wrap);
  expect(msgs).toStrictEqual(original);
});

test('empty insertions returns a copy unchanged', () => {
  const out = applyInsertions(msgs, [], wrap);
  expect(out).toStrictEqual(msgs);
  expect(out).not.toBe(msgs);
});

test('multiple insertions land at their respective depths in input order', () => {
  const out = applyInsertions(
    msgs,
    [
      { depth: 2, text: 'A' },
      { depth: 0, text: 'B' },
      { depth: 2, text: 'C' },
    ],
    wrap,
  );
  // depth 2 -> index 2 (before m2), depth 0 -> end. Same-index keeps order A then C.
  expect(out).toStrictEqual(['m0', 'm1', '<A>', '<C>', 'm2', 'm3', '<B>']);
});

test('applies into an empty history at depth 0', () => {
  expect(applyInsertions([], [{ depth: 0, text: 'X' }], wrap)).toStrictEqual(['<X>']);
});

// ── planDepthTailMerge (opt-in merged depth-0 delivery) ───────────────────

test('planDepthTailMerge on an empty list plans nothing', () => {
  expect(planDepthTailMerge([])).toStrictEqual({ insertions: [], tailBlock: null });
});

test('planDepthTailMerge merges only depth-0 entries, blank-line joined, order preserved', () => {
  const plan = planDepthTailMerge([
    { depth: 0, text: '[Lore — A: a]' },
    { depth: 0, text: '[Lore — B: b]' },
  ]);
  expect(plan).toStrictEqual({ insertions: [], tailBlock: '[Lore — A: a]\n\n[Lore — B: b]' });
});

test('planDepthTailMerge leaves a depth-N-only list on the standalone path', () => {
  const ins = [
    { depth: 4, text: '[Lore — A: a]' },
    { depth: 1, text: '[Lore — B: b]' },
  ];
  const plan = planDepthTailMerge(ins);
  expect(plan.tailBlock).toBeNull();
  expect(plan.insertions).toStrictEqual(ins);
});

test('planDepthTailMerge splits a mixed list, keeping depth-N order', () => {
  const plan = planDepthTailMerge([
    { depth: 0, text: 'T0' },
    { depth: 2, text: 'N2' },
    { depth: 0, text: 'T1' },
    { depth: 5, text: 'N5' },
  ]);
  expect(plan.insertions).toStrictEqual([
    { depth: 2, text: 'N2' },
    { depth: 5, text: 'N5' },
  ]);
  expect(plan.tailBlock).toBe('T0\n\nT1');
});

test('planDepthTailMerge treats depths that normalize to 0 as tail entries', () => {
  // `applyInsertions` clamps negative / fractional depths the same way, so
  // the partition must agree with it or a chunk could change position.
  const plan = planDepthTailMerge([
    { depth: -3, text: 'A' },
    { depth: 0.5, text: 'B' },
  ]);
  expect(plan).toStrictEqual({ insertions: [], tailBlock: 'A\n\nB' });
});

test('planDepthTailMerge puts a depth-0 author note after the lore, matching buildInsertions order', () => {
  const plan = planDepthTailMerge(
    buildInsertions({
      authorNote: 'be cool',
      authorNoteDepth: 0,
      lore: [
        { name: 'A', body: 'a', depth: 0 },
        { name: 'B', body: 'b', depth: 0 },
      ],
    }),
  );
  expect(plan.insertions).toStrictEqual([]);
  expect(plan.tailBlock).toBe("[Lore — A: a]\n\n[Lore — B: b]\n\n[Author's note: be cool]");
});

test('planDepthTailMerge leaves a default-depth author note on the standalone path', () => {
  const plan = planDepthTailMerge(
    buildInsertions({ authorNote: 'be cool', lore: [{ name: 'A', body: 'a', depth: 0 }] }),
  );
  expect(plan.insertions).toStrictEqual([{ depth: DEFAULT_AUTHOR_NOTE_DEPTH, text: "[Author's note: be cool]" }]);
  expect(plan.tailBlock).toBe('[Lore — A: a]');
});

test('planDepthTailMerge is a pure repartition: no text added, dropped, or rewritten', () => {
  const ins = buildInsertions({
    authorNote: 'note',
    authorNoteDepth: 0,
    lore: [
      { name: 'A', body: 'a', depth: 0 },
      { name: 'B', body: 'b', depth: 3 },
    ],
  });
  const plan = planDepthTailMerge(ins);
  const rejoined = [...(plan.tailBlock ? plan.tailBlock.split('\n\n') : []), ...plan.insertions.map((i) => i.text)];
  expect(new Set(rejoined)).toStrictEqual(new Set(ins.map((i) => i.text)));
  expect(rejoined).toHaveLength(ins.length);
});

test('planDepthTailMerge does not mutate its input', () => {
  const ins = [
    { depth: 0, text: 'A' },
    { depth: 2, text: 'B' },
  ];
  const snapshot = structuredClone(ins);
  planDepthTailMerge(ins);
  expect(ins).toStrictEqual(snapshot);
});
