/**
 * Tests for lib/node/pi/stream-watchdog.ts.
 *
 * Pure module — no pi runtime needed. We drive the state machine with
 * explicit `nowMs` values rather than real wall-clock time so every
 * assertion is deterministic.
 */

import { expect, test } from 'vitest';

import {
  clear,
  createState,
  detectStale,
  peek,
  recordEnd,
  recordHeartbeat,
  recordStart,
} from '../../../../lib/node/pi/stream-watchdog.ts';

const STALL_MS = 60_000;

// ──────────────────────────────────────────────────────────────────────
// createState / peek
// ──────────────────────────────────────────────────────────────────────

test('createState: returns an empty state with no current entry', () => {
  const s = createState();

  expect(s.current).toBe(null);
  expect(peek(s)).toBe(null);
});

// ──────────────────────────────────────────────────────────────────────
// recordStart
// ──────────────────────────────────────────────────────────────────────

test('recordStart: installs a fresh entry with startedAt === lastHeartbeat', () => {
  const s = createState();
  recordStart(s, 1_000);

  expect(s.current).toEqual({ id: undefined, startedAt: 1_000, lastHeartbeat: 1_000, notified: false });
});

test('recordStart: carries the optional id through to the entry', () => {
  const s = createState();
  recordStart(s, 1_000, 'resp-abc');

  expect(s.current?.id).toBe('resp-abc');
});

test('recordStart: replaces any prior entry (covers missing-end edge case)', () => {
  const s = createState();
  recordStart(s, 1_000, 'first');
  recordHeartbeat(s, 2_000);
  // No `recordEnd` — simulate a dropped end event (reload mid-stream,
  // provider reconnect, etc.). The new stream should win.
  recordStart(s, 5_000, 'second');

  expect(s.current).toEqual({ id: 'second', startedAt: 5_000, lastHeartbeat: 5_000, notified: false });
});

// ──────────────────────────────────────────────────────────────────────
// recordHeartbeat
// ──────────────────────────────────────────────────────────────────────

test('recordHeartbeat: bumps lastHeartbeat on the current entry', () => {
  const s = createState();
  recordStart(s, 1_000);
  recordHeartbeat(s, 1_500);

  expect(s.current?.lastHeartbeat).toBe(1_500);
  expect(s.current?.startedAt).toBe(1_000);
});

test('recordHeartbeat: no-op when no stream is in flight', () => {
  const s = createState();
  recordHeartbeat(s, 500);

  expect(s.current).toBe(null);
});

test('recordHeartbeat: clears the `notified` latch so a recovered stream can re-fire', () => {
  const s = createState();
  recordStart(s, 1_000);

  // Goes stale, detectStale marks notified=true.
  expect(detectStale(s, 70_000, STALL_MS)).not.toBe(null);
  expect(s.current?.notified).toBe(true);

  // Stream comes back alive.
  recordHeartbeat(s, 70_500);

  expect(s.current?.notified).toBe(false);
  expect(s.current?.lastHeartbeat).toBe(70_500);

  // If it stalls AGAIN, detectStale should fire again.
  expect(detectStale(s, 140_000, STALL_MS)).not.toBe(null);
});

// ──────────────────────────────────────────────────────────────────────
// recordEnd / clear
// ──────────────────────────────────────────────────────────────────────

test('recordEnd: clears the slot', () => {
  const s = createState();
  recordStart(s, 1_000);
  recordEnd(s);

  expect(s.current).toBe(null);
});

test('clear: drops any pending stream', () => {
  const s = createState();
  recordStart(s, 1_000);
  clear(s);

  expect(s.current).toBe(null);
});

test('clear: idempotent on an already-empty state', () => {
  const s = createState();
  clear(s);
  clear(s);

  expect(s.current).toBe(null);
});

// ──────────────────────────────────────────────────────────────────────
// detectStale
// ──────────────────────────────────────────────────────────────────────

test('detectStale: null when no stream is in flight', () => {
  const s = createState();

  expect(detectStale(s, 10_000, STALL_MS)).toBe(null);
});

test('detectStale: null when the stream is within the stall threshold', () => {
  const s = createState();
  recordStart(s, 1_000);

  // 30s elapsed — under the 60s threshold.
  expect(detectStale(s, 31_000, STALL_MS)).toBe(null);
  expect(s.current?.notified).toBe(false);
});

test('detectStale: fires at the boundary (gap === stallMs is already stale per `>=` semantics)', () => {
  // Implementation uses `<` for not-yet-stale, i.e. `>= stallMs` fires.
  // Pinned to catch accidental inversions of the comparison.
  const s = createState();
  recordStart(s, 1_000);

  expect(detectStale(s, 61_000, STALL_MS)).not.toBe(null);
});

test('detectStale: does NOT fire one ms before the boundary', () => {
  const s = createState();
  recordStart(s, 1_000);

  expect(detectStale(s, 60_999, STALL_MS)).toBe(null);
});

test('detectStale: returns the entry when stall threshold is exceeded', () => {
  const s = createState();
  recordStart(s, 1_000, 'resp-xyz');
  const entry = detectStale(s, 61_001, STALL_MS);

  expect(entry).not.toBe(null);
  expect(entry?.id).toBe('resp-xyz');
  expect(entry?.startedAt).toBe(1_000);
  expect(entry?.lastHeartbeat).toBe(1_000);
});

test('detectStale: marks notified=true as a side effect', () => {
  const s = createState();
  recordStart(s, 1_000);
  detectStale(s, 70_000, STALL_MS);

  expect(s.current?.notified).toBe(true);
});

test('detectStale: returns null on repeated calls for the same stale stream (one-shot)', () => {
  const s = createState();
  recordStart(s, 1_000);

  expect(detectStale(s, 70_000, STALL_MS)).not.toBe(null);
  expect(detectStale(s, 80_000, STALL_MS)).toBe(null);
  expect(detectStale(s, 1_000_000, STALL_MS)).toBe(null);
});

test('detectStale: a heartbeat arriving before the poll resets the clock', () => {
  const s = createState();
  recordStart(s, 1_000);
  // 40s in, a token arrives — stream is healthy.
  recordHeartbeat(s, 41_000);

  // Poll runs at 50s total elapsed, but only 9s since the last beat.
  expect(detectStale(s, 50_000, STALL_MS)).toBe(null);
});

test('detectStale: uses lastHeartbeat, not startedAt, for the threshold comparison', () => {
  const s = createState();
  recordStart(s, 1_000);
  // Several heartbeats arrive, each within threshold.
  recordHeartbeat(s, 30_000);
  recordHeartbeat(s, 59_000);
  recordHeartbeat(s, 90_000);

  // Now silence for 61s after the last heartbeat.
  expect(detectStale(s, 152_000, STALL_MS)).not.toBe(null);
});

test('detectStale: respects a custom stall threshold', () => {
  const s = createState();
  recordStart(s, 0);

  // 10s gap with a 5s threshold → stale.
  expect(detectStale(s, 10_000, 5_000)).not.toBe(null);
});

test('detectStale: peek reflects the same entry returned', () => {
  const s = createState();
  recordStart(s, 1_000, 'resp-peek');
  const returned = detectStale(s, 70_000, STALL_MS);

  expect(peek(s)).toBe(returned);
});
