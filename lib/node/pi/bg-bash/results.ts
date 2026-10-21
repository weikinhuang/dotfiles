/**
 * Pure text shapers for the bg-bash tool results (`start`, `logs`,
 * `wait`). Split out of the extension's action closures so the exact
 * LLM-facing strings can be vitest-tested without the pi runtime. Same
 * pi-free contract as bg-bash-format.ts, which supplies `formatJobLine`.
 */

import { formatJobLine } from '../bg-bash-format.ts';
import { type JobStatus, type JobSummary } from '../bg-bash-reducer.ts';
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
  /**
   * Job status when the snapshot was taken. A `running` job gets a note so a
   * partial snapshot is never mistaken for the job's complete output.
   */
  jobStatus?: JobStatus;
}

/** Header line for a `logs` tool result. */
export function formatLogsHeader(opts: Omit<LogsTextInput, 'content' | 'logFile'>): string {
  return `--- [${opts.id}] ${opts.stream}: ${opts.totalBytes} bytes total, ${opts.droppedBytes} dropped from memory${
    opts.droppedBefore ? ' (your cursor was evicted - fall back to logFile)' : ''
  }${opts.jobStatus === 'running' ? ' (job still running - output so far)' : ''} ---`;
}

/** Full text body for a `logs` tool result: header + content + optional log-file note. */
export function formatLogsText(opts: LogsTextInput): string {
  const header = formatLogsHeader(opts);
  const tailNote = opts.logFile ? `\n--- full log: ${opts.logFile} ---` : '';
  return `${header}\n${opts.content}${tailNote}`;
}

/** Lead line for a `wait` tool result. */
export function formatWaitResult(job: JobSummary, opts: { timedOut: boolean; timeoutMs: number }, now: number): string {
  return opts.timedOut
    ? `Still running after ${opts.timeoutMs}ms: ${formatJobLine(job, now)}`
    : `Exited: ${formatJobLine(job, now)}`;
}
