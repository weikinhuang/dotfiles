/**
 * Tests for lib/node/pi/stream-watchdog.ts.
 *
 * Pure module — no pi runtime needed. We drive the state machine with
 * explicit `nowMs` values rather than real wall-clock time so every
 * assertion is deterministic.
 */

import { expect, test } from 'vitest';

import {
  buildWatchdogNudge,
  clear,
  createState,
  detectStale,
  hasWatchdogMarker,
  peek,
  recordEnd,
  recordHeartbeat,
  recordStart,
  recordToolCall,
  recordToolResult,
  resetInFlightTools,
  WATCHDOG_MARKER,
} from '../../../../lib/node/pi/stream-watchdog.ts';

const STALL_MS = 60_000;
// Existing soft-only tests pin a hard cap large enough to never fire.
// New tests below exercise the hard branch with their own values.
const NEVER_HARD = Number.MAX_SAFE_INTEGER;

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
  expect(detectStale(s, 70_000, STALL_MS, NEVER_HARD)).not.toBe(null);
  expect(s.current?.notified).toBe(true);

  // Stream comes back alive.
  recordHeartbeat(s, 70_500);

  expect(s.current?.notified).toBe(false);
  expect(s.current?.lastHeartbeat).toBe(70_500);

  // If it stalls AGAIN, detectStale should fire again.
  expect(detectStale(s, 140_000, STALL_MS, NEVER_HARD)).not.toBe(null);
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

  expect(detectStale(s, 10_000, STALL_MS, NEVER_HARD)).toBe(null);
});

test('detectStale: null when the stream is within the stall threshold', () => {
  const s = createState();
  recordStart(s, 1_000);

  // 30s elapsed — under the 60s threshold.
  expect(detectStale(s, 31_000, STALL_MS, NEVER_HARD)).toBe(null);
  expect(s.current?.notified).toBe(false);
});

test('detectStale: fires at the boundary (gap === stallMs is already stale per `>=` semantics)', () => {
  // Implementation uses `<` for not-yet-stale, i.e. `>= stallMs` fires.
  // Pinned to catch accidental inversions of the comparison.
  const s = createState();
  recordStart(s, 1_000);

  expect(detectStale(s, 61_000, STALL_MS, NEVER_HARD)).not.toBe(null);
});

test('detectStale: does NOT fire one ms before the boundary', () => {
  const s = createState();
  recordStart(s, 1_000);

  expect(detectStale(s, 60_999, STALL_MS, NEVER_HARD)).toBe(null);
});

test('detectStale: returns the entry when stall threshold is exceeded', () => {
  const s = createState();
  recordStart(s, 1_000, 'resp-xyz');
  const result = detectStale(s, 61_001, STALL_MS, NEVER_HARD);

  expect(result).not.toBe(null);
  expect(result?.reason).toBe('soft');
  expect(result?.startedAt).toBe(1_000);
  expect(result?.lastHeartbeat).toBe(1_000);
  expect(result?.silentMs).toBe(60_001);
  expect(result?.inFlightTool).toBeUndefined();
  // The id stays on the state entry, not on the result shape.
  expect(s.current?.id).toBe('resp-xyz');
});

test('detectStale: marks notified=true as a side effect', () => {
  const s = createState();
  recordStart(s, 1_000);
  detectStale(s, 70_000, STALL_MS, NEVER_HARD);

  expect(s.current?.notified).toBe(true);
});

test('detectStale: returns null on repeated calls for the same stale stream (one-shot)', () => {
  const s = createState();
  recordStart(s, 1_000);

  expect(detectStale(s, 70_000, STALL_MS, NEVER_HARD)).not.toBe(null);
  expect(detectStale(s, 80_000, STALL_MS, NEVER_HARD)).toBe(null);
  expect(detectStale(s, 1_000_000, STALL_MS, NEVER_HARD)).toBe(null);
});

