/**
 * `ReviewOverlay` - the checkpoint restore-review component (multi-select file
 * list + drill-down diff viewer) for the checkpoint extension
 * (config/pi/extensions/checkpoint.ts).
 *
 * Lives under `ext/` because it imports `@earendil-works/pi-tui` (`Key`,
 * `matchesKey`, `truncateToWidth`, the `TUI`) plus `renderDiff` and the
 * `Theme` from `pi-coding-agent` - the home for pi-coupled UI glue extracted
 * to shrink the extension shell. The pure diff / restore logic stays under
 * `../checkpoint/`. `ReviewRow` is exported because the extension builds the
 * rows (resolving targets against disk) before handing them to the overlay.
 */

import { renderDiff, type Theme } from '@earendil-works/pi-coding-agent';
import { type Component, Key, matchesKey, truncateToWidth, type TUI } from '@earendil-works/pi-tui';

import { overlayViewportRows } from './overlay-window.ts';
import { formatDiffForRender, unifiedDiffLines } from '../checkpoint/diff.ts';
import type { FileStatus, FileTarget, ReviewRow } from '../checkpoint/types.ts';

// `ReviewRow` now lives in the pure `checkpoint/types.ts` so the pure row
// builder can produce it without importing this pi-tui overlay. Re-exported
// here so existing `import { ReviewRow } from '.../checkpoint-review-overlay.ts'`
// call sites keep working.
export type { ReviewRow } from '../checkpoint/types.ts';

const VISIBLE_ROWS = 18;
const DETAIL_LINES = 24;

function statusMark(status: FileStatus): string {
  return status === 'conflict' ? '⚠ conflict' : status === 'clean-restore' ? '' : 'no-op';
}

