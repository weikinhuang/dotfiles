/**
 * `/agents` overlay components for the subagent extension
 * (config/pi/extensions/subagent.ts).
 *
 * Lives under `ext/` because it imports `@earendil-works/pi-tui` (`matchesKey`,
 * `truncateToWidth`, the `TUI` / `Component`) and the `Theme` - the home for
 * pi-coupled UI glue extracted to shrink the extension shell. The viewport
 * windowing math is shared with the other overlays via
 * [`overlay-window.ts`](./overlay-window.ts); the pure agent-list / running-child
 * formatting lives in the pi-free `../subagent/format.ts`.
 *
 * `RunningOverlayEntry` and `RUNNING_TICK_MS` are exported because the
 * extension's `/agents running` command handler builds the entry list and
 * drives the refresh ticker with them.
 */

import { type Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';

import { assembleWindowedBody, overlayViewportRows } from './overlay-window.ts';
import { tailJsonl, type ActivityRing } from '../subagent/activity.ts';
import {
  formatAgentListRowDescription,
  formatAgentPreview,
  formatRunningChildRow,
  type AgentPreviewSource,
  type SubagentRunSnapshot,
} from '../subagent/format.ts';
import { collapseWhitespace } from '../shared.ts';
import { formatHeaderRule } from '../tui-rule.ts';

/**
 * Loaded-list overlay rendered by `/agents`. Two horizontal rules
 * separate a row list (top) from a preview block (bottom); selection
 * is driven by the arrow keys, escape closes.
 */
export class AgentsLoadedOverlay implements Component {
  private agents: AgentPreviewSource[];
  private selected = 0;
  /** Agent-list scroll offset (rows are one line each); selection-driven. */
  private scrollTop = 0;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  constructor(
    agents: AgentPreviewSource[],
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly onClose: () => void,
  ) {
    this.agents = agents;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.onClose();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.move(1);
      return;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private move(delta: number): void {
    if (this.agents.length === 0) return;
    this.selected = Math.max(0, Math.min(this.agents.length - 1, this.selected + delta));
    this.invalidate();
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
    const th = this.theme;

    const count = this.agents.length;
    const chip = count > 0 ? `${count} agent${count === 1 ? '' : 's'}` : undefined;
    const header = ['', truncateToWidth(formatHeaderRule('Loaded sub-agents', chip, width, th), width), ''];

    if (count === 0) {
      const lines = [
        ...header,
        truncateToWidth(
          `  ${th.fg('dim', 'No agents loaded. Drop Markdown definitions into <piAgentDir>/agents/.')}`,
          width,
        ),
        '',
        truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width),
        '',
      ];
      this.cachedWidth = width;
      this.cachedRows = rows;
      this.cachedLines = lines;
      return lines;
    }

    if (this.selected >= count) this.selected = count - 1;

    // Body (scrollable): one row per agent.
    const maxName = this.agents.reduce((m, a) => Math.max(m, a.name.length), 0);
    const sourcePad = '[global] '.length; // widest tag with trailing space
    const body: string[] = [];
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const marker = i === this.selected ? th.fg('accent', '>') : ' ';
      const namePad = ' '.repeat(Math.max(1, maxName + 2 - a.name.length));
      const sourceTag = `[${a.source}]`;
      const sourceSeg = th.fg('muted', sourceTag + ' '.repeat(Math.max(1, sourcePad - sourceTag.length)));
      const desc = formatAgentListRowDescription(a.description);
      const styled = i === this.selected ? th.fg('text', a.name) : th.fg('dim', a.name);
      body.push(truncateToWidth(`  ${marker} ${styled}${namePad}${sourceSeg} ${th.fg('dim', desc)}`, width));
    }

    // Footer (pinned): preview of the highlighted agent + key hints.
    const selected = this.agents[this.selected];
    const footer: string[] = [
      '',
      truncateToWidth(formatHeaderRule(`${selected.name}  [${selected.source}]`, undefined, width, th), width),
      '',
    ];
    for (const previewLine of formatAgentPreview(selected)) {
      // First line is the path (dim); the rest of the body is text-tone.
      const styled = previewLine.startsWith('/') ? th.fg('dim', previewLine) : th.fg('text', previewLine);
      footer.push(truncateToWidth(`  ${styled}`, width));
    }
    footer.push('');
    footer.push(truncateToWidth(`  ${th.fg('dim', '↑/↓ move · Press Escape to close')}`, width));
    footer.push('');

    const win = assembleWindowedBody({
      header,
      body,
      footer,
      width,
      viewportRows: overlayViewportRows(rows),
      scrollTop: this.scrollTop,
      theme: th,
      keepStart: this.selected,
      keepEnd: this.selected + 1,
    });
    this.scrollTop = win.scrollTop;

    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = win.lines;
    return win.lines;
  }
}

/**
 * Running-children overlay rendered by `/agents running`. Live tick
 * every 1 s; each row block lays out handle, agent, state, elapsed,
 * `turn N/max`, token line, ctx bar, model, and (optional) tool counts.
 * Below the row list, a preview block summarises the highlighted child
 * + renders the bounded activity-tail ring.
 */
export interface RunningOverlayEntry {
  handle: string;
  agent: string;
  agentSource?: 'global' | 'user' | 'project';
  task: string;
  snapshot: SubagentRunSnapshot;
  startedAt: number;
  /** Wall-clock millis of the last `pushStatus` call. */
  lastUpdateMs: number;
  /** True while the entry is live; false for terminal children. */
  running: boolean;
  /** Path to the child's JSONL transcript on disk (for the disk-tail fallback). */
  sessionFile: string | undefined;
}

export const RUNNING_TICK_MS = 1000;

function fmtDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function capLine(s: string, cap: number): string {
  const collapsed = collapseWhitespace(s);
  if (collapsed.length <= cap) return collapsed;
  return `${collapsed.slice(0, cap - 1).trimEnd()}…`;
}

export class AgentsRunningOverlay implements Component {
  private selected = 0;
  /** Child-list scroll offset (entries are multi-line blocks); selection-driven. */
  private scrollTop = 0;
  /** `f` toggles freeze for the highlighted child's activity tail. */
  private frozenHandles = new Set<string>();
  /** Cached width / lines so static frames don't redraw on every tick. */
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly getEntries: () => RunningOverlayEntry[],
    private readonly rings: Map<string, ActivityRing>,
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.onClose();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.move(1);
      return;
    }
    if (data === 'f') {
      this.toggleFreeze();
      return;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private move(delta: number): void {
    const entries = this.getEntries();
    if (entries.length === 0) return;
    this.selected = Math.max(0, Math.min(entries.length - 1, this.selected + delta));
    this.invalidate();
  }

  private toggleFreeze(): void {
    const entries = this.getEntries();
    if (entries.length === 0) return;
    const handle = entries[Math.min(this.selected, entries.length - 1)].handle;
    const ring = this.rings.get(handle);
    if (!ring) return;
    if (this.frozenHandles.has(handle)) {
      this.frozenHandles.delete(handle);
      ring.resume();
    } else {
      this.frozenHandles.add(handle);
      ring.freeze();
    }
    this.invalidate();
  }

  render(width: number): string[] {
    // We cannot cache by width alone because the live tick changes the
    // payload. Each render rebuilds; the overlay sits behind a 1 s
    // request-render tick so cost is negligible.
    void this.cachedWidth;
    void this.cachedLines;

    const th = this.theme;
    const entries = this.getEntries();
    const now = Date.now();

    const chip = entries.length === 0 ? '0 active' : `${entries.length} active · ${RUNNING_TICK_MS}ms`;
    const header = ['', truncateToWidth(formatHeaderRule('Running sub-agents', chip, width, th), width), ''];

    if (entries.length === 0) {
      return [
        ...header,
        truncateToWidth(`  ${th.fg('dim', 'No background sub-agents running.')}`, width),
        '',
        truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width),
        '',
      ];
    }

    if (this.selected >= entries.length) this.selected = entries.length - 1;

    // Body (scrollable): each entry is a multi-line block. Track the selected
    // block's line range so windowing keeps it in view.
    const body: string[] = [];
    let selStart = 0;
    let selEnd = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const marker = i === this.selected ? th.fg('accent', '>') : ' ';
      const rowLines = formatRunningChildRow({ handle: e.handle, snapshot: e.snapshot, startedAt: e.startedAt }, now, {
        width,
      });
      if (i === this.selected) selStart = body.length;
      body.push(truncateToWidth(`  ${marker} ${th.fg('text', rowLines[0])}`, width));
      for (let j = 1; j < rowLines.length; j++) {
        body.push(truncateToWidth(`    ${th.fg('dim', rowLines[j])}`, width));
      }
      if (i === this.selected) selEnd = body.length;
    }

    // Footer (pinned): detail + activity tail for the highlighted child.
    const sel = entries[this.selected];
    const footer: string[] = [
      '',
      truncateToWidth(formatHeaderRule(`${sel.handle}  ${sel.agent}`, undefined, width, th), width),
      '',
    ];
    if (sel.task) {
      const taskWrap = capLine(sel.task, Math.max(40, width - 14));
      footer.push(truncateToWidth(`  ${th.fg('muted', 'task    ')}${th.fg('text', taskWrap)}`, width));
    }
    const spawnedAgo = fmtDurationShort(Math.max(0, now - sel.startedAt));
    const updateAgo = fmtDurationShort(Math.max(0, now - sel.lastUpdateMs));
    footer.push(
      truncateToWidth(
        `  ${th.fg('muted', 'spawned ')}${spawnedAgo} ago${' '.repeat(4)}${th.fg('muted', 'last update ')}${updateAgo} ago`,
        width,
      ),
    );

    // Activity tail (bounded): shrinks on short terminals so the child list
    // keeps a few rows on screen.
    const ring = this.rings.get(sel.handle);
    const frozen = this.frozenHandles.has(sel.handle);
    const live = sel.running && !frozen;
    const tailChip = frozen ? 'tail · frozen' : sel.running ? `tail · ${RUNNING_TICK_MS}ms · live` : 'tail · final';
    footer.push('');
    footer.push(truncateToWidth(formatHeaderRule('activity', tailChip, width, th), width));
    footer.push('');
    const viewportRows = overlayViewportRows(this.tui.terminal.rows);
    const tailBudget = Math.max(3, Math.min(12, viewportRows - 16));
    const tailLines = ring ? ring.snapshot() : sel.sessionFile ? tailJsonl(sel.sessionFile, { maxLines: 32 }) : [];
    if (tailLines.length === 0) {
      footer.push(truncateToWidth(`  ${th.fg('dim', '(no activity yet)')}`, width));
    } else {
      for (const tl of tailLines.slice(-tailBudget)) {
        footer.push(truncateToWidth(`  ${th.fg('dim', tl)}`, width));
      }
    }

    footer.push('');
    footer.push(truncateToWidth(`  ${th.fg('dim', '↑/↓ move · f freeze tail · Press Escape to close')}`, width));
    footer.push('');
    void live;

    const win = assembleWindowedBody({
      header,
      body,
      footer,
      width,
      viewportRows,
      scrollTop: this.scrollTop,
      theme: th,
      keepStart: selStart,
      keepEnd: selEnd,
    });
    this.scrollTop = win.scrollTop;
    return win.lines;
  }
}