test('detectStale: a heartbeat arriving before the poll resets the clock', () => {
  const s = createState();
  recordStart(s, 1_000);
  // 40s in, a token arrives — stream is healthy.
  recordHeartbeat(s, 41_000);

  // Poll runs at 50s total elapsed, but only 9s since the last beat.
  expect(detectStale(s, 50_000, STALL_MS, NEVER_HARD)).toBe(null);
});

test('detectStale: uses lastHeartbeat, not startedAt, for the threshold comparison', () => {
  const s = createState();
  recordStart(s, 1_000);
  // Several heartbeats arrive, each within threshold.
  recordHeartbeat(s, 30_000);
  recordHeartbeat(s, 59_000);
  recordHeartbeat(s, 90_000);

  // Now silence for 61s after the last heartbeat.
  expect(detectStale(s, 152_000, STALL_MS, NEVER_HARD)).not.toBe(null);
});

test('detectStale: respects a custom stall threshold', () => {
  const s = createState();
  recordStart(s, 0);

  // 10s gap with a 5s threshold → stale.
  expect(detectStale(s, 10_000, 5_000, NEVER_HARD)).not.toBe(null);
});

test('detectStale: peek reflects the current entry after a soft-stale fire', () => {
  const s = createState();
  recordStart(s, 1_000, 'resp-peek');
  const result = detectStale(s, 70_000, STALL_MS, NEVER_HARD);

  expect(result?.startedAt).toBe(peek(s)?.startedAt);
  expect(result?.lastHeartbeat).toBe(peek(s)?.lastHeartbeat);
  expect(peek(s)?.notified).toBe(true);
});

// ───────────────────────────────────────────────────────────────────
// WATCHDOG_MARKER / hasWatchdogMarker / buildWatchdogNudge
// ───────────────────────────────────────────────────────────────────

test('WATCHDOG_MARKER: is a distinct sentinel so it does not collide with STALL_MARKER', () => {
  expect(WATCHDOG_MARKER.startsWith('⟳ [pi-')).toBe(true);
  expect(WATCHDOG_MARKER).toContain('stream-watchdog');
});

test('hasWatchdogMarker: true when the text carries our sentinel', () => {
  const msg = `${WATCHDOG_MARKER} (1/2) Your previous turn's stream went silent...`;

  expect(hasWatchdogMarker(msg)).toBe(true);
});

test('hasWatchdogMarker: false for unrelated input (including stall-recovery nudges)', () => {
  expect(hasWatchdogMarker('just a regular message')).toBe(false);
  expect(hasWatchdogMarker('⟳ [pi-stall-recovery] (1/2) ...')).toBe(false);
});

test('buildWatchdogNudge: leads with the marker, attempt counter, and silence timing', () => {
  const msg = buildWatchdogNudge({ silentSec: 63, elapsedSec: 120, attempt: 1, maxAttempts: 2 });

  expect(msg.startsWith(WATCHDOG_MARKER)).toBe(true);
  expect(msg).toContain('(1/2)');
  expect(msg).toContain('silent for 63s');
  expect(msg).toContain('120s total');
});

test('buildWatchdogNudge: non-final attempt asks the model to continue where it left off', () => {
  const msg = buildWatchdogNudge({ silentSec: 60, elapsedSec: 60, attempt: 1, maxAttempts: 2 });

  expect(msg).toContain('Continue where you left off');
  expect(msg).not.toContain('final auto-retry');
});

test('buildWatchdogNudge: final attempt switches to the strict "concrete output" wording', () => {
  const msg = buildWatchdogNudge({ silentSec: 75, elapsedSec: 200, attempt: 2, maxAttempts: 2 });

  expect(msg).toContain('final auto-retry');
  expect(msg).toContain('concrete tool call');
  expect(msg).toContain('Blocked on:');
  expect(msg).not.toContain('Continue where you left off');
});

