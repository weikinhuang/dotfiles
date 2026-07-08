/**
 * `ContextOverlay` - the interactive `/context` drill-down component for the
 * context-usage extension (config/pi/extensions/context-usage.ts).
 *
 * Lives under `ext/` because it imports `@earendil-works/pi-tui` (`Key`,
 * `matchesKey`, `truncateToWidth`, `visibleWidth`, the `TUI`) and the
 * `Theme` - the home for pi-coupled UI glue extracted to shrink the extension
 * shell. All pure logic (tree build, grid math, navigation, formatting) still
 * lives under `../context-usage/`; this component only renders it.
 */

import { type Theme } from '@earendil-works/pi-coding-agent';
import { type Component, Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from '@earendil-works/pi-tui';

import { overlayViewportRows } from './overlay-window.ts';
import {
  childrenTotal,
  clampScroll,
  formatAbsoluteShare,
  formatBreadcrumb,
  formatPercent,
  formatTokens,
  GLYPH_FREE,
  GLYPH_PARTIAL,
  GLYPH_USED,
  sanitizeDetail,
  scrollWindow,
  wrapPlain,
} from '../context-usage/format.ts';
import { buildGrid, chunkRows, DEFAULT_GRID } from '../context-usage/grid.ts';
import {
  atRoot,
  back,
  breadcrumbLabels,
  currentChildren,
  currentNode,
  enter,
  initNav,
  move,
  type NavState,
} from '../context-usage/tree.ts';
import type { Breakdown, CategoryNode } from '../context-usage/types.ts';
import { cacheHitRatioPct } from '../token-format.ts';
import { formatHeaderRule } from '../tui-rule.ts';

/** Distinct category colors, cycled by child index. All guaranteed ThemeColor tokens. */
const PALETTE = [
  'accent',
  'success',
  'warning',
  'error',
  'mdLink',
  'syntaxKeyword',
  'syntaxString',
  'syntaxFunction',
  'syntaxType',
  'syntaxNumber',
] as const;

const FREE_COLOR = 'dim';
const GRID_COLS = DEFAULT_GRID.cols;
/** Left column display width: `GRID_COLS` glyphs, space-separated. */
const GRID_WIDTH = GRID_COLS * 2 - 1;
const COL_GAP = 3;
/** Below this terminal width the layout stacks vertically. */
const STACK_BELOW = 56;

type PaletteColor = (typeof PALETTE)[number];
function colorForIndex(i: number): PaletteColor {
  return PALETTE[i % PALETTE.length];
}

interface OverlayDeps {
  theme: Theme;
  tui: TUI;
  rebuild: () => Breakdown;
  compact: () => void;
  exportReport: (breakdown: Breakdown) => string;
  done: () => void;
}

export class ContextOverlay implements Component {
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly deps: OverlayDeps;
  private breakdown: Breakdown;
  private nav: NavState = initNav();
  private recon = false;
  private status?: string;
  /** When set, the scrollable content viewer for a leaf node is open. */
  private view: { node: CategoryNode; scroll: number } | undefined;
  /** Content-viewer visible lines from the last render (a page for PageUp/Dn). */
  private contentPage = 12;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  constructor(deps: OverlayDeps) {
    this.deps = deps;
    this.theme = deps.theme;
    this.tui = deps.tui;
    this.breakdown = deps.rebuild();
  }

  /** Row budget the overlay renders into for the current terminal height. */
  private viewportRows(): number {
    return overlayViewportRows(this.tui.terminal.rows);
  }

  handleInput(data: string): void {
    if (this.view) {
      this.handleViewInput(data);
      return;
    }
    const children = currentChildren(this.breakdown.root, this.nav);
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.nav = move(this.nav, -1, children.length);
    } else if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.nav = move(this.nav, 1, children.length);
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || matchesKey(data, 'l')) {
      const child = children[this.nav.sel];
      if (child?.children && child.children.length > 0) {
        this.nav = enter(this.breakdown.root, this.nav);
        this.status = undefined;
      } else if (child?.content && child.content.length > 0) {
        this.view = { node: child, scroll: 0 };
        this.status = undefined;
      } else {
        this.status = 'Nothing to drill into here';
      }
    } else if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.backspace) ||
      matchesKey(data, 'h')
    ) {
      if (atRoot(this.nav)) {
        this.deps.done();
        return;
      }
      this.nav = back(this.nav);
      this.status = undefined;
    } else if (matchesKey(data, 'q')) {
      this.deps.done();
      return;
    } else if (matchesKey(data, 'r')) {
      this.breakdown = this.deps.rebuild();
      if (currentChildren(this.breakdown.root, this.nav).length === 0) this.nav = initNav();
      this.status = 'Refreshed';
    } else if (matchesKey(data, 'c')) {
      this.deps.compact();
      this.status = 'Compaction triggered';
    } else if (matchesKey(data, 't')) {
      this.recon = !this.recon;
    } else if (matchesKey(data, 'e')) {
      try {
        const path = this.deps.exportReport(this.breakdown);
        this.status = `Exported to ${path}`;
      } catch (err) {
        this.status = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      return;
    }
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  /** Scroll / exit keys while the content viewer is open. */
  private handleViewInput(data: string): void {
    if (!this.view) return;
    const page = Math.max(1, this.contentPage - 1);
    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.view.scroll -= 1;
    } else if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.view.scroll += 1;
    } else if (matchesKey(data, 'pageUp')) {
      this.view.scroll -= page;
    } else if (matchesKey(data, 'pageDown') || matchesKey(data, Key.space)) {
      this.view.scroll += page;
    } else if (matchesKey(data, 'home')) {
      this.view.scroll = 0;
    } else if (matchesKey(data, 'end')) {
      this.view.scroll = Number.MAX_SAFE_INTEGER;
    } else if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.backspace) ||
      matchesKey(data, 'h')
    ) {
      this.view = undefined;
    } else if (matchesKey(data, 'q')) {
      this.deps.done();
      return;
    } else {
      return;
    }
    this.invalidate();
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
    let lines: string[];
    if (this.view) lines = this.renderContent(width);
    else if (this.recon) lines = this.renderRecon(width);
    else lines = this.renderTree(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedRows = rows;
    return lines;
  }

  // ── content viewer ───────────────────────────────────────────────────

  private renderContent(width: number): string[] {
    const th = this.theme;
    const view = this.view;
    if (!view) return [];
    const node = view.node;
    const crumb = formatBreadcrumb([...breadcrumbLabels(this.breakdown.root, this.nav.path), node.label]);
    const bodyWidth = Math.max(10, width - 2);
    const wrapped = wrapPlain(node.content ?? '', bodyWidth);
    // Content chrome around the slice: header + blank + label + blank + blank
    // + position footer = 6 rows. Adapt the visible slice to the terminal.
    const visibleLines = Math.max(3, this.viewportRows() - 6);
    this.contentPage = visibleLines;
    const scroll = clampScroll(view.scroll, wrapped.length, visibleLines);
    view.scroll = scroll;
    const slice = wrapped.slice(scroll, scroll + visibleLines);

    const out: string[] = [truncateToWidth(formatHeaderRule(crumb, undefined, width, th), width), ''];
    const detail = node.detail ? ` · ${sanitizeDetail(node.detail, 50)}` : '';
    out.push(
      truncateToWidth(`  ${th.fg('muted', `${node.label} · ${formatTokens(node.tokens)} tokens${detail}`)}`, width),
    );
    out.push('');
    for (const line of slice) out.push(truncateToWidth(`  ${th.fg('toolOutput', line)}`, width));
    out.push('');
    const end = Math.min(wrapped.length, scroll + visibleLines);
    const pos = wrapped.length === 0 ? '0/0' : `${scroll + 1}-${end} / ${wrapped.length}`;
    out.push(truncateToWidth(`  ${th.fg('dim', `↑/↓ scroll · PgUp/PgDn · ← back · q close   [${pos}]`)}`, width));
    return out;
  }

  // ── grid ────────────────────────────────────────────────────────────────

  private gridLines(): string[] {
    const th = this.theme;
    const node = currentNode(this.breakdown.root, this.nav);
    const children = node.children ?? [];
    const capacity = atRoot(this.nav) ? this.breakdown.contextWindow : node.tokens;
    const cells = buildGrid(
      children.map((c) => c.tokens),
      capacity,
    );
    const rows = chunkRows(cells, GRID_COLS);
    return rows.map((row) =>
      row
        .map((cell) => {
          if (cell.kind === 'free') return th.fg(FREE_COLOR, GLYPH_FREE);
          const glyph = cell.kind === 'partial' ? GLYPH_PARTIAL : GLYPH_USED;
          const color = colorForIndex(cell.childIndex ?? 0);
          const painted = th.fg(color, glyph);
          return cell.childIndex === this.nav.sel ? th.bold(painted) : painted;
        })
        .join(' '),
    );
  }

  // ── legend / info column ──────────────────────────────────────────────────

  private get hasReal(): boolean {
    return this.breakdown.realTokens !== null && this.breakdown.realTokens > 0;
  }

  /** Fixed header lines for the info column (not scrolled). */
  private infoHeader(): string[] {
    const th = this.theme;
    const b = this.breakdown;
    const node = currentNode(b.root, this.nav);
    const lines: string[] = [];

    if (atRoot(this.nav)) {
      const model = b.modelId ? `${b.modelId}${b.provider ? `  (${b.provider})` : ''}` : 'unknown model';
      lines.push(th.fg('toolTitle', th.bold(model)));
      if (this.hasReal) {
        const real = b.realTokens!;
        lines.push(
          th.fg(
            'muted',
            `${formatTokens(real)} / ${formatTokens(b.contextWindow)} tokens (${formatPercent(real, b.contextWindow)})`,
          ),
        );
      } else {
        lines.push(
          th.fg('muted', `~${formatTokens(b.estimatedUsed)} / ${formatTokens(b.contextWindow)} tokens (est.)`),
        );
      }
      lines.push('');
      lines.push(th.fg('dim', 'Estimated usage by category'));
    } else {
      lines.push(th.fg('toolTitle', th.bold(node.label)));
      lines.push(th.fg('muted', formatAbsoluteShare(node.tokens, b.contextWindow)));
      if (node.detail) lines.push(th.fg('dim', node.detail));
      lines.push('');
    }
    return lines;
  }

  /** One rendered legend row for a child at index `i`. */
  private legendRow(child: CategoryNode, i: number, total: number): string {
    const th = this.theme;
    const selected = i === this.nav.sel;
    const marker = th.fg(colorForIndex(i), GLYPH_USED);
    const cursor = selected ? th.fg('accent', '›') : ' ';
    const labelText = `${child.label}  ${formatTokens(child.tokens)}  ${formatPercent(child.tokens, total)}`;
    const label = selected ? th.fg('text', th.bold(labelText)) : th.fg('muted', labelText);
    const actionable = Boolean(child.children?.length) || Boolean(child.content?.length);
    const drillable = actionable ? th.fg('dim', ' ›') : '';
    return `${cursor} ${marker} ${label}${drillable}`;
  }

  /** Full info column: header + scrolled legend slice + (root) free-space row.
   * `maxRows` bounds the whole column to the terminal so the tree never
   * overflows the viewport (the legend scrolls within its share). */
  private infoColumn(maxRows: number): string[] {
    const th = this.theme;
    const b = this.breakdown;
    const node = currentNode(b.root, this.nav);
    const children = node.children ?? [];
    const total = atRoot(this.nav) ? b.contextWindow : node.tokens;

    const header = this.infoHeader();
    const freeRows = atRoot(this.nav) ? 1 : 0;
    // Reserve two rows for the up/down "more" indicators so the column height
    // is stable regardless of the scroll offset.
    const legendBudget = Math.max(3, maxRows - header.length - freeRows - 2);
    const legend: string[] = [];
    const win = scrollWindow(children.length, this.nav.sel, legendBudget);
    if (win.start > 0) legend.push(th.fg('dim', `  ↑ ${win.start} more`));
    for (let i = win.start; i < win.end; i++) legend.push(this.legendRow(children[i], i, total));
    if (win.end < children.length) legend.push(th.fg('dim', `  ↓ ${children.length - win.end} more`));

    if (atRoot(this.nav)) {
      const free = Math.max(0, b.contextWindow - childrenTotal(b.root));
      const freeText = `Free space  ${formatTokens(free)}  ${formatPercent(free, b.contextWindow)}`;
      legend.push(`  ${th.fg(FREE_COLOR, GLYPH_FREE)} ${th.fg('dim', freeText)}`);
    }
    return [...header, ...legend];
  }

  // ── reconciliation panel ───────────────────────────────────────────────────

  private renderRecon(width: number): string[] {
    const th = this.theme;
    const b = this.breakdown;
    const lines: string[] = [];
    lines.push(truncateToWidth(formatHeaderRule('Context reconciliation', undefined, width, th), width));
    lines.push('');
    const row = (label: string, value: string): void => {
      lines.push(`  ${th.fg('muted', label.padEnd(22))} ${th.fg('text', value)}`);
    };
    row('Context window', formatTokens(b.contextWindow));
    row(
      'Real (provider)',
      this.hasReal ? `${formatTokens(b.realTokens!)} (${formatPercent(b.realTokens!, b.contextWindow)})` : 'unknown',
    );
    row('Estimated (Σ cats)', `${formatTokens(b.estimatedUsed)} (${formatPercent(b.estimatedUsed, b.contextWindow)})`);
    if (this.hasReal) {
      const delta = b.estimatedUsed - b.realTokens!;
      const sign = delta >= 0 ? '+' : '−';
      row('Estimate − real', `${sign}${formatTokens(Math.abs(delta))}`);
    } else {
      lines.push(`  ${th.fg('dim', 'No provider usage yet (fresh session or right after compaction).')}`);
      lines.push(`  ${th.fg('dim', 'The estimate above excludes system prompt + tool schemas in that case.')}`);
    }
    lines.push('');
    if (b.lastUsage) {
      lines.push(`  ${th.fg('dim', 'Last assistant turn (provider usage):')}`);
      const u = b.lastUsage;
      row('  input', formatTokens(u.input));
      row('  cache read', formatTokens(u.cacheRead));
      row('  cache write', formatTokens(u.cacheWrite));
      row('  output', formatTokens(u.output));
      const ratio = cacheHitRatioPct({ input: u.input, cacheRead: u.cacheRead });
      if (ratio !== null) row('  cache-hit ratio', `${ratio}%`);
    } else {
      lines.push(`  ${th.fg('dim', 'No assistant turn with provider usage in context yet.')}`);
    }
    lines.push('');
    lines.push(`  ${th.fg('dim', 'Per-category numbers are chars/4 estimates; the provider total is authoritative.')}`);
    lines.push('');
    lines.push(this.footer(width));
    return lines.map((l) => truncateToWidth(l, width));
  }

  // ── full tree view ─────────────────────────────────────────────────────────

  private renderTree(width: number): string[] {
    const th = this.theme;
    const crumb = formatBreadcrumb(breadcrumbLabels(this.breakdown.root, this.nav.path));
    const header = truncateToWidth(formatHeaderRule(crumb, undefined, width, th), width);

    const grid = this.gridLines();
    const viewportRows = this.viewportRows();
    // Tree chrome: header + blank (after header) + blank (before footer) +
    // footer = 4 rows. In stacked mode the grid + its trailing blank sit above
    // the info column too, so subtract those from the info column's budget.
    const maxInfoRows =
      width < STACK_BELOW ? Math.max(3, viewportRows - 4 - grid.length - 1) : Math.max(3, viewportRows - 4);
    const info = this.infoColumn(maxInfoRows);

    const out: string[] = [header, ''];

    if (width < STACK_BELOW) {
      // Narrow terminal: stack grid above legend.
      for (const g of grid) out.push(truncateToWidth(`  ${g}`, width));
      out.push('');
      for (const i of info) out.push(truncateToWidth(`  ${i}`, width));
    } else {
      const rowCount = Math.max(grid.length, info.length);
      const leftPad = '  ';
      const infoStart = leftPad.length + GRID_WIDTH + COL_GAP;
      for (let r = 0; r < rowCount; r++) {
        const left = grid[r] ?? '';
        const right = info[r] ?? '';
        const leftPlain = `${leftPad}${left}`;
        const pad = Math.max(0, infoStart - visibleWidth(leftPlain));
        out.push(truncateToWidth(`${leftPlain}${' '.repeat(pad)}${right}`, width));
      }
    }

    out.push('');
    out.push(this.footer(width));
    return out;
  }

  private footer(width: number): string {
    const th = this.theme;
    if (this.status) {
      const status = th.fg('warning', this.status);
      return truncateToWidth(`  ${status}`, width);
    }
    const hints = atRoot(this.nav)
      ? '↑/↓ select · ⏎ drill/view · c compact · r refresh · t recon · e export · q close'
      : '↑/↓ select · ⏎ drill/view · ← back · c compact · r refresh · t recon · e export · q close';
    return truncateToWidth(`  ${th.fg('dim', hints)}`, width);
  }
}
