/**
 * Pure viewport-windowing math for scrollable overlay regions.
 *
 * Overlay components (scratchpad, todo, bg-bash lists, the checkpoint diff
 * viewer) render an unbounded list of lines into a fixed terminal height. If
 * they hand pi more lines than the terminal has rows, pi's overlay compositor
 * inflates the screen buffer past the viewport and the screen scroll/flickers
 * (see config/pi/extensions/scratchpad.md). This helper computes which slice
 * of a line list is visible given a fixed row budget and a previous scroll
 * offset, keeping an optional line range (a selection, a cursor) in view.
 *
 * It is deliberately numeric-only: callers own line building, indicator
 * styling, and where the returned offset is stored. Two usage modes:
 *
 *   - Selection-driven (scratchpad/todo/bg-bash): pass `keepStart`/`keepEnd`
 *     for the currently-selected item's line range; the window scrolls just
 *     enough to reveal it. When the range is taller than the row budget, the
 *     start wins (the top of the selected item is shown).
 *   - Key-driven (checkpoint diff): omit `keepStart`/`keepEnd` and mutate
 *     `scrollTop` yourself (PageUp/PageDown/Home/End); the helper only clamps.
 *
 * Pure module - no pi imports.
 */

export interface ScrollWindowInput {
  /** Total number of scrollable lines. */
  total: number;
  /** Visible rows available for the scroll region (excluding any indicator rows). */
  rows: number;
  /** Current scroll offset (first visible line index) to start from. */
  scrollTop: number;
  /** Inclusive line index that must stay visible (e.g. selection start). */
  keepStart?: number;
  /** Exclusive end of the line range that must stay visible (e.g. selection end). */
  keepEnd?: number;
}

export interface ScrollWindow {
  /** First visible line index (inclusive). */
  start: number;
  /** One past the last visible line index (exclusive). */
  end: number;
  /** Clamped scroll offset; the caller stores this back for the next render. */
  scrollTop: number;
  /** Lines hidden above the window (== start). */
  hiddenAbove: number;
  /** Lines hidden below the window (== total - end). */
  hiddenBelow: number;
}

/**
 * Compute the visible slice `[start, end)` of a `total`-line list given a
 * `rows` budget and a previous `scrollTop`, keeping `[keepStart, keepEnd)`
 * visible when supplied. All inputs are floored/clamped defensively so
 * out-of-range values (negative rows, a stale offset past the end, a
 * selection index beyond `total`) never produce an invalid window.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeScrollWindow(input: ScrollWindowInput): ScrollWindow {
  const total = Math.max(0, Math.floor(input.total));
  const rows = Math.max(0, Math.floor(input.rows));

  // Nothing to show, or no room to show it.
  if (total === 0 || rows === 0) {
    return { start: 0, end: 0, scrollTop: 0, hiddenAbove: 0, hiddenBelow: total };
  }

  // Everything fits: no scrolling, no offset.
  if (total <= rows) {
    return { start: 0, end: total, scrollTop: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }

  const maxScrollTop = total - rows;
  let scrollTop = clamp(Math.floor(input.scrollTop), 0, maxScrollTop);

  // Keep the requested range visible. Reveal the end first, then the start,
  // so a range taller than the row budget shows its start (top-anchored).
  if (input.keepStart !== undefined && input.keepEnd !== undefined) {
    const keepStart = clamp(Math.floor(input.keepStart), 0, total);
    const keepEnd = clamp(Math.floor(input.keepEnd), keepStart, total);
    if (keepEnd > scrollTop + rows) scrollTop = keepEnd - rows;
    if (keepStart < scrollTop) scrollTop = keepStart;
    scrollTop = clamp(scrollTop, 0, maxScrollTop);
  }

  const start = scrollTop;
  const end = Math.min(total, scrollTop + rows);
  return { start, end, scrollTop, hiddenAbove: start, hiddenBelow: total - end };
}
