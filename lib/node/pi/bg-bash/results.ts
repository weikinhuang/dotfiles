/**
 * Pure text shapers for the bg-bash tool results (`start`, `logs`,
 * `wait`). Split out of the extension's action closures so the exact
 * LLM-facing strings can be vitest-tested without the pi runtime. Same
 * pi-free contract as bg-bash-format.ts, which supplies `formatJobLine`.
 */

import { formatJobLine } from '../bg-bash-format.ts';
import { isJobRunning, type JobStatus, type JobSummary } from '../bg-bash-reducer.ts';
import { truncate } from '../shared.ts';

/** Lead line for a `start` tool result, plus an optional warning line. */
export function formatStartResult(summary: JobSummary, warning?: string): string {
  const lead =
    summary.status === 'error'
      ? `Failed to start: ${summary.error ?? 'unknown error'}`
      : `Started [${summary.id}] pid ${summary.pid ?? '?'}: ${truncate(summary.command, 120)}`;
  return warning ? `${lead}\n${warning}` : lead;
}

export interface LogsTextInput {
  id: string;
  stream: string;
  totalBytes: number;
  droppedBytes: number;
  droppedBefore: boolean;
  content: string;
  logFile?: string;
  /** Job status when the snapshot was taken; used when `job` is unavailable. */
  jobStatus?: JobStatus;
  /** Snapshot metadata for an explicit outcome summary and partial-output notes. */
  job?: JobSummary;
}

function isLogsJobRunning(opts: Pick<LogsTextInput, 'job' | 'jobStatus'>): boolean {
  if (opts.job) return isJobRunning(opts.job);
  return opts.jobStatus === 'running' || opts.jobStatus === 'signaled';
}

/** Header line for a `logs` tool result. */
export function formatLogsHeader(opts: Omit<LogsTextInput, 'content' | 'logFile'>): string {
  const partialNote = isLogsJobRunning(opts)
    ? ' (job still running - output so far)'
    : opts.job?.outputOpen
      ? ' (job finished - output still partial; output pipe open)'
      : '';
  return `--- [${opts.id}] ${opts.stream}: ${opts.totalBytes} bytes total, ${opts.droppedBytes} dropped from memory${
    opts.droppedBefore ? ' (your cursor was evicted - fall back to logFile)' : ''
  }${partialNote} ---`;
}

/** Full text body for a `logs` tool result: header + optional outcome + content + log-file note. */
export function formatLogsText(opts: LogsTextInput): string {
  const header = formatLogsHeader(opts);
  const summary =
    opts.job && !isLogsJobRunning(opts) ? `\n${formatJobLine(opts.job, opts.job.endedAt ?? opts.job.startedAt)}` : '';
  const tailNote = opts.logFile ? `\n--- full log: ${opts.logFile} ---` : '';
  return `${header}${summary}\n${opts.content}${tailNote}`;
}

/** Lead line for a `wait` tool result. */
export function formatWaitResult(job: JobSummary, opts: { timedOut: boolean; timeoutMs: number }, now: number): string {
  return opts.timedOut
    ? `Still running after ${opts.timeoutMs}ms: ${formatJobLine(job, now)}`
    : `Exited: ${formatJobLine(job, now)}`;
}
