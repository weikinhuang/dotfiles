import { createHash } from 'node:crypto';

import type { ReminderMessage } from '../context-reminder.ts';
import { reminderMessageKeys } from '../reminder-identity.ts';
import { isRecord } from '../shared/guards.ts';
import { latestSceneBoundary } from './scene-state.ts';

export const EXTRACTION_JOB_ENTRY = 'roleplay-extraction-job';
export const EXTRACTION_STATUSES = ['pending', 'running', 'complete', 'skipped', 'failed', 'interrupted'] as const;
export const EXTRACTION_REASONS = [
  'restored-running',
  'span-unavailable',
  'disabled',
  'no-input',
  'no-results',
  'model-error',
  'invalid-output',
  'write-error',
  'cancelled',
] as const;

export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];
export type ExtractionReason = (typeof EXTRACTION_REASONS)[number];
export type ExtractionKind = 'facts' | 'timeline';
export function extractionAuditOutcome(skip: string): { status: ExtractionStatus; reason?: ExtractionReason } {
  if (!skip) return { status: 'complete' };
  if (skip === 'write-error') return { status: 'failed', reason: 'write-error' };
  if (skip === 'invalid-output') return { status: 'failed', reason: 'invalid-output' };
  if (skip === 'no-session' || skip === 'disabled') return { status: 'skipped', reason: 'disabled' };
  if (['no-plan', 'no-beats', 'no-candidates', 'all-duplicates'].includes(skip))
    return { status: 'skipped', reason: 'no-results' };
  return { status: 'failed', reason: 'model-error' };
}

export interface ExtractionStage {
  status: ExtractionStatus;
  attempts: number;
  reason?: ExtractionReason;
  updatedAt: number;
}

export interface ExtractionJobIdentity {
  cast: string;
  fromAnchor: string;
  /** First excluded message. It must still exist when resolving the span. */
  toAnchor: string;
  /** Identity of the committed recap that scheduled this job, never recap text. */
  sourceRecapId: string;
  fromTurn?: number;
  toTurn?: number;
}

/** Full snapshots only. No transcript, recap body, model output or free-form errors belong here. */
export interface ExtractionJob extends ExtractionJobIdentity {
  id: string;
  facts: ExtractionStage;
  timeline: ExtractionStage;
  createdAt: number;
  updatedAt: number;
}

function jobId(identity: Pick<ExtractionJobIdentity, 'cast' | 'fromAnchor' | 'toAnchor'>): string {
  return createHash('sha256')
    .update(JSON.stringify([identity.cast, identity.fromAnchor, identity.toAnchor]))
    .digest('hex');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function turn(value: unknown): value is number | undefined {
  return value === undefined || (timestamp(value) && value > 0);
}

function isStage(value: unknown, createdAt: number, updatedAt: number): value is ExtractionStage {
  return (
    isRecord(value) &&
    exactKeys(value, ['status', 'attempts', 'reason', 'updatedAt']) &&
    EXTRACTION_STATUSES.includes(value.status as ExtractionStatus) &&
    timestamp(value.attempts) &&
    (value.status !== 'running' || value.attempts > 0) &&
    (value.reason === undefined || EXTRACTION_REASONS.includes(value.reason as ExtractionReason)) &&
    timestamp(value.updatedAt) &&
    value.updatedAt >= createdAt &&
    value.updatedAt <= updatedAt
  );
}

function isJob(value: unknown): value is ExtractionJob {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'id',
      'cast',
      'fromAnchor',
      'toAnchor',
      'sourceRecapId',
      'fromTurn',
      'toTurn',
      'facts',
      'timeline',
      'createdAt',
      'updatedAt',
    ]) &&
    identifier(value.cast) &&
    identifier(value.fromAnchor) &&
    identifier(value.toAnchor) &&
    value.fromAnchor !== value.toAnchor &&
    identifier(value.sourceRecapId) &&
    turn(value.fromTurn) &&
    turn(value.toTurn) &&
    (value.fromTurn === undefined || value.toTurn === undefined || value.fromTurn <= value.toTurn) &&
    timestamp(value.createdAt) &&
    timestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt &&
    isStage(value.facts, value.createdAt, value.updatedAt) &&
    isStage(value.timeline, value.createdAt, value.updatedAt) &&
    value.id === jobId({ cast: value.cast, fromAnchor: value.fromAnchor, toAnchor: value.toAnchor })
  );
}