test('buildWatchdogNudge: attempt > maxAttempts still renders the final variant (defensive)', () => {
  // Caller shouldn't push us past the budget, but if they do we should
  // degrade gracefully to the strict wording rather than render an
  // out-of-band "keep going" message.
  const msg = buildWatchdogNudge({ silentSec: 90, elapsedSec: 300, attempt: 3, maxAttempts: 2 });

  expect(msg).toContain('(3/2)');
  expect(msg).toContain('final auto-retry');
});

test('buildWatchdogNudge: renders the budget exactly once (marker + counter format pinned)', () => {
  const msg = buildWatchdogNudge({ silentSec: 60, elapsedSec: 60, attempt: 1, maxAttempts: 2 });

  expect(msg.match(/\(1\/2\)/g)).toHaveLength(1);
  expect(msg.match(/\[pi-stream-watchdog\]/g)).toHaveLength(1);
});

test('buildWatchdogNudge: output is round-trippable through hasWatchdogMarker', () => {
  const msg = buildWatchdogNudge({ silentSec: 60, elapsedSec: 60, attempt: 1, maxAttempts: 2 });

  expect(hasWatchdogMarker(msg)).toBe(true);
});

// ──────────────────────────────────────────────────────────────────────
// recordToolCall / recordToolResult — counter + name stack
// ──────────────────────────────────────────────────────────────────────

test('recordToolCall + recordToolResult: single round-trip pushes/pops the name and updates lastForwardProgress', () => {
  const s = createState();
  recordStart(s, 1_000);
  const startProgress = s.lastForwardProgress;

  recordToolCall(s, 2_000, 'subagent');

  expect(s.inFlightTools).toBe(1);
  expect(s.inFlightToolNames).toEqual(['subagent']);
  expect(s.lastForwardProgress).toBe(2_000);
  expect(s.lastForwardProgress).not.toBe(startProgress);

  recordToolResult(s, 5_000);

  expect(s.inFlightTools).toBe(0);
  expect(s.inFlightToolNames).toEqual([]);
  expect(s.lastForwardProgress).toBe(5_000);
});

test('recordToolCall: three concurrent calls then three results return counter to zero in any order', () => {
  const s = createState();
  recordStart(s, 1_000);

  recordToolCall(s, 2_000, 'bash');
  recordToolCall(s, 2_100, 'subagent');
  recordToolCall(s, 2_200, 'bg_bash');

  expect(s.inFlightTools).toBe(3);
  expect(s.inFlightToolNames).toEqual(['bash', 'subagent', 'bg_bash']);

  recordToolResult(s, 3_000);
  recordToolResult(s, 3_100);
  recordToolResult(s, 3_200);

  expect(s.inFlightTools).toBe(0);
  expect(s.inFlightToolNames).toEqual([]);
});

test('recordToolResult: clamps at zero when called more times than recordToolCall', () => {
  const s = createState();
  recordStart(s, 1_000);

  recordToolResult(s, 2_000);
  recordToolResult(s, 3_000);
  recordToolResult(s, 4_000);

  expect(s.inFlightTools).toBe(0);
  expect(s.inFlightToolNames).toEqual([]);
  // lastForwardProgress still advances — the events are still "forward
  // progress" from the runtime's perspective even if our bookkeeping
  // is out of sync.
  expect(s.lastForwardProgress).toBe(4_000);
});

test('resetInFlightTools: zeros the counter and clears the stack after a partial sequence', () => {
  const s = createState();
  recordStart(s, 1_000);
  recordToolCall(s, 2_000, 'bash');
  recordToolCall(s, 2_100, 'subagent');
  recordToolResult(s, 3_000);

  expect(s.inFlightTools).toBe(1);
  expect(s.inFlightToolNames).toEqual(['bash']);

  resetInFlightTools(s);

  expect(s.inFlightTools).toBe(0);
  expect(s.inFlightToolNames).toEqual([]);
  // Does NOT touch the rest of state.
  expect(s.current).not.toBe(null);
  expect(s.lastForwardProgress).toBe(3_000);
});

