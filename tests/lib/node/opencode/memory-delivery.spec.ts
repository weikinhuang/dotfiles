/**
 * Tests for lib/node/opencode/memory-delivery.ts (instruction-entry index
 * delivery for the opencode memory plugin).
 */

import { expect, test } from 'vitest';

import {
  createDeliveryStore,
  type DeliveryPlan,
  type MemoryDeliveryState,
  MEMORY_CHANGES_KEY,
  MEMORY_INDEX_KEY,
  noteLocalChange,
  parseDeliveryState,
  planInstructionDelivery,
} from '../../../../lib/node/opencode/memory-delivery.ts';
import { renderFullIndex } from '../../../../lib/node/opencode/memory.ts';
import { emptyIndex, type MemoryEntry, type MemoryIndex } from '../../../../lib/node/pi/memory-reducer.ts';

const NOW = new Date('2026-11-12T00:00:00.000Z');

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  scope: 'global',
  type: 'feedback',
  name: id,
  description: `about ${id}`,
  ...over,
});

const indexOf = (...entries: MemoryEntry[]): MemoryIndex => {
  const index = emptyIndex();
  for (const e of entries) index[e.scope].push(e);
  return index;
};

const plan = (prev: MemoryDeliveryState | null, index: MemoryIndex, opts = {}, maxChars = 6000): DeliveryPlan =>
  planInstructionDelivery(
    prev,
    index,
    () =>
      renderFullIndex(
        { index, projectSlug: '--work--', sessionId: 'ses_1' },
        { maxInjectedChars: maxChars, staleDays: 30 },
        NOW,
      ),
    opts,
  );

test('planInstructionDelivery: first sync puts the full index; an unchanged index puts nothing', () => {
  const index = indexOf(entry('terse'));
  const first = plan(null, index);
  expect(first.kind).toBe('full');
  expect(first.ops).toHaveLength(1);
  expect(first.ops[0]).toMatchObject({ op: 'put', key: MEMORY_INDEX_KEY });
  expect(first.ops[0]?.op === 'put' && first.ops[0].value).toMatch(
    /^## Memory\n\n### Global\n\*\*feedback\*\*\n- `terse` - about terse/,
  );
  const again = plan(first.next, index);
  expect(again).toEqual({ kind: 'none', ops: [], next: first.next });
});

test('planInstructionDelivery: rendering is deterministic for the same index and clock', () => {
  const index = indexOf(entry('a'), entry('b', { scope: 'project', type: 'project' }));
  expect(plan(null, index)).toEqual(plan(null, index));
});

test('planInstructionDelivery: a foreign change puts a cumulative delta against the baseline', () => {
  const first = plan(null, indexOf(entry('a')));
  const second = plan(first.next, indexOf(entry('a'), entry('b')));
  expect(second.kind).toBe('delta');
  expect(second.ops).toEqual([
    {
      op: 'put',
      key: MEMORY_CHANGES_KEY,
      value: '## Memory changes\n\nSince the last memory index:\n+ [global/feedback] `b` - about b',
    },
  ]);
  const third = plan(second.next, indexOf(entry('b')));
  expect(third.ops[0]).toMatchObject({ op: 'put', key: MEMORY_CHANGES_KEY });
  expect(third.ops[0]?.op === 'put' && third.ops[0].value).toContain('- [global/feedback] `a` (removed)');
  expect(third.ops[0]?.op === 'put' && third.ops[0].value).toContain('+ [global/feedback] `b`');
});

test('planInstructionDelivery: returning to the baseline removes the delta entry', () => {
  const first = plan(null, indexOf(entry('a')));
  const second = plan(first.next, indexOf(entry('a'), entry('b')));
  const back = plan(second.next, indexOf(entry('a')));
  expect(back.ops).toEqual([{ op: 'remove', key: MEMORY_CHANGES_KEY }]);
  expect(back.next.changes).toBe(false);
});

test('planInstructionDelivery: the model own write is not re-announced', () => {
  const first = plan(null, indexOf(entry('a')));
  const b = entry('b');
  const noted = noteLocalChange(first.next, { kind: 'upsert', entry: b });
  expect(plan(noted, indexOf(entry('a'), b)).kind).toBe('none');
  const removed = noteLocalChange(noted, { kind: 'remove', entry: b });
  expect(plan(removed, indexOf(entry('a'))).kind).toBe('none');
  expect(noteLocalChange(null, { kind: 'upsert', entry: b })).toBeNull();
});

test('planInstructionDelivery: refresh, large diffs, and capped baselines resend the full index', () => {
  const first = plan(null, indexOf(entry('a')));
  const withDelta = plan(first.next, indexOf(entry('a'), entry('b')));
  const refreshed = plan(withDelta.next, indexOf(entry('a'), entry('b')), { refresh: true });
  expect(refreshed.kind).toBe('full');
  expect(refreshed.ops.map((o) => `${o.op}:${o.key}`)).toEqual([
    `put:${MEMORY_INDEX_KEY}`,
    `remove:${MEMORY_CHANGES_KEY}`,
  ]);

  const many = Array.from({ length: 13 }, (_, i) => entry(`m${i}`));
  expect(plan(first.next, indexOf(entry('a'), ...many)).kind).toBe('full');

  const long = Array.from({ length: 40 }, (_, i) => entry(`long-${i}`, { description: 'x'.repeat(80) }));
  const capped = plan(null, indexOf(...long), {}, 500);
  expect(capped.next.base.truncated).toBe(true);
  expect(plan(capped.next, indexOf(...long, entry('z')), {}, 500).kind).toBe('full');
});

test('planInstructionDelivery: an emptied index removes both entries', () => {
  const first = plan(null, indexOf(entry('a')));
  const cleared = plan({ ...first.next, changes: true }, emptyIndex(), { refresh: true });
  expect(cleared.kind).toBe('clear');
  expect(cleared.ops).toEqual([
    { op: 'remove', key: MEMORY_INDEX_KEY },
    { op: 'remove', key: MEMORY_CHANGES_KEY },
  ]);
  expect(plan(null, emptyIndex()).kind).toBe('none');
});

test('parseDeliveryState: round-trips a valid state and rejects malformed values', () => {
  const state = plan(null, indexOf(entry('a'))).next;
  expect(parseDeliveryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  expect(parseDeliveryState(undefined)).toBeNull();
  expect(
    parseDeliveryState({ base: { fingerprint: {}, truncated: 'no' }, seen: {}, indexed: true, changes: false }),
  ).toBeNull();
});

test('createDeliveryStore: serializes updates per session and persists the result', async () => {
  const data = new Map<string, unknown>();
  const store = createDeliveryStore({
    get: async (key) => Promise.resolve(data.get(key)),
    set: async (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    remove: async (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  });
  const state = plan(null, indexOf(entry('a'))).next;
  const seen: (MemoryDeliveryState | null)[] = [];
  await Promise.all([
    store.update('s', async (prev) => {
      seen.push(prev);
      return Promise.resolve(state);
    }),
    store.update('s', async (prev) => {
      seen.push(prev);
      return Promise.resolve(undefined);
    }),
  ]);
  expect(seen).toEqual([null, state]);
  expect(await store.get('s')).toEqual(state);
  await store.forget('s');
  expect(await store.get('s')).toBeNull();
});