function copyJob(job: ExtractionJob): ExtractionJob {
  return { ...job, facts: { ...job.facts }, timeline: { ...job.timeline } };
}

/** Append the returned full snapshot with pi.appendEntry(EXTRACTION_JOB_ENTRY, job). */
export function createExtractionJob(identity: ExtractionJobIdentity, now: number): ExtractionJob {
  // Deliberately do not spread caller input: even a structurally compatible object may contain raw text.
  const job: ExtractionJob = {
    id: jobId(identity),
    cast: identity.cast,
    fromAnchor: identity.fromAnchor,
    toAnchor: identity.toAnchor,
    sourceRecapId: identity.sourceRecapId,
    ...(identity.fromTurn !== undefined ? { fromTurn: identity.fromTurn } : {}),
    ...(identity.toTurn !== undefined ? { toTurn: identity.toTurn } : {}),
    facts: { status: 'pending', attempts: 0, updatedAt: now },
    timeline: { status: 'pending', attempts: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  if (!isJob(job)) throw new Error('Invalid extraction job metadata');
  return job;
}

function terminal(stage: ExtractionStage): boolean {
  return stage.status === 'complete' || stage.status === 'skipped';
}

/** Completed and deliberately skipped stages are immutable; retrying another stage cannot erase them. */
export function updateExtractionStage(
  job: ExtractionJob,
  kind: ExtractionKind,
  status: ExtractionStatus,
  now: number,
  reason?: ExtractionReason,
): ExtractionJob {
  if (!isJob(job) || !timestamp(now) || now < job.updatedAt || !['facts', 'timeline'].includes(kind))
    throw new Error('Invalid extraction stage update');
  if (!EXTRACTION_STATUSES.includes(status) || (reason !== undefined && !EXTRACTION_REASONS.includes(reason)))
    throw new Error('Invalid extraction stage update');
  const next = copyJob(job);
  if (terminal(job[kind])) return next;
  next[kind] = {
    status,
    attempts: job[kind].attempts + (status === 'running' && job[kind].status !== 'running' ? 1 : 0),
    ...(reason !== undefined ? { reason } : {}),
    updatedAt: now,
  };
  next.updatedAt = now;
  if (!isJob(next)) throw new Error('Invalid extraction stage update');
  return next;
}

export interface ScanExtractionJobsOptions {
  /** Last N fully complete/skipped jobs, plus ALL unfinished jobs. Default 20. */
  terminalLimit?: number;
  /** Restore by default; disable only when reducing snapshots within the live process. */
  restore?: boolean;
  /** Optional explicit restore time. No clock or other IO is read by this module. */
  now?: number;
}

/** Only pass the active root-to-leaf branch, never the session's all-entries collection. */
export function scanExtractionJobs(
  branch: readonly Record<string, unknown>[],
  cast: string,
  options: ScanExtractionJobsOptions = {},
): ExtractionJob[] {
  const limit = options.terminalLimit ?? 20;
  if (!timestamp(limit) || (options.now !== undefined && !timestamp(options.now)))
    throw new Error('Invalid extraction scan options');
  const boundary = latestSceneBoundary(branch);
  const jobs = new Map<string, ExtractionJob>();
  for (const entry of branch.slice(boundary ? branch.indexOf(boundary) + 1 : 0)) {
    if (entry.type !== 'custom' || entry.customType !== EXTRACTION_JOB_ENTRY || !isJob(entry.data)) continue;
    const job = entry.data;
    if (job.cast !== cast) continue;
    const prior = jobs.get(job.id);
    if (prior) {
      // A repeated scheduler call is not a new job, nor permission to reset completed work.
      if (
        job.createdAt !== prior.createdAt ||
        job.sourceRecapId !== prior.sourceRecapId ||
        job.fromTurn !== prior.fromTurn ||
        job.toTurn !== prior.toTurn ||
        job.updatedAt < prior.updatedAt ||
        (['facts', 'timeline'] as const).some(
          (kind) =>
            job[kind].attempts < prior[kind].attempts ||
            job[kind].updatedAt < prior[kind].updatedAt ||
            (terminal(prior[kind]) &&
              (job[kind].status !== prior[kind].status ||
                job[kind].reason !== prior[kind].reason ||
                job[kind].attempts !== prior[kind].attempts ||
                job[kind].updatedAt !== prior[kind].updatedAt)),
        )
      )
        continue;
    }
    jobs.set(job.id, copyJob(job));
  }
  const values = [...jobs.values()];
  const completed = values.filter((job) => terminal(job.facts) && terminal(job.timeline));
  const retained = new Set(limit === 0 ? [] : completed.slice(-limit));
  return values
    .filter((job) => !terminal(job.facts) || !terminal(job.timeline) || retained.has(job))
    .map((job) => {
      if (options.restore !== false) {
        for (const kind of ['facts', 'timeline'] as const) {
          if (job[kind].status === 'running')
            job = updateExtractionStage(
              job,
              kind,
              'interrupted',
              Math.max(options.now ?? job.updatedAt, job.updatedAt),
              'restored-running',
            );
        }
      }
      return job;
    });
}

/** No historical coverage is inferred from this queue. Only explicitly queued jobs can be selected. */
export function pendingExtractionJobs(
  jobs: readonly ExtractionJob[],
  kind: ExtractionKind | 'all' = 'all',
): ExtractionJob[] {
  const kinds: readonly ExtractionKind[] = kind === 'all' ? ['facts', 'timeline'] : [kind];
  return jobs
    .filter(isJob)
    .filter((job) => kinds.some((stage) => ['pending', 'failed', 'interrupted'].includes(job[stage].status)))
    .map(copyJob);
}

/** Resolve against the original scene messages, before request overlays. Missing/ambiguous edges never fall back to turns. */
export function resolveExtractionSpan<M extends ReminderMessage>(
  job: Pick<ExtractionJob, 'fromAnchor' | 'toAnchor'>,
  messages: readonly M[],
): M[] | null {
  const from: number[] = [];
  const to: number[] = [];
  messages.forEach((message, index) => {
    const keys = reminderMessageKeys(message);
    if (keys.includes(job.fromAnchor)) from.push(index);
    if (keys.includes(job.toAnchor)) to.push(index);
  });
  if (from.length !== 1 || to.length !== 1 || from[0] >= to[0]) return null;
  return messages.slice(from[0], to[0]);
}

/** Safe for default debug/readout reuse: no cast, names, IDs, anchors, recap identity or arbitrary strings. */
export interface ExtractionJobMetadata {
  ordinal: number;
  fromTurn?: number;
  toTurn?: number;
  facts: ExtractionStage;
  timeline: ExtractionStage;
}

export function extractionJobMetadata(jobs: readonly ExtractionJob[]): ExtractionJobMetadata[] {
  return jobs.filter(isJob).map((job, index) => {
    const result: ExtractionJobMetadata = {
      ordinal: index + 1,
      facts: Object.assign({}, job.facts),
      timeline: Object.assign({}, job.timeline),
    };
    if (job.fromTurn !== undefined) result.fromTurn = job.fromTurn;
    if (job.toTurn !== undefined) result.toTurn = job.toTurn;
    return result;
  });
}

export function formatExtractionJobs(jobs: readonly ExtractionJob[]): string {
  return extractionJobMetadata(jobs)
    .map((job) => {
      const turns =
        job.fromTurn !== undefined && job.toTurn !== undefined ? `${job.fromTurn}-${job.toTurn}` : 'unavailable';
      const stage = (value: ExtractionStage): string => `${value.status}${value.reason ? ` (${value.reason})` : ''}`;
      return `Job ${job.ordinal}: turns ${turns}; facts ${stage(job.facts)}; timeline ${stage(job.timeline)}`;
    })
    .join('\n');
}
