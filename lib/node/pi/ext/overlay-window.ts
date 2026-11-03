/**
 * `assembleWindowedBody` - shared viewport-windowing assembly for scrollable
 * overlay components (todo, bg-bash, subagent, context-usage,
 * cross-session-history, checkpoint diff).
 *
 * The numeric slice math lives in the pure `lib/node/pi/scroll-window.ts`
 * (`computeScrollWindow`). This helper wraps it with the pi-specific bits an
 * overlay's `render()` needs: a pinned header/footer, a scrolled body slice,
 * and dim `↑ N more` / `↓ N more` indicator rows. It lives under `ext/`
 * because it imports pi runtime helpers (`truncateToWidth`, the `Theme`).
 *
 * Real overlays are clipped from the bottom by pi, not automatically scrolled.
 * Bound the body internally so the selection and footer remain visible.
 *
 * Two usage modes (mirrors computeScrollWindow):
 *   - Selection-driven: pass `keepStart`/`keepEnd` for the selected item's
 *     line range so the window scrolls to reveal it.
 *   - Key-driven: omit them and mutate `scrollTop` yourself (arrows / PageUp /
 *     PageDown / Home / End); the helper only clamps.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

import { computeScrollWindow } from '../scroll-window.ts';

/** Rows kept clear above+below a modal overlay so it never touches the
 * screen edges (matches the scratchpad backstop). */
export const OVERLAY_VERTICAL_MARGIN = 2;
/** Smallest usable viewport; never inflate a short terminal to six rows. */
export const MIN_OVERLAY_ROWS = 1;

/** Row budget a modal overlay renders into for a given terminal height. */
export function overlayViewportRows(terminalRows: number): number {
  return Math.max(MIN_OVERLAY_ROWS, Math.floor(terminalRows) - OVERLAY_VERTICAL_MARGIN);
}

export interface WindowedBodyInput {
  /** Pinned lines rendered above the scroll region (title, summary, ...). */
  header: string[];
  /** Scrollable body lines. */
  body: string[];
  /** Pinned lines rendered below the scroll region (help/footer). */
  footer: string[];
  /** Render width for truncating indicator rows. */
  width: number;
  /** Total row budget (typically `overlayViewportRows(tui.terminal.rows)`). */
  viewportRows: number;
  /** Previous scroll offset to start from. */
  scrollTop: number;
  /** Theme for the dim indicator rows. */
  theme: Theme;
  /** Selection-driven: inclusive first line to keep visible. */
  keepStart?: number;
  /** Selection-driven: exclusive end of the range to keep visible. */
  keepEnd?: number;
}

export interface WindowedBodyResult {
  /** Final line list: header + top indicator + body slice + bottom indicator + footer. */
  lines: string[];
  /** Clamped scroll offset the caller should store for the next render. */
  scrollTop: number;
  /** First/one-past-last visible body-line indices from this render. */
  winStart: number;
  winEnd: number;
  /** Largest valid `scrollTop` for the current body/height. */
  maxScrollTop: number;
  /** Visible body rows in the scroll region (a page for PageUp/PageDown). */
  contentRows: number;
}

/**
 * Assemble a windowed overlay body. When the body fits the region, returns it
 * whole with no indicators and `scrollTop` reset to 0; otherwise reserves two
 * indicator rows (so total height is stable regardless of offset) and returns
 * the visible slice framed by `↑ N more` / `↓ N more`.
 */
export function assembleWindowedBody(input: WindowedBodyInput): WindowedBodyResult {
  const { body, width, theme } = input;
  const viewportRows = Math.max(0, Math.floor(input.viewportRows));
  let header = input.header;
  let footer = input.footer;
  // On tiny terminals, remove decorative blank rows first, then shorten the
  // frame, reserving one row for content. Never fail open to the full body.
  const frameRows = Math.max(0, viewportRows - Math.min(1, body.length));
  if (header.length + footer.length > frameRows) {
    header = header.filter((line) => line.trim().length > 0);
    footer = footer.filter((line) => line.trim().length > 0);
    const headerRows = Math.min(header.length, Math.ceil(frameRows / 2));
    header = header.slice(0, headerRows);
    const footerRows = Math.max(0, frameRows - header.length);
    footer = footerRows > 0 ? footer.slice(-footerRows) : [];
  }
  const regionRows = viewportRows - header.length - footer.length;

  // Everything fits: render the whole body.
  if (body.length <= regionRows) {
    return {
      lines: [...header, ...body, ...footer],
      scrollTop: 0,
      winStart: 0,
      winEnd: body.length,
      maxScrollTop: 0,
      contentRows: Math.max(1, regionRows),
    };
  }

  // Reserve indicators only when there is also room for at least one body row.
  const showIndicators = regionRows >= 3;
  const contentRows = Math.max(0, regionRows - (showIndicators ? 2 : 0));
  const win = computeScrollWindow({
    total: body.length,
    rows: contentRows,
    scrollTop: input.scrollTop,
    keepStart: input.keepStart,
    keepEnd: input.keepEnd,
  });

  const topIndicator =
    win.hiddenAbove > 0 ? truncateToWidth(`  ${theme.fg('dim', `↑ ${win.hiddenAbove} more`)}`, width) : '';
  const bottomIndicator =
    win.hiddenBelow > 0 ? truncateToWidth(`  ${theme.fg('dim', `↓ ${win.hiddenBelow} more`)}`, width) : '';

  return {
    lines: [
      ...header,
      ...(showIndicators ? [topIndicator] : []),
      ...body.slice(win.start, win.end),
      ...(showIndicators ? [bottomIndicator] : []),
      ...footer,
    ],
    scrollTop: win.scrollTop,
    winStart: win.start,
    winEnd: win.end,
    maxScrollTop: Math.max(0, body.length - contentRows),
    contentRows,
  };
}
