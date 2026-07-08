/**
 * Pure result / summary formatters for the iteration-loop extension.
 *
 * The extension shell owns the disk reads and reducer calls; these
 * helpers turn already-loaded data into the human-readable text bodies
 * the tool returns. Kept pure (no pi imports, no fs) so the exact
 * output is unit-testable.
 */

import type { ArchiveListing, TaskListing } from './storage.ts';
import type { BestSoFar, StopReason, Verdict } from './schema.ts';

/** Render the `check list` body from the active/draft tasks + archive entries. */
export function formatListing(tasks: TaskListing[], archive: ArchiveListing[]): string {
  const lines: string[] = [];
  if (tasks.length === 0) {
    lines.push('No active or draft tasks under .pi/checks/.');
  } else {
    lines.push(`Tasks (${tasks.length}):`);
    for (const t of tasks) {
      lines.push(`  [${t.state}] ${t.task}  - ${t.path}`);
    }
  }
  if (archive.length > 0) {
    lines.push('');
    lines.push(`Archive (${archive.length} entr${archive.length === 1 ? 'y' : 'ies'}):`);
    for (const a of archive.slice(0, 10)) {
      lines.push(`  ${a.timestamp || '(no-ts)'}  ${a.task}  - ${a.dir}`);
    }
    if (archive.length > 10) lines.push(`  … ${archive.length - 10} more`);
  }
  return lines.join('\n');
}

/** Render the `check run` response body after a completed iteration. */
export function formatRunResultText(opts: {
  summary: string;
  verdict: Verdict;
  snapshot: { path: string; hash: string } | null;
  artifact: string;
  bestSoFar: BestSoFar | null;
  costUsd: number;
  stopReason: StopReason | null;
  task: string;
}): string {
  const { summary, verdict, snapshot, artifact, bestSoFar, costUsd, stopReason, task } = opts;
  const lines: string[] = [summary];
  if (verdict.issues.length > 0) {
    lines.push('Issues:');
    const preview = verdict.issues.slice(0, 3);
    for (const issue of preview) {
      const loc = issue.location ? ` (${issue.location})` : '';
      lines.push(`  [${issue.severity}] ${issue.description}${loc}`);
    }
    if (verdict.issues.length > preview.length) {
      lines.push(`  … ${verdict.issues.length - preview.length} more`);
    }
  }
  if (snapshot) {
    lines.push(`Snapshot: ${snapshot.path}`);
  } else {
    lines.push(`Snapshot: (artifact "${artifact}" not found on disk - fixpoint detection disabled)`);
  }
  if (bestSoFar) {
    lines.push(
      `Best so far: iter ${bestSoFar.iteration} (score ${bestSoFar.score.toFixed(2)}) → ${bestSoFar.snapshotPath}`,
    );
  }
  lines.push(`Cost so far: $${costUsd.toFixed(4)}`);
  if (stopReason) {
    lines.push(`Stop reason: ${stopReason}`);
    if (stopReason === 'passed') {
      lines.push(`Loop passed - call \`check close task=${task} reason=passed\` to archive it.`);
    } else {
      lines.push(
        `Loop terminated without passing. Either \`check close task=${task} reason=${stopReason}\` to archive the best-so-far, or edit the artifact / spec and re-declare.`,
      );
    }
  } else {
    lines.push(`Next step: edit ${artifact}, then call \`check run task=${task}\` again.`);
  }
  return lines.join('\n');
}
