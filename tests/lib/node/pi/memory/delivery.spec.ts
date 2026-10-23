/**
 * Tests for lib/node/pi/memory/delivery.ts.
 *
 * Pure module - asserts the full-once / delta-after delivery plan and the
 * branch reconstruction of the delivered baseline.
 */

import { expect, test } from 'vitest';

import {
  containsFullIndex,
  deliveryFromBranch,
  deliveryRecord,
  diffIndex,
  fingerprintIndex,
  formatMemoryDelta,
  MEMORY_DELIVERY_TYPE,
  type MemoryBaseline,
  planMemoryReminder,
  type RenderedFullIndex,
  withEntry,
  withoutEntry,
} from '../../../../../lib/node/pi/memory/delivery.ts';
import { emptyIndex, type MemoryEntry, type MemoryIndex } from '../../../../../lib/node/pi/memory-reducer.ts';

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'foo',
  scope: 'project',
  type: 'feedback',
  name: 'Foo',
  description: 'foo desc',
  ...over,
});

const indexOf = (...entries: MemoryEntry[]): MemoryIndex => {
  const idx = emptyIndex();
  for (const e of entries) idx[e.scope].push(e);
  return idx;
};

const baselineOf = (idx: MemoryIndex, truncated = false): MemoryBaseline => ({
  fingerprint: fingerprintIndex(idx),
  truncated,
});

const FULL = (): RenderedFullIndex => ({ body: '## Memory\n\nfull', truncated: false });
const NONE = (): RenderedFullIndex | null => null;

test('no baseline emits the full index', () => {
  const idx = indexOf(entry());
  const plan = planMemoryReminder(null, idx, FULL);
  expect(plan?.kind).toBe('full');
  expect(plan?.body).toBe('## Memory\n\nfull');
  expect(plan?.baseline).toEqual(baselineOf(idx));
});

test('a truncated full index is recorded as a truncated baseline', () => {
  const idx = indexOf(entry());
  const plan = planMemoryReminder(null, idx, () => ({ body: '## Memory\n\ncapped', truncated: true }));
  expect(plan?.baseline.truncated).toBe(true);
});

test('no baseline and empty index emits nothing', () => {
  expect(planMemoryReminder(null, emptyIndex(), NONE)).toBeNull();
});

test('unchanged index emits nothing', () => {
  const idx = indexOf(entry(), entry({ id: 'bar', scope: 'global', type: 'user' }));
  expect(planMemoryReminder(baselineOf(idx), idx, FULL)).toBeNull();
  // A truncated baseline is also quiet while nothing changes.
  expect(planMemoryReminder(baselineOf(idx, true), idx, FULL)).toBeNull();
});

test('timestamps do not affect the fingerprint', () => {
  const a = indexOf(entry({ updated: '2026-01-01T00:00:00.000Z' }));
  const b = indexOf(entry({ updated: '2026-02-01T00:00:00.000Z' }));
  expect(planMemoryReminder(baselineOf(a), b, FULL)).toBeNull();
});

test('added, changed, and removed entries render as a delta', () => {
  const before = indexOf(entry(), entry({ id: 'gone', type: 'reference' }));
  const after = indexOf(
    entry({ description: 'new desc' }),
    entry({ id: 'fresh', scope: 'global', type: 'user', description: 'fresh desc' }),
  );
  const plan = planMemoryReminder(baselineOf(before), after, FULL);
  expect(plan?.kind).toBe('delta');
  expect(plan?.body).toBe(
    [
      '## Memory changes',
      '',
      'Since the last memory index:',
      '+ [global/user] `fresh` - fresh desc',
      '~ [project/feedback] `foo` - new desc',
      '- [project/reference] `gone` (removed)',
    ].join('\n'),
  );
  expect(plan?.baseline).toEqual(baselineOf(after));
});

