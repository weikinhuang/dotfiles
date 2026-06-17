/**
 * Pure helpers for the bg_bash completion nudge.
 *
 * When a job started with `nudge: true` reaches a terminal state on its
 * own, the extension sends an unsolicited `custom` message so the agent
 * reacts to the completion even after it has gone idle at the prompt -
 * the same proactive-wake behaviour Claude Code's background bash has
 * (it re-invokes the agent when a background command exits). This module
 * owns the pure parts: which terminal states warrant a nudge and how the
 * notice text reads. The extension keeps the pi-API plumbing (idle
 * gating, delivery, coalescing).
 *
 * No pi imports - unit-tested under vitest.
 */

import { formatJobLine } from '../bg-bash-format.ts';
import { type JobStatus, type JobSummary } from '../bg-bash-reducer.ts';

/**
 * customType for the completion-nudge message. Distinct from the
 * non-LLM `bg-bash-state` persistence entry (`BG_BASH_CUSTOM_TYPE`): this
 * one IS sent to the LLM as a synthetic user turn.
 */
export const BG_BASH_NUDGE_CUSTOM_TYPE = 'bg-bash-nudge';

/** Structured payload carried on the nudge message for the renderer. */
export interface BgBashNudgeDetails {
  jobs: JobSummary[];
}

/**
 * Whether a job reaching `status` warrants an unsolicited nudge. Only
 * jobs that finished on their own qualify: `exited` (any code) and a
 * runtime `error`. A `signaled` job was stopped deliberately (the agent's
 * own `signal` action, or session shutdown) so whoever sent the signal
 * already knows - nudging would be noise. `running` / `terminated` never
 * nudge.
 */
export function isNudgeWorthy(status: JobStatus): boolean {
  return status === 'exited' || status === 'error';
}

/**
 * Build the LLM-facing notice for one or more finished nudge jobs. pi
 * serializes a `custom` message into a synthetic user turn, so this reads
 * as an instruction the agent acts on. Coalesced: a burst of completions
 * folds into one message rather than one turn each.
 */
export function formatBgBashNudge(jobs: JobSummary[], now: number): string {
  if (jobs.length === 1) {
    const job = jobs[0];
    return (
      `⊙ Background job ${formatJobLine(job, now)}. ` +
      `Review it with \`bg_bash logs ${job.id}\` if you need the output, then carry on with what it unblocks.`
    );
  }
  const lines = jobs.map((j) => `  ${formatJobLine(j, now)}`).join('\n');
  return (
    `⊙ ${jobs.length} background jobs finished:\n${lines}\n` +
    'Review any with `bg_bash logs <id>`, then carry on with what they unblock.'
  );
}
