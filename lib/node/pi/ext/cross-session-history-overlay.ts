/**
 * `ReverseSearchOverlay` - the Ctrl+R fzf-style reverse-search popup for the
 * cross-session-history extension (config/pi/extensions/cross-session-history.ts).
 *
 * Lives under `ext/` because it imports `@earendil-works/pi-tui` (`Input`,
 * `Key`, `matchesKey`, `truncateToWidth`, the `TUI`, `Focusable`) plus the
 * `Theme` from `pi-coding-agent` - the home for pi-coupled UI glue extracted
 * to shrink the extension shell. It owns its own filter state, rendering, and
 * key dispatch; the host extension just wires `onAccept` / `onCancel` to the
 * `done` callback returned by `ctx.ui.custom`. The viewport row budget is
 * shared with the other overlays via [`overlay-window.ts`](./overlay-window.ts);
 * the pure fuzzy scorer stays in the pi-free `../fuzzy-match.ts`.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
} from '@earendil-works/pi-tui';

import { overlayViewportRows } from './overlay-window.ts';
import { fuzzyMatch } from '../fuzzy-match.ts';

interface ScoredItem {
  prompt: string;
  score: number;
  /** Indices into the first line of `prompt` of matched chars. */
  indices: number[];
}

/**
 * Reverse-search overlay component. Owns its filter state, rendering,
 * and key dispatch; the host extension just wires `onAccept` /
 * `onCancel` to the `done` callback returned by `ctx.ui.custom`.
 */
export class ReverseSearchOverlay implements Component, Focusable {
  private readonly input = new Input();
  private readonly theme: Theme;
  private readonly tui: TUI | undefined;
  private readonly prompts: readonly string[];
  /** Upper cap on visible result rows; the live budget also shrinks to the
   * terminal height so the overlay never renders taller than the viewport. */
  private readonly maxVisible: number;
  /** Visible result rows from the last render (a page for PageUp/PageDown). */
  private visibleRows: number;

  private items: ScoredItem[] = [];
  private selectedIdx = 0;
  /** Index into `items` of the topmost row currently visible. */
  private scrollOffset = 0;

  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  /** Internal focused state - mirrored onto Input for IME cursor positioning. */
  private innerFocused = false;

  onAccept?: (prompt: string) => void;
  onCancel?: () => void;

  constructor(theme: Theme, prompts: readonly string[], tui?: TUI, maxVisible = 10) {
    this.theme = theme;
    this.tui = tui;
    this.prompts = prompts;
    this.maxVisible = maxVisible;
    this.visibleRows = maxVisible;
    this.recompute();
  }

  /** Visible result rows for the current terminal height (capped at
   * `maxVisible`). Chrome around the list is 4 rows: top border, query line,
   * help line, bottom border. */
  private computeVisibleRows(): number {
    if (!this.tui) return this.maxVisible;
    return Math.max(1, Math.min(this.maxVisible, overlayViewportRows(this.tui.terminal.rows) - 4));
  }