test('a diff above the change limit falls back to the full index', () => {
  const after = indexOf(entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' }));
  const plan = planMemoryReminder({ fingerprint: {}, truncated: false }, after, FULL, 2);
  expect(plan?.kind).toBe('full');
});

test('any change on a truncated baseline resends the full index so the cap can re-balance', () => {
  const before = indexOf(entry(), entry({ id: 'hidden', type: 'project' }));
  const after = indexOf(entry({ id: 'hidden', type: 'project' }));
  const plan = planMemoryReminder(baselineOf(before, true), after, FULL);
  expect(plan?.kind).toBe('full');
  expect(plan?.baseline).toEqual(baselineOf(after));
});

test('removing the last entry still reports the removal', () => {
  const before = indexOf(entry());
  const plan = planMemoryReminder(baselineOf(before), emptyIndex(), NONE);
  expect(plan?.kind).toBe('delta');
  expect(plan?.body).toContain('- [project/feedback] `foo` (removed)');
  expect(plan?.baseline).toEqual({ fingerprint: {}, truncated: false });
});

test('withEntry / withoutEntry track local mutations without a delta', () => {
  const before = indexOf(entry());
  const added = entry({ id: 'new', description: 'n' });
  let fp = withEntry(fingerprintIndex(before), added);
  expect(diffIndex(fp, indexOf(entry(), added))).toEqual({ added: [], changed: [], removed: [] });
  fp = withoutEntry(fp, added);
  expect(fp).toEqual(fingerprintIndex(before));
});

test('formatMemoryDelta returns null for an empty diff', () => {
  expect(formatMemoryDelta({ added: [], changed: [], removed: [] })).toBeNull();
});

test('containsFullIndex finds a framed full index but not a delta', () => {
  const full = {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder id="memory-index">\n## Memory\n\nx' }],
  };
  const delta = {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder id="memory-index">\n## Memory changes\n\nx' }],
  };
  expect(containsFullIndex([{ role: 'user', content: 'hi' }, full])).toBe(true);
  expect(containsFullIndex([delta, { role: 'assistant', content: [{ type: 'toolCall' }] }])).toBe(false);
  expect(containsFullIndex([{ role: 'user', content: '<system-reminder id="memory-index">\n## Memory\n' }])).toBe(true);
  expect(containsFullIndex([])).toBe(false);
});

const record = (fingerprint: Record<string, string>, truncated?: boolean): Record<string, unknown> => ({
  type: 'custom',
  customType: MEMORY_DELIVERY_TYPE,
  data: truncated === undefined ? { fingerprint } : { fingerprint, truncated },
});

test('deliveryFromBranch returns the latest record', () => {
  expect(deliveryFromBranch([record({ a: '1' }), { type: 'message' }, record({ b: '2' }, true)])).toEqual({
    fingerprint: { b: '2' },
    truncated: true,
  });
});

test('deliveryRecord omits truncated when false and round-trips through deliveryFromBranch', () => {
  const complete: MemoryBaseline = { fingerprint: { a: '1' }, truncated: false };
  expect(deliveryRecord(complete)).toEqual({ fingerprint: { a: '1' } });
  const branch = [{ type: 'custom', customType: MEMORY_DELIVERY_TYPE, data: deliveryRecord(complete) }];
  expect(deliveryFromBranch(branch)).toEqual(complete);
});

test('deliveryFromBranch resets after a later compaction', () => {
  expect(deliveryFromBranch([record({ a: '1' }), { type: 'compaction' }])).toBeNull();
  expect(deliveryFromBranch([{ type: 'compaction' }, record({ a: '1' })])).toEqual({
    fingerprint: { a: '1' },
    truncated: false,
  });
});

test('deliveryFromBranch ignores malformed records', () => {
  expect(
    deliveryFromBranch([
      { type: 'custom', customType: MEMORY_DELIVERY_TYPE, data: { fingerprint: { a: 1 } } },
      { type: 'custom', customType: MEMORY_DELIVERY_TYPE, data: { fingerprint: {}, truncated: 'yes' } },
      { type: 'custom', customType: MEMORY_DELIVERY_TYPE, data: null },
    ]),
  ).toBeNull();
  expect(deliveryFromBranch([])).toBeNull();
});
