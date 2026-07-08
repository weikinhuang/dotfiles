/**
 * `BgBashOverlay` - the interactive `/bg-bash` overlay component for the
 * bg-bash extension (config/pi/extensions/bg-bash.ts).
 *
 * Lives under `ext/` because it imports `@earendil-works/pi-tui` (`Component`,
 * `matchesKey`, `truncateToWidth`, the `TUI`) and the pi runtime `Theme` /
 * `ThemeColor` - the home for pi-coupled UI glue extracted to shrink the
 * extension shell. The viewport windowing math is shared with the other
 * overlays via [`overlay-window.ts`](./overlay-window.ts); the pure job-row /
 * log-tail formatting lives in the pi-free `../bg-bash-format.ts`.
 *
 * `glyphColor` is exported because the extension's own `renderJobHeader` /
 * inline `renderResult` paths share the themed status-glyph colour with the
 * overlay.
 */

import { type Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { type Component, matchesKey, truncateToWidth, type TUI } from '@earendil-works/pi-tui';

import { assembleWindowedBody, overlayViewportRows } from './overlay-window.ts';
import { type BgBashState, type JobSummary } from '../bg-bash-reducer.ts';
import { formatJobRow, formatLogTailExitHeader, formatLogTailHeader, tailLines } from '../bg-bash-format.ts';
import { type BgBashStreamSet, mergeBgBashStreams } from '../bg-bash-stream.ts';
import { type SignalName } from '../bg-bash/signals.ts';
import { truncate } from '../shared.ts';
import { formatHeaderRule } from '../tui-rule.ts';

const OVERLAY_TAIL_LINES = 8;

/** Themed status-glyph colour for a job. Shared by the overlay job rows
 * and the extension's `renderJobHeader`, so the lead glyph stays visually
 * consistent across the inline card and the overlay. */
export function glyphColor(job: JobSummary, opts: { timedOut?: boolean }): ThemeColor {
  if (opts.timedOut) return 'warning';
  switch (job.status) {
    case 'running':
      return 'warning';
    case 'exited':
      return (job.exitCode ?? 0) === 0 ? 'success' : 'error';
    case 'signaled':
      return 'warning';
    case 'error':
      return 'error';
    case 'terminated':
      return 'muted';
  }
}

export interface OverlayDeps {
  getState: () => BgBashState;
  getLive: (id: string) => BgBashStreamSet | undefined;
  onSignal: (id: string, sig: SignalName) => void;
  onRemove: (id: string) => void;
  onClearTerminal: () => void;
}

export class BgBashOverlay implements Component {
  private selected = 0;
  /** Job-list scroll offset (job rows are one line each); selection-driven. */
  private scrollTop = 0;
  /** Per-job freeze state; toggled by `f`. */
  private readonly frozenHandles = new Set<string>();

  constructor(
    private readonly deps: OverlayDeps,
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
    if (data === 'k') {
      this.signalSelected('SIGTERM');
      return;
    }
    if (data === 'K') {
      this.signalSelected('SIGKILL');
      return;
    }
    if (data === 'r') {
      this.removeSelected();
      return;
    }
    if (data === 'c') {
      this.deps.onClearTerminal();
      return;
    }
  }

  invalidate(): void {
    /* no-op: render rebuilds on every tick so live byte counts stay fresh */
  }

  private jobs(): JobSummary[] {
    return this.deps.getState().jobs;
  }

  private move(delta: number): void {
    const jobs = this.jobs();
    if (jobs.length === 0) return;
    this.selected = Math.max(0, Math.min(jobs.length - 1, this.selected + delta));
  }

  private currentJob(): JobSummary | undefined {
    const jobs = this.jobs();
    if (jobs.length === 0) return undefined;
    if (this.selected >= jobs.length) this.selected = jobs.length - 1;
    return jobs[this.selected];
  }

  private toggleFreeze(): void {
    const job = this.currentJob();
    if (!job) return;
    if (this.frozenHandles.has(job.id)) this.frozenHandles.delete(job.id);
    else this.frozenHandles.add(job.id);
  }

  private signalSelected(sig: SignalName): void {
    const job = this.currentJob();
    if (job?.status !== 'running') return;
    this.deps.onSignal(job.id, sig);
  }

  private removeSelected(): void {
    const job = this.currentJob();
    if (!job || job.status === 'running') return;
    this.deps.onRemove(job.id);
  }

  render(width: number): string[] {
    const th = this.theme;
    const jobs = this.jobs();
    const now = Date.now();

    const runningCount = jobs.filter((j) => j.status === 'running' || j.status === 'signaled').length;
    let chip: string | undefined;
    if (jobs.length === 0) chip = '0 jobs';
    else if (runningCount > 0) chip = `${jobs.length} jobs · ${runningCount} running`;
    else chip = `${jobs.length} jobs`;
    const header = ['', truncateToWidth(formatHeaderRule('Background jobs', chip, width, th), width), ''];

    if (jobs.length === 0) {
      return [
        ...header,
        truncateToWidth(`  ${th.fg('dim', '(no background jobs)')}`, width),
        '',
        truncateToWidth(`  ${th.fg('dim', 'Press Escape to close')}`, width),
        '',
      ];
    }

    if (this.selected >= jobs.length) this.selected = jobs.length - 1;

    // Top section (scrollable body): structured job rows with right-padded
    // phrase / dur / bytes columns so the cmd column lines up across rows.
    const rows = jobs.map((j) => formatJobRow(j, now, { width: Math.max(40, width - 4) }));
    const phraseWidth = Math.max(...rows.map((r) => r.statusPhrase.length));
    const durWidth = Math.max(...rows.map((r) => r.duration.length));
    const bytesWidth = Math.max(...rows.map((r) => r.bytes.length));
    const idWidth = Math.max(...rows.map((r) => r.id.length));
    const jobLines: string[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const r = rows[i];
      const marker = i === this.selected ? th.fg('accent', '>') : ' ';
      const glyphColored = th.fg(glyphColor(j, {}), r.statusGlyph);
      const line =
        `  ${marker} ${th.fg('toolTitle', th.bold(r.id.padEnd(idWidth)))} ${glyphColored} ` +
        `${th.fg('muted', r.statusPhrase.padEnd(phraseWidth))}   ` +
        `${th.fg('dim', r.duration.padEnd(durWidth))}   ` +
        `${th.fg('dim', r.bytes.padEnd(bytesWidth))}   ` +
        `${th.fg('text', r.cmd)}`;
      jobLines.push(truncateToWidth(line, width));
    }

    // Lower block (pinned footer): mid-rule + log tail for the highlighted job
    // + key hints. The tail budget shrinks on short terminals so the job list
    // always keeps a few visible rows.
    const sel = jobs[this.selected];
    const live = this.deps.getLive(sel.id);
    const followDefault = sel.status === 'running' || sel.status === 'signaled';
    const frozen = this.frozenHandles.has(sel.id);
    const following = followDefault && !frozen;
    const midTitle = `[${sel.id}] ${truncate(sel.command.replace(/\s+/g, ' '), Math.max(20, width - 60))}`;
    const midChip = followDefault
      ? formatLogTailHeader(sel, { stdoutBytes: sel.stdoutBytes, stderrBytes: sel.stderrBytes, following })
      : formatLogTailExitHeader(sel);

    const viewportRows = overlayViewportRows(this.tui.terminal.rows);
    // Reserve room for the job list: header(3) + mid-rule block(3) + help(2) +
    // a few job rows. What's left (capped at OVERLAY_TAIL_LINES) is the tail.
    const tailBudget = Math.max(1, Math.min(OVERLAY_TAIL_LINES, viewportRows - 14));

    const footer: string[] = ['', truncateToWidth(formatHeaderRule(midTitle, midChip, width, th), width), ''];
    if (live) {
      const merged = mergeBgBashStreams(live, 'merged');
      const tail = tailLines(merged, tailBudget).trimEnd();
      if (!tail) {
        footer.push(truncateToWidth(`  ${th.fg('dim', '(no output yet)')}`, width));
      } else {
        const tailRows = tail.split('\n');
        for (const row of tailRows) {
          footer.push(truncateToWidth(`  ${th.fg('toolOutput', row)}`, width));
        }
        // Hint to expand if there's clearly more than the visible tail.
        const totalLines = merged ? merged.split('\n').length : 0;
        if (totalLines > tailRows.length) {
          const moreCount = totalLines - tailRows.length;
          footer.push(
            truncateToWidth(`  ${th.fg('dim', `… ${moreCount} more lines (bg_bash logs ${sel.id})`)}`, width),
          );
        }
      }
    } else if (sel.logFile) {
      footer.push(truncateToWidth(`  ${th.fg('dim', `(no in-memory buffer; see ${sel.logFile})`)}`, width));
    } else {
      footer.push(truncateToWidth(`  ${th.fg('dim', '(no logs available)')}`, width));
    }

    // Footer hint: keys vary based on whether the highlighted job is
    // live or terminal so we don't advertise actions that would no-op.
    const helpParts = ['↑/↓ move'];
    if (followDefault) {
      helpParts.push(frozen ? 'f follow' : 'f freeze');
      helpParts.push('k SIGTERM', 'K SIGKILL');
    } else {
      helpParts.push('r remove');
    }
    helpParts.push('c clear terminal');
    helpParts.push('Press Escape to close');
    footer.push('');
    footer.push(truncateToWidth(`  ${th.fg('dim', helpParts.join(' · '))}`, width));
    footer.push('');

    // Window the job list to whatever height is left, keeping the selected
    // job in view; the lower block stays pinned.
    const win = assembleWindowedBody({
      header,
      body: jobLines,
      footer,
      width,
      viewportRows,
      scrollTop: this.scrollTop,
      theme: th,
      keepStart: this.selected,
      keepEnd: this.selected + 1,
    });
    this.scrollTop = win.scrollTop;
    return win.lines;
  }
}