  // Focusable - propagate to embedded Input.
  get focused(): boolean {
    return this.innerFocused;
  }
  set focused(value: boolean) {
    this.innerFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl('p'))) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl('n')) || matchesKey(data, Key.ctrl('r'))) {
      // Ctrl+R inside the overlay = "next match" (bash-style cycle).
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.moveSelection(-this.visibleRows);
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.moveSelection(this.visibleRows);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const sel = this.items[this.selectedIdx];
      if (sel) this.onAccept?.(sel.prompt);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onCancel?.();
      return;
    }

    // Forward to Input for character entry / cursor motion / word delete.
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (before !== after) this.recompute();
    else this.invalidate();
  }

  private moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    let next = this.selectedIdx + delta;
    if (next < 0) next = 0;
    if (next > this.items.length - 1) next = this.items.length - 1;
    this.selectedIdx = next;
    if (this.selectedIdx < this.scrollOffset) {
      this.scrollOffset = this.selectedIdx;
    } else if (this.selectedIdx >= this.scrollOffset + this.visibleRows) {
      this.scrollOffset = this.selectedIdx - this.visibleRows + 1;
    }
    this.invalidate();
  }

  private recompute(): void {
    const query = this.input.getValue();
    if (query.length === 0) {
      // No query: show every prompt in the order the caller provided
      // (most-recent-first per the dedup helper).
      this.items = this.prompts.map((prompt) => ({ prompt, score: 0, indices: [] }));
    } else {
      const scored: ScoredItem[] = [];
      for (const prompt of this.prompts) {
        // Match against the first line - that's also what we render, and
        // multi-line prompts shouldn't match on text the user can't see.
        const firstLine = prompt.split('\n')[0] ?? '';
        const m = fuzzyMatch(query, firstLine);
        if (m === null) continue;
        scored.push({ prompt, score: m.score, indices: m.indices });
      }
      // Higher score wins; Array.prototype.sort is stable, so equal-score
      // ties resolve in input order (most-recent-first).
      scored.sort((a, b) => b.score - a.score);
      this.items = scored;
    }
    this.selectedIdx = 0;
    this.scrollOffset = 0;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const rows = this.tui?.terminal.rows ?? 0;
    if (this.cachedLines !== undefined && this.cachedWidth === width && this.cachedRows === rows) {
      return this.cachedLines;
    }

    // Clamp the visible-row budget to the terminal, then re-anchor the scroll
    // window on the selection so the overlay never exceeds the viewport.
    const visibleRows = this.computeVisibleRows();
    this.visibleRows = visibleRows;
    if (this.selectedIdx < this.scrollOffset) this.scrollOffset = this.selectedIdx;
    else if (this.selectedIdx >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIdx - visibleRows + 1;
    }
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    const lines: string[] = [];
    const total = this.prompts.length;
    const matchCount = this.items.length;
    const title = this.input.getValue().length === 0 ? `${total} prompts` : `${matchCount} of ${total} match`;
    lines.push(this.borderLine(width, ` Reverse search • ${title} `));

    const queryPrefix = '❯ ';
    // Both chars are BMP (no surrogate pairs), so `.length` matches visual width.
    const innerWidth = Math.max(1, width - queryPrefix.length);
    const inputLines = this.input.render(innerWidth);
    const inputBody = inputLines[0] ?? '';
    lines.push(truncateToWidth(this.theme.fg('accent', queryPrefix) + inputBody, width));

    if (this.items.length === 0 && this.input.getValue().length > 0) {
      lines.push(truncateToWidth(this.theme.fg('muted', '  no matches'), width));
      for (let i = 1; i < visibleRows; i++) lines.push('');
    } else {
      const visible = this.items.slice(this.scrollOffset, this.scrollOffset + visibleRows);
      for (let i = 0; i < visibleRows; i++) {
        const item = visible[i];
        if (item === undefined) {
          lines.push('');
          continue;
        }
        const absoluteIdx = this.scrollOffset + i;
        lines.push(this.matchLine(item, absoluteIdx === this.selectedIdx, width));
      }
    }

    lines.push(truncateToWidth(this.theme.fg('dim', '  ↑↓ select  enter insert  esc cancel  ctrl+r next'), width));
    lines.push(this.borderLine(width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedRows = rows;
    return lines;
  }

  private borderLine(width: number, label?: string): string {
    if (label === undefined) return this.theme.fg('borderAccent', '─'.repeat(width));
    if (label.length + 4 > width) return this.theme.fg('borderAccent', '─'.repeat(width));
    const left = '── ';
    const right = ' ';
    const remaining = width - left.length - label.length - right.length;
    const dashes = '─'.repeat(Math.max(0, remaining));
    return (
      this.theme.fg('borderAccent', left) +
      this.theme.fg('accent', label) +
      this.theme.fg('borderAccent', right + dashes)
    );
  }

  private matchLine(item: ScoredItem, isSelected: boolean, width: number): string {
    const firstLine = item.prompt.split('\n')[0] ?? '';
    const indexSet = new Set(item.indices.filter((i) => i < firstLine.length));
    const prefixRaw = isSelected ? '> ' : '  ';
    const prefix = isSelected ? this.theme.fg('accent', prefixRaw) : prefixRaw;

    // Group consecutive matched/unmatched chars into runs to keep ANSI
    // output compact.
    let styled = '';
    let curMatched = false;
    let curRun = '';
    for (let i = 0; i < firstLine.length; i++) {
      const matched = indexSet.has(i);
      if (i === 0) curMatched = matched;
      else if (matched !== curMatched) {
        styled += curMatched ? this.theme.fg('accent', curRun) : curRun;
        curRun = '';
        curMatched = matched;
      }
      curRun += firstLine[i];
    }
    if (curRun.length > 0) styled += curMatched ? this.theme.fg('accent', curRun) : curRun;

    return truncateToWidth(prefix + styled, width);
  }
}