test('recordHeartbeat after recordToolCall: updates lastForwardProgress AND lastHeartbeat, leaves counter alone', () => {
  const s = createState();
  recordStart(s, 1_000);
  recordToolCall(s, 2_000, 'subagent');

  recordHeartbeat(s, 4_000);

  expect(s.current?.lastHeartbeat).toBe(4_000);
  expect(s.lastForwardProgress).toBe(4_000);
  expect(s.inFlightTools).toBe(1);
  expect(s.inFlightToolNames).toEqual(['subagent']);
});

// ──────────────────────────────────────────────────────────────────────
// detectStale — soft branch with tool-call awareness
// ──────────────────────────────────────────────────────────────────────

test('detectStale soft: tool in flight + soft elapsed but NOT hard ⇒ null (suppressed)', () => {
  const s = createState();
  recordStart(s, 1_000);
  recordToolCall(s, 2_000, 'subagent');

  // 70s past last heartbeat (soft elapsed, 60s threshold) but well
  // under a 30-min hard cap. Tool is in flight ⇒ no abort.
  const result = detectStale(s, 71_000, STALL_MS, 1_800_000);

  expect(result).toBe(null);
});

test('detectStale soft: no tool in flight + soft elapsed ⇒ { reason: soft, inFlightTool: undefined }', () => {
  const s = createState();
  recordStart(s, 1_000);

  const result = detectStale(s, 70_000, STALL_MS, 1_800_000);

  expect(result?.reason).toBe('soft');
  expect(result?.inFlightTool).toBeUndefined();
  expect(result?.silentMs).toBe(69_000);
});

// ──────────────────────────────────────────────────────────────────────
// detectStale — hard branch
// ──────────────────────────────────────────────────────────────────────

test('detectStale hard: tool in flight + hard elapsed ⇒ { reason: hard, inFlightTool: <last pushed name> }', () => {
  const s = createState();
  recordStart(s, 1_000);
  recordToolCall(s, 2_000, 'bash');
  recordToolCall(s, 2_100, 'subagent');

  // Hard cap: 100ms. 5s past the most recent forward progress.
  const result = detectStale(s, 7_100, STALL_MS, 100);

  expect(result?.reason).toBe('hard');
  expect(result?.inFlightTool).toBe('subagent');
});

test('detectStale hard: hard elapsed without any in-flight tool ⇒ inFlightTool undefined', () => {
  const s = createState();
  recordStart(s, 1_000);

  // Soft threshold is huge so only the hard branch can fire.
  const result = detectStale(s, 5_000, NEVER_HARD, 1_000);

  expect(result?.reason).toBe('hard');
  expect(result?.inFlightTool).toBeUndefined();
});

test('detectStale precedence: no tool in flight + BOTH soft and hard elapsed ⇒ soft wins', () => {
  const s = createState();
  recordStart(s, 1_000);

  // 70s elapsed past both soft (60s) and hard (5s) thresholds, no
  // tools in flight. Per plan, soft is the more specific signal.
  const result = detectStale(s, 71_000, STALL_MS, 5_000);

  expect(result?.reason).toBe('soft');
  expect(result?.inFlightTool).toBeUndefined();
});

// ──────────────────────────────────────────────────────────────────────
// clear: lifecycle reset includes new fields
// ──────────────────────────────────────────────────────────────────────

test('clear: resets all new fields (counter, name stack, lastForwardProgress)', () => {
  const s = createState();
  recordStart(s, 1_000);
  recordToolCall(s, 2_000, 'subagent');
  recordToolCall(s, 2_500, 'bash');

  clear(s);

  expect(s.current).toBe(null);
  expect(s.inFlightTools).toBe(0);
  expect(s.inFlightToolNames).toEqual([]);
  expect(s.lastForwardProgress).toBe(0);
});

test('createState: initialises tool-tracking fields to defaults', () => {
  const s = createState();

  expect(s.inFlightTools).toBe(0);
  expect(s.inFlightToolNames).toEqual([]);
  expect(s.lastForwardProgress).toBe(0);
});
