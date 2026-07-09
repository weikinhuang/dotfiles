/**
 * Pure sequence/timing seams for the `avatar` extension's animator.
 *
 * The timer-driven state machine (idle blink, activity cycles, emotion
 * overlays) lives in the extension shell (`config/pi/extensions/avatar.ts`)
 * because it holds `setTimeout` / `setInterval` handles and drives the
 * pi-tui renderer. Only the two provably-pure decisions it makes each tick
 * live here so they can be unit-tested without a clock:
 *
 *   - {@link randomInRange} - the blink/think delay draw (with an injectable
 *     RNG so tests are deterministic).
 *   - {@link stepPingPong} - the ping-pong frame advance shared by the
 *     activity-cycle and emotion-overlay loops.
 */

/**
 * A uniform sample in `[min, max)`. Inject `rng` for deterministic tests.
 * A reversed or degenerate range (`min >= max`) collapses to `min` rather
 * than sampling backwards into negative delays.
 */
export function randomInRange(min: number, max: number, rng: () => number = Math.random): number {
  if (min >= max) return min;
  return min + rng() * (max - min);
}

/** The advanced frame index and bounce direction after one ping-pong tick. */
export interface PingPongStep {
  index: number;
  dir: number;
}

/**
 * Advance a ping-pong (bounce) frame cursor one tick over a `count`-frame
 * state: step `index` by `dir`, then flip `dir` at either end so the cursor
 * bounces `0 -> count-1 -> 0` forever. Mirrors the inline loop the activity
 * cycle and emotion overlay run; callers guard with `count > 1` before ticking.
 */
export function stepPingPong(index: number, dir: number, count: number): PingPongStep {
  // Clamp to a valid frame index so a step from the last frame (or a stale
  // `index`/`dir`) can never return `count` or `-1` and paint a missing frame.
  const nextIndex = Math.max(0, Math.min(count - 1, index + dir));
  let nextDir = dir;
  if (nextIndex >= count - 1) nextDir = -1;
  if (nextIndex <= 0) nextDir = 1;
  return { index: nextIndex, dir: nextDir };
}
