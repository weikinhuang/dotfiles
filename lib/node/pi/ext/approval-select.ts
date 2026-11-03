/** Bounded approval menu: scroll the explanation independently of the choices. */
import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';

import { assembleWindowedBody, overlayViewportRows } from './overlay-window.ts';
import { showModal, type ModalCapableUi } from './show-modal.ts';

export class ApprovalSelectOverlay implements Component {
  private selected = 0;
  private detailsScrollTop = 0;
  private choicesScrollTop = 0;
  private detailsPage = 1;
  private detailsMax = 0;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  constructor(
    private readonly title: string,
    private readonly options: readonly string[],
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly kb: KeybindingsManager,
    private readonly done: (value: string | undefined) => void,
  ) {}

  private scrollDetails(delta: number): void {
    this.detailsScrollTop = Math.max(0, Math.min(this.detailsMax, this.detailsScrollTop + delta));
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.kb.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) {
      this.done(undefined);
      return;
    }
    if (this.kb.matches(data, 'tui.select.confirm') || data === '\n') {
      this.done(this.options[this.selected]);
      return;
    }
    if (matchesKey(data, Key.pageUp)) this.scrollDetails(-this.detailsPage);
    else if (matchesKey(data, Key.pageDown)) this.scrollDetails(this.detailsPage);
    else if (matchesKey(data, Key.home)) this.scrollDetails(-this.detailsMax);
    else if (matchesKey(data, Key.end)) this.scrollDetails(this.detailsMax);
    else if (this.kb.matches(data, 'tui.select.up') || data === 'k') {
      this.selected = Math.max(0, this.selected - 1);
      this.invalidate();
      this.tui.requestRender();
    } else if (this.kb.matches(data, 'tui.select.down') || data === 'j') {
      this.selected = Math.min(Math.max(0, this.options.length - 1), this.selected + 1);
      this.invalidate();
      this.tui.requestRender();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel') return undefined;
    this.scrollDetails(event.wheelDelta ?? 0);
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
    const viewport = overlayViewportRows(rows);
    const header =
      viewport >= 3 ? [truncateToWidth(this.theme.fg('accent', this.theme.bold('Approval required')), width)] : [];
    const footer =
      viewport >= 2
        ? [truncateToWidth(this.theme.fg('dim', 'PgUp/Dn details · ↑↓ choose · Enter confirm · Esc deny'), width)]
        : [];
    const available = Math.max(0, viewport - header.length - footer.length);
    const details = wrapTextWithAnsi(this.title, Math.max(1, width - 2)).map((line) =>
      truncateToWidth(`  ${this.theme.fg('text', line)}`, width),
    );
    const choices: string[] = [];
    let keepStart = 0;
    let keepEnd = 1;
    for (let i = 0; i < this.options.length; i++) {
      const start = choices.length;
      const selected = i === this.selected;
      const label = `${selected ? '❯' : ' '} ${this.options[i]}`;
      choices.push(...wrapTextWithAnsi(this.theme.fg(selected ? 'accent' : 'text', label), Math.max(1, width)));
      if (selected) {
        keepStart = start;
        keepEnd = choices.length;
      }
    }
    // Show all choices when possible. On short terminals reserve one detail
    // row, and window the choices around the selection. Never pin the title.
    const minDetails = available >= 10 ? 3 : available >= 3 ? 1 : 0;
    const choiceRows = Math.min(choices.length, Math.max(0, available - minDetails));
    const detailWindow = assembleWindowedBody({
      header: [],
      body: details,
      footer: [],
      width,
      viewportRows: available - choiceRows,
      scrollTop: this.detailsScrollTop,
      theme: this.theme,
    });
    const choiceWindow = assembleWindowedBody({
      header: [],
      body: choices,
      footer: [],
      width,
      viewportRows: choiceRows,
      scrollTop: this.choicesScrollTop,
      theme: this.theme,
      keepStart,
      keepEnd,
    });
    this.detailsScrollTop = detailWindow.scrollTop;
    this.detailsMax = detailWindow.maxScrollTop;
    this.detailsPage = Math.max(1, detailWindow.contentRows);
    this.choicesScrollTop = choiceWindow.scrollTop;
    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = [...header, ...detailWindow.lines, ...choiceWindow.lines, ...footer].map((line) =>
      truncateToWidth(line, width),
    );
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }
}

/** Select-compatible presenter; original strings preserve approval decisions. */
export function promptApprovalSelect(
  ui: ModalCapableUi,
  title: string,
  options: readonly string[],
): Promise<string | undefined> {
  return showModal(ui, (tui, theme, kb, done) => new ApprovalSelectOverlay(title, options, theme, tui, kb, done));
}
