/**
 * Tests for lib/node/pi/abort-merge.ts.
 */

import { expect, test } from 'vitest';

import { mergeAbortSignals } from '../../../../lib/node/pi/abort-merge.ts';

test('mergeAbortSignals: undefined when both inputs are undefined', () => {
  expect(mergeAbortSignals(undefined, undefined)).toBeUndefined();
});

test('mergeAbortSignals: returns the only non-undefined input verbatim', () => {
  const ac = new AbortController();
  expect(mergeAbortSignals(ac.signal, undefined)).toBe(ac.signal);
  expect(mergeAbortSignals(undefined, ac.signal)).toBe(ac.signal);
});

test('mergeAbortSignals: aborts when the first signal aborts', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const merged = mergeAbortSignals(a.signal, b.signal);

  expect(merged?.aborted).toBe(false);
  a.abort('a-reason');
  // Microtask flush.
  await Promise.resolve();
  expect(merged?.aborted).toBe(true);
  expect(merged?.reason).toBe('a-reason');
});

test('mergeAbortSignals: aborts when the second signal aborts', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const merged = mergeAbortSignals(a.signal, b.signal);

  b.abort('b-reason');
  await Promise.resolve();
  expect(merged?.aborted).toBe(true);
  expect(merged?.reason).toBe('b-reason');
});

test('mergeAbortSignals: already-aborted input produces an aborted merged signal', () => {
  const a = new AbortController();
  a.abort('pre-aborted');
  const b = new AbortController();
  const merged = mergeAbortSignals(a.signal, b.signal);

  expect(merged?.aborted).toBe(true);
  expect(merged?.reason).toBe('pre-aborted');
});

test('mergeAbortSignals: only fires once when both signals abort', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const merged = mergeAbortSignals(a.signal, b.signal);

  a.abort('first');
  b.abort('second');
  await Promise.resolve();
  expect(merged?.aborted).toBe(true);
  // First reason wins; we don't re-abort.
  expect(merged?.reason).toBe('first');
});
