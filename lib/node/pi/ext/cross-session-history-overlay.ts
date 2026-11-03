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
  sliceByColumn,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

import { overlayViewportRows } from './overlay-window.ts';
import type { PromptHistoryEntry } from '../cross-session-history.ts';
import { type HistorySearchItem, searchHistoryEntries } from '../cross-session-history-search.ts';

/**
 * Reverse-search overlay component. Owns its filter state, rendering,
 * and key dispatch; the host extension just wires `onAccept` /
 * `onCancel` to the `done` callback returned by `ctx.ui.custom`.
 */
export class ReverseSearchOverlay implements Component, Focusable {
  private readonly input = new Input({ prompt: '' });
  private readonly theme: Theme;
  private readonly tui: TUI | undefined;
  private readonly prompts: readonly PromptHistoryEntry[];
  /** Upper cap on visible result rows; the live budget also shrinks to the
   * terminal height so the overlay never renders taller than the viewport. */
  private readonly maxVisible: number;
  /** Visible result rows from the last render (a page for PageUp/PageDown). */
  private visibleRows: number;

  private items: HistorySearchItem[] = [];
  private selectedIdx = 0;
  /** Index into `items` of the topmost row currently visible. */
  private scrollOffset = 0;
  private showContinuations = false;
  private hiddenCount = 0;
  private previewFocused = false;
  private previewOffset = 0;
  private previewRows = 1;
  private previewNeedsAnchor = true;
  private previewCache?: { prompt: string; query: string; width: number; lines: string[]; matchRow: number };

  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  /** Internal focused state - mirrored onto Input for IME cursor positioning. */
  private innerFocused = false;

  onAccept?: (prompt: string) => void;
  onCancel?: () => void;

  constructor(theme: Theme, prompts: readonly (string | PromptHistoryEntry)[], tui?: TUI, maxVisible = 10) {
    this.theme = theme;
    this.tui = tui;
    this.prompts = prompts.map((entry) => (typeof entry === 'string' ? { prompt: entry } : entry));
    this.maxVisible = maxVisible;
    this.visibleRows = maxVisible;
    this.recompute();
  }

  private viewportRows(): number {
    return this.tui ? overlayViewportRows(this.tui.terminal.rows) : this.maxVisible + 12;
  }

