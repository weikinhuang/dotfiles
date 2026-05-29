/**
 * Duration parsing/formatting for the scheduled-prompts extension.
 *
 * Schedules accept human durations like `30m`, `2h`, `10s`, `1d` for
 * interval triggers (`--every`), one-shot delays (`--in`), and jitter
 * windows (`--jitter`). A duration is one or more `<number><unit>`
 * segments; segments accumulate (`1h30m` -> 5400000ms) so the same
 * grammar covers both the compact single-unit case and combined spans.
 *
 * Pure module - no pi imports - so it is directly unit-testable.
 */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

// One or more `<digits><unit>` segments, anchored, no internal spaces.
const DURATION_RE = /^(?:\d+[smhd])+$/;
const SEGMENT_RE = /(\d+)([smhd])/g;

/**
 * Parse a duration string to milliseconds. Accepts combined segments
 * (`1h30m`) in any order; later segments add to earlier ones. Returns
 * `null` when the input is empty, has no unit, or carries an unknown
 * unit. A bare number with no unit is rejected on purpose - callers
 * should be explicit about the time base.
 */
export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (!DURATION_RE.test(trimmed)) return null;
  let total = 0;
  for (const match of trimmed.matchAll(SEGMENT_RE)) {
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs = UNIT_MS[unit];
    if (unitMs === undefined) return null;
    total += value * unitMs;
  }
  return total > 0 ? total : null;
}

/**
 * Parse a duration range like `30s-5m` into `{ minMs, maxMs }`, or a
 * single duration like `2m` into an equal-bounds range (`min === max`).
 * Returns `null` when either side is unparseable or `min > max`. Used by
 * the `after` trigger's random window.
 */
export function parseDurationRange(input: string): { minMs: number; maxMs: number } | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const dash = trimmed.indexOf('-');
  if (dash === -1) {
    const ms = parseDuration(trimmed);
    return ms === null ? null : { minMs: ms, maxMs: ms };
  }
  const minMs = parseDuration(trimmed.slice(0, dash));
  const maxMs = parseDuration(trimmed.slice(dash + 1));
  if (minMs === null || maxMs === null || minMs > maxMs) return null;
  return { minMs, maxMs };
}

/**
 * Format a millisecond span as a compact `1d2h3m4s` string, dropping
 * zero components. Sub-second spans render as `0s`. Negative spans are
 * clamped to `0s` (used for "fires now" / overdue display).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  let remaining = Math.floor(ms / 1000);
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.length > 0 ? parts.join('') : '0s';
}
