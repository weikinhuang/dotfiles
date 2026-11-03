/** Pending completion identities, resolved from current state only at delivery. */
import { isBgBashStateShape, type BgBashState, type JobSummary } from '../bg-bash-reducer.ts';
import { surfacedTerminalJobs } from '../bg-bash-prompt.ts';
import { isRecord } from '../shared/guards.ts';
import { isNudgeWorthy } from './nudge.ts';

/** Read only summaries whose canonical text actually appeared in the delivered message. */
export function deliveredTerminalJobs(text: string, details: unknown, fallback: BgBashState): string[] {
  let snapshot = fallback;
  if (isBgBashStateShape(details)) {
    snapshot = details;
  } else if (isRecord(details)) {
    const candidate: unknown = { nextId: 1, jobs: details.jobs };
    if (isBgBashStateShape(candidate)) snapshot = candidate;
  }
  return surfacedTerminalJobs(snapshot, text);
}

export class PendingCompletions {
  private readonly jobs = new Map<string, number>();

  add(job: JobSummary): void {
    if (job.nudge && isNudgeWorthy(job.status)) this.jobs.set(job.id, job.startedAt);
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) this.jobs.delete(id);
  }

  clear(): void {
    this.jobs.clear();
  }

  get size(): number {
    return this.jobs.size;
  }

  select(state: BgBashState, acknowledged: ReadonlySet<string>, isWaiting: (id: string) => boolean): JobSummary[] {
    const ready: JobSummary[] = [];
    for (const [id, startedAt] of this.jobs) {
      const job = state.jobs.find((entry) => entry.id === id && entry.startedAt === startedAt);
      if (!job || acknowledged.has(id) || !job.nudge || !isNudgeWorthy(job.status)) {
        this.jobs.delete(id);
      } else if (!isWaiting(id)) {
        ready.push({ ...job });
      }
    }
    return ready;
  }
}
