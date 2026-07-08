/**
 * `TodoOverlay` - the scrollable `/todos` overlay component for the todo
 * extension (config/pi/extensions/todo.ts).
 *
 * Lives under `ext/` because it imports `@earendil-works/pi-tui` (`Key`,
 * `matchesKey`, `truncateToWidth`, the `TUI`) and the `Theme` - the home for
 * pi-coupled UI glue extracted to shrink the extension shell. The viewport
 * windowing math is shared with the other overlays via
 * [`overlay-window.ts`](./overlay-window.ts); the pure todo grouping /
 * progress formatting lives in the pi-free `../todo-format.ts`.
 *
 * `renderStatusGlyph` is exported because the extension's own `renderCall` /
 * `renderInlineTodo` render paths share the themed glyph set with the overlay.
 */

import { type Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, type TUI } from '@earendil-works/pi-tui';

import { assembleWindowedBody, overlayViewportRows } from './overlay-window.ts';
import { formatTodoProgress, groupTodos } from '../todo-format.ts';
import { formatHeaderRule } from '../tui-rule.ts';
import { type Todo, type TodoState } from '../todo-reducer.ts';

/** Themed status glyph for a todo. Single source of truth for the
 * symbol set; mirrors `statusGlyph` in `todo-reducer.ts` but applies
 * the per-status theme colour. */
export function renderStatusGlyph(status: Todo['status'], theme: Theme): string {
  switch (status) {
    case 'completed':
      return theme.fg('success', '✓');
    case 'in_progress':
      return theme.fg('accent', theme.bold('→'));
    case 'review':
      return theme.fg('warning', '⋯');
    case 'blocked':
      return theme.fg('error', '⛔');
    case 'cancelled':
      return theme.fg('muted', '⊘');
    case 'pending':
      return theme.fg('dim', '○');
  }
}

/** Item render used inside the `/todos` overlay. Notes go on a
 * continuation line prefixed `• ` (overlay rows are 2-line items when
 * the note is set). */
function renderOverlayTodoLines(t: Todo, theme: Theme, idPad: number): string[] {
  const glyph = renderStatusGlyph(t.status, theme);
  const idStr = `#${t.id}`.padEnd(idPad);
  const textStyled =
    t.status === 'completed' || t.status === 'cancelled' ? theme.fg('dim', t.text) : theme.fg('text', t.text);
  const head = `    ${glyph} ${theme.fg('accent', idStr)} ${textStyled}`;
  if (!t.note) return [head];
  // Continuation indent: 4 (item indent) + 1 (glyph) + 1 (space) + idPad + 1 (space) = 7 + idPad
  const cont = `${' '.repeat(7 + idPad)}${theme.fg('dim', `• ${t.note}`)}`;
  return [head, cont];
}

/**
 * Ordered list of the six groups in their display order.
 * `withCount` controls whether the section header carries `(N)` (only
 * `Cancelled` and `Completed` do; the active groups are short enough
 * that the count is redundant).
 */
const OVERLAY_SECTIONS: readonly { key: keyof ReturnType<typeof groupTodos>; label: string; withCount: boolean }[] = [
  { key: 'in_progress', label: 'In progress', withCount: false },
  { key: 'review', label: 'Review', withCount: false },
  { key: 'pending', label: 'Pending', withCount: false },
  { key: 'blocked', label: 'Blocked', withCount: false },
  { key: 'cancelled', label: 'Cancelled', withCount: true },
  { key: 'completed', label: 'Completed', withCount: true },
];

export class TodoOverlay {
  private readonly state: TodoState;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly onClose: () => void;
  /** Viewport scroll offset (first visible body line); key-driven, no selection. */
  private scrollTop = 0;
  private maxScrollTop = 0;
  /** Visible body rows from the last render (a page for PageUp/PageDown). */
  private contentRows = 1;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  constructor(state: TodoState, theme: Theme, tui: TUI, onClose: () => void) {
    this.state = state;
    this.theme = theme;
    this.tui = tui;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, 'ctrl+p') || data === 'k') this.scrollTo(this.scrollTop - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, 'ctrl+n') || data === 'j')
      this.scrollTo(this.scrollTop + 1);
    else if (matchesKey(data, Key.pageUp) || matchesKey(data, 'ctrl+b'))
      this.scrollTo(this.scrollTop - this.contentRows);
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, 'ctrl+f'))
      this.scrollTo(this.scrollTop + this.contentRows);
    else if (matchesKey(data, Key.home) || data === 'g') this.scrollTo(0);
    else if (matchesKey(data, Key.end) || data === 'G') this.scrollTo(this.maxScrollTop);
  }

  private scrollTo(target: number): void {
    const next = Math.max(0, Math.min(this.maxScrollTop, target));
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
    const th = this.theme;

    const total = this.state.todos.length;
    const completed = this.state.todos.filter((t) => t.status === 'completed').length;
    const chip = total > 0 ? `${completed}/${total}` : undefined;
    // Pinned frame: title above, help below; the grouped list scrolls between.
    const header = ['', truncateToWidth(formatHeaderRule('Todos', chip, width, th), width), ''];
    const footer = ['', truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width), ''];

    const body: string[] = [];
    if (total === 0) {
      body.push(truncateToWidth(`  ${th.fg('dim', 'No todos yet. Ask the agent to plan a multi-step task.')}`, width));
    } else {
      // Progress bar adapts to terminal width: 8 cells at 80 cols,
      // wider when there's room (capped at 20 so it never dominates).
      const barWidth = Math.max(4, Math.min(20, Math.floor(width / 10)));
      const progress = formatTodoProgress(this.state, { width: barWidth });
      const pctText = `${progress.pct}%`;
      const progressLine = `  ${th.fg('success', progress.bar)}  ${th.fg('muted', pctText)}${progress.summary ? `   ${th.fg('muted', progress.summary)}` : ''}`;
      body.push(truncateToWidth(progressLine, width));
      body.push('');

      const groups = groupTodos(this.state);
      const idPad = Math.max(...this.state.todos.map((t) => String(t.id).length)) + 1; // include '#'
      let firstSection = true;
      for (const section of OVERLAY_SECTIONS) {
        const items = groups[section.key];
        if (items.length === 0) continue;
        if (!firstSection) body.push('');
        firstSection = false;
        const headerLabel = section.withCount ? `${section.label} (${items.length})` : section.label;
        body.push(truncateToWidth(`  ${th.fg('muted', headerLabel)}`, width));
        for (const t of items) {
          for (const row of renderOverlayTodoLines(t, th, idPad)) {
            body.push(truncateToWidth(row, width));
          }
        }
      }
    }

    const win = assembleWindowedBody({
      header,
      body,
      footer,
      width,
      viewportRows: overlayViewportRows(rows),
      scrollTop: this.scrollTop,
      theme: th,
    });
    this.scrollTop = win.scrollTop;
    this.maxScrollTop = win.maxScrollTop;
    this.contentRows = win.contentRows;

    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = win.lines;
    return win.lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }
}
