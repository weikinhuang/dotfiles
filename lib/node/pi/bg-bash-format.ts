/**
 * Pretty-print + overlay formatters for the bg-bash extension.
 *
 * Split out of `bg-bash-reducer.ts` so the reducer file is just state
 * + branch reduction + action helpers, and the rendering layer (LLM
 * tool-content lines, inline cards, `/bg-bash` overlay rows, log-tail
 * mid-rule chips) is a separate concern. Same pi-free contract as the
 * reducer: composes only `truncate` + reducer-shape types.
 */

import { type BgBashState, type JobStatus, type JobSummary } from './bg-bash-reducer.ts';
import { truncate } from './shared.ts';

const STATUS_ICON: Record<JobStatus, string> = {
  running: '●',
  exited: '✓',
  signaled: '✗',
  error: '✗',
  terminated: '◌',
};

export function statusIcon(status: JobStatus): string {
  return STATUS_ICON[status] ?? '?';
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

export function tailLines(s: string, n: number): string {
  if (n <= 0 || !s) return '';
  const lines = s.split('\n');
  const hasTrailingNewline = lines[lines.length - 1] === '';
  const effective = hasTrailingNewline ? lines.slice(0, -1) : lines;
  const start = Math.max(0, effective.length - n);
  return effective.slice(start).join('\n') + (hasTrailingNewline ? '\n' : '');
}

export function tailN(s: string, n: number): string {
  return tailLines(s, n);
}

export function clampBytes(s: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return s;
  const encoded = Buffer.byteLength(s, 'utf8');
  if (encoded <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  const kept = buf.subarray(buf.length - maxBytes);
  return `… [${encoded - maxBytes}B truncated; see logFile] …\n${kept.toString('utf8')}`;
}

/**
 * One-line summary of a job suitable for the LLM. Same string used by
 * `list`, the prompt injection, and the tool's fallback content.
 */
export function formatJobLine(job: JobSummary, now: number): string {
  const ended = job.endedAt ?? now;
  const dur = formatDuration(ended - job.startedAt);
  const label = job.label ? ` ${job.label}` : '';
  const cmd = truncate(job.command.replace(/\s+/g, ' '), 80);
  const bytes = formatBytes(job.stdoutBytes + job.stderrBytes);
  const head = `[${job.id}]${label} ${statusIcon(job.status)} ${cmd}`;
  switch (job.status) {
    case 'running':
      return `${head} - running ${dur}, ${bytes}`;
    case 'exited':
      return `${head} - exited ${job.exitCode ?? '?'} after ${dur}, ${bytes}`;
    case 'signaled':
      return `${head} - ${job.signal ?? 'signal'} after ${dur}, ${bytes}`;
    case 'error':
      return `${head} - error: ${job.error ?? 'unknown'}`;
    case 'terminated':
      return `${head} - terminated (pi session ended), ran ${dur}, ${bytes}`;
  }
}

export function formatState(state: BgBashState, now: number): string {
  if (state.jobs.length === 0) return '(no background jobs)';
  return state.jobs.map((j) => formatJobLine(j, now)).join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Overlay / inline-card formatters used by the bg-bash extension's
// `renderResult` and the `/bg-bash` overlay. Kept here so the strings
// match across surfaces and can be vitest-tested without the pi runtime.
// ──────────────────────────────────────────────────────────────────────

/**
 * Status glyph for the inline `renderResult` header. Distinguishes
 * non-zero exit codes (`✗`) from clean exits (`✓`) and uses `⚠` for
 * signaled jobs so it's not confused with a non-zero exit. `⌛` is used
 * when the caller passes `timedOut: true` to indicate that the wait
 * action timed out before the (still-running) job finished.
 */
function headerGlyph(job: JobSummary, opts: { timedOut?: boolean }): string {
  if (opts.timedOut) return '⌛';
  switch (job.status) {
    case 'running':
      return '●';
    case 'exited':
      return (job.exitCode ?? 0) === 0 ? '✓' : '✗';
    case 'signaled':
      return '⚠';
    case 'error':
      return '✗';
    case 'terminated':
      return '◌';
  }
}

/**
 * Status phrase for the inline `renderResult` header. Combines lifecycle
 * state with duration / exit metadata in a single segment so the header
 * has a stable column layout.
 */
function headerStatusPhrase(job: JobSummary, now: number, opts: { timedOut?: boolean }): string {
  const ended = job.endedAt ?? now;
  const dur = formatDuration(ended - job.startedAt);
  if (opts.timedOut) {
    const runDur = formatDuration(now - job.startedAt);
    return `still running ${runDur}`;
  }
  switch (job.status) {
    case 'running':
      return `running ${dur}`;
    case 'exited':
      return `exit ${job.exitCode ?? '?'} in ${dur}`;
    case 'signaled':
      return `${job.signal ?? 'signal'} after ${dur}`;
    case 'error':
      return `error: ${job.error ?? 'unknown'}`;
    case 'terminated':
      return `terminated, ran ${dur}`;
  }
}

/**
 * Compact bytes summary: `stdout X / stderr Y` when both streams have
 * data, otherwise just the single combined total (avoids the noise of
 * `… / stderr 0B` on stdout-only commands).
 */
function bytesSummary(job: JobSummary): string {
  const total = job.stdoutBytes + job.stderrBytes;
  if (job.stderrBytes > 0 && job.stdoutBytes > 0) {
    return `stdout ${formatBytes(job.stdoutBytes)} / stderr ${formatBytes(job.stderrBytes)}`;
  }
  return formatBytes(total);
}

/**
 * Stable single-line header used by the bg_bash inline cards
 * (`start` is special-cased upstream because its glyph and phrase are
 * action-specific; this covers `logs` / `wait` / `status` / overlay rows).
 *
 * Shape: `<glyph> [<id>]<labelMaybe>  <cmd>   <status-phrase>   <bytes>`
 */
export function formatJobHeader(job: JobSummary, now: number, opts: { timedOut?: boolean } = {}): string {
  const glyph = headerGlyph(job, opts);
  const phrase = headerStatusPhrase(job, now, opts);
  const bytes = bytesSummary(job);
  const cmd = truncate(job.command.replace(/\s+/g, ' '), 80);
  const label = job.label ? ` ${job.label}` : '';
  return `${glyph} [${job.id}]${label}  ${cmd}   ${phrase}   ${bytes}`;
}

/**
 * Structured columns for one job row in the `/bg-bash` overlay.
 *
 * The overlay composes the row by joining the columns with padding so
 * the duration / bytes columns align. `cmd` is truncated to fit the
 * remaining width once the other columns are reserved.
 */
export interface JobRow {
  id: string;
  statusGlyph: string;
  statusPhrase: string;
  duration: string;
  bytes: string;
  cmd: string;
}

const ROW_FIXED_COLS = 1 /* marker */ + 1 /* space */ + 1 /* glyph */ + 3 /* spaces */;

export function formatJobRow(job: JobSummary, now: number, opts: { width?: number } = {}): JobRow {
  const ended = job.endedAt ?? now;
  const dur = formatDuration(ended - job.startedAt);
  const totalBytes = job.stdoutBytes + job.stderrBytes;
  const phrase: string =
    job.status === 'running'
      ? 'running'
      : job.status === 'exited'
        ? `exited ${job.exitCode ?? '?'}`
        : job.status === 'signaled'
          ? (job.signal ?? 'signal')
          : job.status === 'error'
            ? 'error'
            : 'terminated';
  const id = `[${job.id}]`;
  const glyph = headerGlyph(job, {});
  const width = opts.width ?? 80;
  // Leave room for marker + glyph + id + phrase + duration + bytes
  // and 5 inter-column spaces (2 per gap). Anything beyond that gets
  // truncated. Floor at 12 so very narrow widths still show *some* cmd.
  const reserved = ROW_FIXED_COLS + id.length + phrase.length + dur.length + formatBytes(totalBytes).length + 4 * 3;
  const cmdCap = Math.max(12, width - reserved);
  const cmd = truncate(job.command.replace(/\s+/g, ' '), cmdCap);
  return { id, statusGlyph: glyph, statusPhrase: phrase, duration: dur, bytes: formatBytes(totalBytes), cmd };
}

/**
 * Chip text for the overlay's log-tail mid-rule when the highlighted
 * job is still live (the mid-rule reads `─── [<id>] <cmd> ─── <chip> ─`).
 * `following=true` adds a `· follow` segment so the user can tell at a
 * glance whether the tail is auto-scrolling.
 */
export function formatLogTailHeader(
  job: JobSummary,
  opts: { stdoutBytes: number; stderrBytes: number; following: boolean },
): string {
  const stdoutPart = `stdout ${formatBytes(opts.stdoutBytes)}`;
  const stderrPart = `stderr ${formatBytes(opts.stderrBytes)}`;
  const segs: string[] = [];
  if (job.pid !== undefined) segs.push(`pid ${job.pid}`);
  segs.push(`${stdoutPart} / ${stderrPart}`);
  if (opts.following) segs.push('follow');
  return segs.join(' · ');
}

/**
 * Chip text for the overlay's log-tail mid-rule when the highlighted
 * job has exited. Shows the exit phrase, total bytes, and the path of
 * the on-disk log so the user can `tail -f` it outside pi.
 */
export function formatLogTailExitHeader(job: JobSummary, opts: { logPath?: string } = {}): string {
  const ended = job.endedAt ?? job.startedAt;
  const dur = formatDuration(ended - job.startedAt);
  let exitPhrase: string;
  switch (job.status) {
    case 'exited':
      exitPhrase = `exit ${job.exitCode ?? '?'} in ${dur}`;
      break;
    case 'signaled':
      exitPhrase = `${job.signal ?? 'signal'} after ${dur}`;
      break;
    case 'error':
      exitPhrase = `error: ${job.error ?? 'unknown'}`;
      break;
    case 'terminated':
      exitPhrase = `terminated, ran ${dur}`;
      break;
    case 'running':
      // Caller should have used `formatLogTailHeader`; fall back gracefully.
      exitPhrase = `running ${dur}`;
      break;
  }
  const totalBytes = formatBytes(job.stdoutBytes + job.stderrBytes);
  const segs = [exitPhrase, totalBytes];
  const path = opts.logPath ?? job.logFile;
  if (path) segs.push(`log ${path}`);
  return segs.join(' · ');
}

/**
 * Split jobs into running / recent buckets. "Recent" is every terminal
 * job sorted newest-first, optionally capped.
 */
export function partitionJobs(
  state: BgBashState,
  opts: { recentCap?: number } = {},
): { running: JobSummary[]; recent: JobSummary[] } {
  const running: JobSummary[] = [];
  const recent: JobSummary[] = [];
  for (const j of state.jobs) {
    if (j.status === 'running' || j.status === 'signaled') running.push(j);
    else recent.push(j);
  }
  recent.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const cap = opts.recentCap;
  return {
    running,
    recent: cap !== undefined && cap >= 0 ? recent.slice(0, cap) : recent,
  };
}

/**
 * Returns true iff `state` has at least one job in a non-terminal
 * status. Used by the extension to decide whether to keep the registry
 * "busy" for shutdown wait.
 */
export function hasLiveJobs(state: BgBashState): boolean {
  return state.jobs.some((j) => j.status === 'running' || j.status === 'signaled');
}
