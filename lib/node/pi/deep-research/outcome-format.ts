/**
 * Human-readable surfacing of a {@link PipelineOutcome}.
 *
 * `surfaceOutcome` turns a terminal pipeline outcome into the
 * legacy multi-line notify block the `/research` slash command
 * shows the user (fanout counts, synth stats, next-step hint). It
 * is pure - the only side effect is through the injected `notify`
 * callback - so it lives here rather than in the pi-coupled
 * extension shell.
 *
 * No pi imports.
 */

import { type PipelineOutcome } from './pipeline.ts';
import { type CommandNotify } from '../research/runs.ts';

/**
 * Emit the human-readable block for a pipeline outcome via
 * `notify`. Mirrors what `/research <question>` and the resume
 * pipeline path show; the tool path suppresses it (its summary
 * already says everything).
 */
export function surfaceOutcome(outcome: PipelineOutcome, notify: CommandNotify): void {
  switch (outcome.kind) {
    case 'report-complete': {
      const lines: string[] = [];
      lines.push(`/research: report written at ${outcome.merge.reportPath}`);
      lines.push(
        `  fanout: completed=${outcome.fanout.completed.length} failed=${outcome.fanout.failed.length} aborted=${outcome.fanout.aborted.length}`,
      );
      lines.push(
        `  synth: footnotes=${outcome.merge.footnoteCount} stubbed=${outcome.merge.stubbedSubQuestions.length} fallback-wrapper=${outcome.merge.usedFallback ? 'yes' : 'no'}`,
      );
      lines.push(`  two-stage review (structural + subjective critic) runs next.`);
      const level =
        outcome.merge.stubbedSubQuestions.length === 0 && outcome.quarantined.length === 0 ? 'info' : 'warning';
      notify(lines.join('\n'), level);
      return;
    }
    case 'fanout-complete': {
      const lines: string[] = [];
      lines.push(`/research: fanout complete under ${outcome.runRoot}`);
      lines.push(
        `  completed=${outcome.fanout.completed.length} failed=${outcome.fanout.failed.length} aborted=${outcome.fanout.aborted.length} quarantined=${outcome.quarantined.length}`,
      );
      lines.push(`  synth was not requested (runSynth=false); findings are on disk at ${outcome.runRoot}/findings/.`);
      notify(lines.join('\n'), outcome.quarantined.length === 0 ? 'info' : 'warning');
      return;
    }
    case 'planner-stuck':
      notify(
        `/research: planner emitted stuck - ${outcome.reason}\nPlan NOT written. Refine the question and retry.`,
        'warning',
      );
      return;
    case 'checkpoint':
      notify(
        `/research: planning-critic did not approve the plan (${outcome.outcome.kind}). Plan is at ${outcome.runRoot}/plan.json - edit it and rerun \`/research\`.`,
        'warning',
      );
      return;
    case 'error':
      notify(
        `/research: pipeline hit an error (${outcome.error}). ${outcome.runRoot}/journal.md has the details.`,
        'error',
      );
      return;
  }
}