  /** Short terminals switch between list and preview instead of squeezing both. */
  private layout(): { list: number; preview: number } {
    const budget = this.viewportRows();
    if (budget < 12) {
      const rows = Math.max(1, budget - 4);
      return this.previewFocused ? { list: 0, preview: rows } : { list: Math.min(this.maxVisible, rows), preview: 0 };
    }
    const preview = Math.min(7, Math.floor((budget - 5) * 0.4));
    return { list: Math.min(this.maxVisible, budget - 5 - preview), preview };
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
    if (matchesKey(data, Key.ctrl('o'))) {
      this.showContinuations = !this.showContinuations;
      this.recompute();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.previewFocused = !this.previewFocused;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'))) {
      this.scrollPreview(matchesKey(data, Key.shift('up')) ? -1 : 1);
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl('p'))) {
      if (this.previewFocused) this.scrollPreview(-1);
      else this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl('n')) || matchesKey(data, Key.ctrl('r'))) {
      // Ctrl+R inside the overlay = "next match" (bash-style cycle).
      if (this.previewFocused && !matchesKey(data, Key.ctrl('r'))) this.scrollPreview(1);
      else this.moveSelection(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      if (this.previewFocused) this.scrollPreview(-this.previewRows);
      else this.moveSelection(-this.visibleRows);
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      if (this.previewFocused) this.scrollPreview(this.previewRows);
      else this.moveSelection(this.visibleRows);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const sel = this.items[this.selectedIdx];
      if (sel) this.onAccept?.(sel.entry.prompt);
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
    if (next !== this.selectedIdx) {
      this.previewOffset = 0;
      this.previewNeedsAnchor = true;
    }
    this.selectedIdx = next;
    if (this.selectedIdx < this.scrollOffset) {
      this.scrollOffset = this.selectedIdx;
    } else if (this.selectedIdx >= this.scrollOffset + this.visibleRows) {
      this.scrollOffset = this.selectedIdx - this.visibleRows + 1;
    }
    this.invalidate();
  }

  private scrollPreview(delta: number): void {
    this.previewNeedsAnchor = false;
    this.previewOffset = Math.max(0, this.previewOffset + delta);
    this.invalidate();
  }

  private recompute(): void {
    const query = this.input.getValue();
    const result = searchHistoryEntries(this.prompts, query, this.showContinuations);
    this.items = result.items;
    this.hiddenCount = result.hiddenCount;
    this.selectedIdx = 0;
    this.scrollOffset = 0;
    this.previewOffset = 0;
    this.previewNeedsAnchor = true;
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
    const layout = this.layout();
    const visibleRows = Math.max(1, layout.list);
    this.visibleRows = visibleRows;
    if (this.selectedIdx < this.scrollOffset) this.scrollOffset = this.selectedIdx;
    else if (this.selectedIdx >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIdx - visibleRows + 1;
    }
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    const lines: string[] = [];
    const total = this.prompts.length;
    const matchCount = this.items.length;
    const filtering =
      this.hiddenCount > 0 ? ` · ${this.hiddenCount} continuation${this.hiddenCount === 1 ? '' : 's'} hidden` : '';
    const title = `${matchCount}/${total} prompts${filtering}${this.showContinuations ? ' · show all' : ''}`;
    lines.push(this.borderLine(width, ` Reverse search • ${title} `));

    const queryPrefix = '❯ ';
    // Both chars are BMP (no surrogate pairs), so `.length` matches visual width.
    const innerWidth = Math.max(1, width - queryPrefix.length);
    const inputLines = this.input.render(innerWidth);
    const inputBody = inputLines[0] ?? '';
    lines.push(truncateToWidth(this.theme.fg('accent', queryPrefix) + inputBody, width));

    if (layout.list > 0 && this.items.length === 0) {
      const hint = this.hiddenCount > 0 ? ' · ctrl+o includes continuations' : '';
      lines.push(truncateToWidth(this.theme.fg('muted', `  no matches${hint}`), width));
      for (let i = 1; i < visibleRows; i++) lines.push('');
    } else if (layout.list > 0) {
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

    if (layout.preview > 0) {
      this.previewRows = layout.preview;
      const preview = this.renderPreview(width, layout.preview);
      if (layout.list > 0) lines.push(preview.title);
      else lines[0] = preview.title;
      lines.push(...preview.lines);
    }
    const focus = this.previewFocused ? 'results' : 'preview';
    const help =
      width < 75
        ? `  enter insert · esc cancel · tab ${focus} · ^O all`
        : `  ↑↓ ${this.previewFocused ? 'scroll preview' : 'select'}  enter insert  esc cancel  tab ${focus}  ctrl+o ${this.showContinuations ? 'filter' : 'show all'}`;
    lines.push(truncateToWidth(this.theme.fg('dim', help), width));
    lines.push(this.borderLine(width));

    // On extremely short terminals prefer the query and selected result over chrome.
    this.cachedLines =
      this.viewportRows() < 5
        ? [
            lines[1] ?? '',
            this.items[this.selectedIdx] ? this.matchLine(this.items[this.selectedIdx], true, width) : 'no matches',
          ].slice(0, this.viewportRows())
        : lines;
    this.cachedWidth = width;
    this.cachedRows = rows;
    return this.cachedLines;
  }

  private renderPreview(width: number, rows: number): { title: string; lines: string[] } {
    const item = this.items[this.selectedIdx];
    if (!item) return { title: this.borderLine(width, ' Preview '), lines: Array.from({ length: rows }, () => '') };
    const { entry } = item;
    const query = this.input.getValue();
    if (
      this.previewCache?.prompt !== entry.prompt ||
      this.previewCache.query !== query ||
      this.previewCache.width !== width
    ) {
      const lines: string[] = [];
      let offset = 0;
      let matchRow = 0;
      for (const [index, line] of entry.prompt.split('\n').entries()) {
        if (index + 1 === item.snippet.lineNumber) matchRow = lines.length;
        const indices = item.indices.filter((i) => i >= offset && i < offset + line.length).map((i) => i - offset);
        const wrapped = wrapTextWithAnsi(this.highlight(line, indices), Math.max(1, width));
        lines.push(...(wrapped.length > 0 ? wrapped : ['']));
        offset += line.length + 1;
      }
      this.previewCache = { prompt: entry.prompt, query, width, lines, matchRow };
    }
    const { lines, matchRow } = this.previewCache;
    if (this.previewNeedsAnchor) {
      this.previewOffset = matchRow;
      this.previewNeedsAnchor = false;
    }
    this.previewOffset = Math.max(0, Math.min(this.previewOffset, lines.length - rows));
    const body = lines.slice(this.previewOffset, this.previewOffset + rows);
    while (body.length < rows) body.push('');
    const opener = entry.isOpener === true ? ' · session opener' : '';
    const date =
      entry.timestamp && Number.isFinite(Date.parse(entry.timestamp))
        ? ` · ${new Date(entry.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`
        : '';
    const range = `${this.previewOffset + 1}-${Math.min(lines.length, this.previewOffset + rows)}/${lines.length}`;
    return {
      title: this.borderLine(width, ` Preview${this.previewFocused ? ' [focused]' : ''}${opener}${date} · ${range} `),
      lines: body,
    };
  }

  private borderLine(width: number, label?: string): string {
    if (label === undefined || width < 4) return this.theme.fg('borderAccent', '─'.repeat(Math.max(0, width)));
    label = truncateToWidth(label, width - 4);
    const left = '── ';
    const right = ' ';
    const remaining = width - left.length - visibleWidth(label) - right.length;
    const dashes = '─'.repeat(Math.max(0, remaining));
    return (
      this.theme.fg('borderAccent', left) +
      this.theme.fg('accent', label) +
      this.theme.fg('borderAccent', right + dashes)
    );
  }

  private matchLine(item: HistorySearchItem, isSelected: boolean, width: number): string {
    const opener = item.entry.isOpener === true ? '[opener] ' : '';
    const line = item.snippet.lineNumber > 1 ? `L${item.snippet.lineNumber} ` : '';
    const prefixRaw = `${isSelected ? '> ' : '  '}${opener}${line}`;
    const prefix = isSelected ? this.theme.fg('accent', prefixRaw) : prefixRaw;
    const available = Math.max(1, width - visibleWidth(prefixRaw));
    const firstMatch = item.snippet.indices[0] ?? 0;
    const matchColumn = visibleWidth(item.snippet.text.slice(0, firstMatch));
    const start = matchColumn >= available ? Math.max(0, matchColumn - Math.floor(available / 3)) : 0;
    const styled = this.highlight(item.snippet.text, item.snippet.indices);
    const clipped = sliceByColumn(styled, start, available + 2, true);
    return truncateToWidth(prefix + (start > 0 ? '…' : '') + clipped, width);
  }

  private highlight(text: string, indices: number[]): string {
    const indexSet = new Set(indices);
    // Group consecutive matched/unmatched chars into runs to keep ANSI
    // output compact.
    let styled = '';
    let curMatched = false;
    let curRun = '';
    for (let i = 0; i < text.length; i++) {
      const matched = indexSet.has(i);
      if (i === 0) curMatched = matched;
      else if (matched !== curMatched) {
        styled += curMatched ? this.theme.fg('accent', curRun) : curRun;
        curRun = '';
        curMatched = matched;
      }
      curRun += text[i];
    }
    if (curRun.length > 0) styled += curMatched ? this.theme.fg('accent', curRun) : curRun;

    return styled;
  }
}