export class ReviewOverlay implements Component {
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly rows: ReviewRow[];
  private readonly done: (value: FileTarget[] | null) => void;
  private sel = 0;
  private scroll = 0;
  /** Visible list rows / detail lines from the last render, derived from the
   * terminal height so neither mode overflows the viewport. */
  private visibleRows = VISIBLE_ROWS;
  private detailRows = DETAIL_LINES;
  /** When set, the drill-down diff viewer is open for this row. */
  private detail: { row: ReviewRow; lines: string[]; scroll: number } | undefined;
  private status?: string;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, rows: ReviewRow[], tui: TUI, done: (value: FileTarget[] | null) => void) {
    this.theme = theme;
    this.tui = tui;
    this.rows = rows;
    this.done = done;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private selectedTargets(): FileTarget[] {
    return this.rows.filter((r) => r.checked).map((r) => r.target);
  }

  handleInput(data: string): void {
    if (this.detail) {
      this.handleDetailInput(data);
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.sel = Math.max(0, this.sel - 1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.sel = Math.min(this.rows.length - 1, this.sel + 1);
    } else if (matchesKey(data, Key.space)) {
      this.rows[this.sel].checked = !this.rows[this.sel].checked;
    } else if (matchesKey(data, 'a')) {
      const allChecked = this.rows.every((r) => r.checked);
      for (const r of this.rows) r.checked = !allChecked;
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || matchesKey(data, 'l')) {
      this.openDetail();
    } else if (matchesKey(data, 'y')) {
      this.done(this.selectedTargets());
      return;
    } else if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      this.done(null);
      return;
    } else {
      return;
    }
    this.clampScroll();
    this.invalidate();
  }

  private handleDetailInput(data: string): void {
    if (!this.detail) return;
    const page = Math.max(1, this.detailRows - 1);
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) this.detail.scroll -= 1;
    else if (matchesKey(data, Key.down) || matchesKey(data, 'j')) this.detail.scroll += 1;
    else if (matchesKey(data, 'pageUp')) this.detail.scroll -= page;
    else if (matchesKey(data, 'pageDown') || matchesKey(data, Key.space)) this.detail.scroll += page;
    else if (matchesKey(data, 'home')) this.detail.scroll = 0;
    else if (matchesKey(data, 'end')) this.detail.scroll = Number.MAX_SAFE_INTEGER;
    else if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.backspace) ||
      matchesKey(data, 'h')
    ) {
      this.detail = undefined;
    } else if (matchesKey(data, 'q')) {
      this.done(null);
      return;
    } else {
      return;
    }
    this.invalidate();
  }

  private openDetail(): void {
    const row = this.rows[this.sel];
    const diffText = renderDiff(formatDiffForRender(unifiedDiffLines(row.currentText, row.targetText)));
    this.detail = { row, lines: diffText.split('\n'), scroll: 0 };
  }

  private clampScroll(): void {
    if (this.sel < this.scroll) this.scroll = this.sel;
    else if (this.sel >= this.scroll + this.visibleRows) this.scroll = this.sel - this.visibleRows + 1;
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
    // List chrome: title + blank + (up to 2 indicators) + blank + help. Detail
    // chrome: title + subtitle + blank + position footer. Derive both budgets
    // from the terminal so neither mode renders taller than the viewport.
    const viewportRows = overlayViewportRows(rows);
    this.visibleRows = Math.max(3, viewportRows - 6);
    this.detailRows = Math.max(3, viewportRows - 5);
    if (this.detail) this.clampScroll();
    const lines = this.detail ? this.renderDetail(width) : this.renderList(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedRows = rows;
    return lines;
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const checkedCount = this.rows.filter((r) => r.checked).length;
    const out: string[] = [
      truncateToWidth(
        th.fg('toolTitle', th.bold(`Restore review · ${this.rows.length} files · ${checkedCount} selected`)),
        width,
      ),
      '',
    ];
    const end = Math.min(this.rows.length, this.scroll + this.visibleRows);
    if (this.scroll > 0) out.push(truncateToWidth(`  ${th.fg('dim', `↑ ${this.scroll} more`)}`, width));
    for (let i = this.scroll; i < end; i++) {
      const r = this.rows[i];
      const cursor = i === this.sel ? th.fg('accent', '›') : ' ';
      const box = r.checked ? th.fg('success', '[x]') : '[ ]';
      const counts = `${th.fg('success', `+${r.adds}`)} ${th.fg('error', `-${r.dels}`)}`;
      const mark = statusMark(r.status);
      const markText = mark ? `  ${th.fg(r.status === 'conflict' ? 'warning' : 'dim', mark)}` : '';
      const path = i === this.sel ? th.fg('text', th.bold(r.target.path)) : th.fg('muted', r.target.path);
      out.push(truncateToWidth(`${cursor} ${box} ${path}   ${counts}${markText}`, width));
    }
    if (end < this.rows.length)
      out.push(truncateToWidth(`  ${th.fg('dim', `↓ ${this.rows.length - end} more`)}`, width));
    out.push('');
    out.push(
      truncateToWidth(
        `  ${th.fg('dim', this.status ?? 'space toggle · a all · ⏎ diff · y apply · esc cancel')}`,
        width,
      ),
    );
    return out;
  }

  private renderDetail(width: number): string[] {
    const th = this.theme;
    const d = this.detail;
    if (!d) return [];
    const total = d.lines.length;
    let scroll = d.scroll;
    if (scroll > Math.max(0, total - this.detailRows)) scroll = Math.max(0, total - this.detailRows);
    if (scroll < 0) scroll = 0;
    d.scroll = scroll;
    const slice = d.lines.slice(scroll, scroll + this.detailRows);
    const out: string[] = [
      truncateToWidth(th.fg('toolTitle', th.bold(d.row.target.path)), width),
      truncateToWidth(
        `  ${th.fg('muted', `+${d.row.adds} -${d.row.dels}${d.row.status === 'conflict' ? '  ⚠ changed out-of-band' : ''}`)}`,
        width,
      ),
      '',
    ];
    for (const line of slice) out.push(truncateToWidth(line, width));
    out.push('');
    const pos = total === 0 ? '0/0' : `${scroll + 1}-${Math.min(total, scroll + DETAIL_LINES)} / ${total}`;
    out.push(truncateToWidth(`  ${th.fg('dim', `↑/↓ scroll · PgUp/PgDn · ← back · q close   [${pos}]`)}`, width));
    return out;
  }
}
