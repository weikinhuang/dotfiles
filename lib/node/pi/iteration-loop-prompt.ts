/**
 * Render the `## Iteration Loop` status block injected into the
 * system prompt while a check is active.
 *
 * Design priorities (small-model-first):
 *
 *   - Directive, not descriptive. The block tells the model WHAT TO
 *     DO NEXT, not just where it is. Small models lock onto imperative
 *     lines; "your next move is X" beats "the state is Y".
 *   - Stable, scannable field order. Same labels / rows every turn so
 *     the model learns to skim past familiar context quickly.
 *   - Never silently empty. When no task is active, the caller passes
 *     `spec=null` and we return `null` so the caller skips injection.
 *     When a draft is pending, we render a short "awaiting acceptance"
 *     block so the model doesn't forget to surface the draft.
 *   - Zero prose / no backticks around labels — the block IS the data,
 *     not a narration of it.
 *
 * No pi imports — renderable in isolation for snapshot testing.
 */

import { budgetSnapshot } from './iteration-loop-budget.ts';
import {
  type BashCheckSpec,
  type CheckSpec,
  type CriticCheckSpec,
  type IterationState,
  type StopReason,
} from './iteration-loop-schema.ts';

export interface RenderOptions {
  /**
   * Current clock. Injected for deterministic snapshot tests.
   */
  now?: Date;
  /**
   * Optional maximum number of issue lines rendered from the last
   * verdict. Default 4.
   */
  maxIssues?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Formatting helpers — declared before the render fns that use them.
// ──────────────────────────────────────────────────────────────────────

function formatCheckSummary(spec: CheckSpec): string {
  if (spec.kind === 'bash') {
    const bash = spec.spec as BashCheckSpec;
    const pass = bash.passOn ?? 'exit-zero';
    const cmd = bash.cmd.length > 60 ? bash.cmd.slice(0, 57) + '...' : bash.cmd;
    return `bash (${pass}) — ${cmd}`;
  }
  const critic = spec.spec as CriticCheckSpec;
  const agent = critic.agent ?? 'critic';
  const model = critic.modelOverride ? ` via ${critic.modelOverride}` : '';
  return `critic (agent: ${agent}${model})`;
}

function activeNextStep(state: IterationState): string {
  // No runs yet — tell the model to kick things off.
  if (state.iteration === 0) {
    return 'run `check run` to execute iteration 1 and observe the verdict.';
  }
  // Just passed — the reducer should have set stopReason='passed',
  // but if the caller races that, still emit something useful.
  if (state.lastVerdict?.approved) {
    return 'the last verdict approved. Call `check close reason=passed` to archive and finish.';
  }
  // Edits happened after the last check — run the check before more
  // edits (the strict nudge will fire otherwise).
  if (state.editsSinceLastCheck > 0) {
    return (
      `you've made ${state.editsSinceLastCheck} edit(s) since the last check — ` +
      'run `check run` BEFORE making more edits or claiming the artifact is correct.'
    );
  }
  // Not approved, no new edits — need to address the last verdict's issues.
  if (state.lastVerdict && !state.lastVerdict.approved) {
    const top = state.lastVerdict.issues[0];
    if (top) {
      return `edit ${state.task} to address [${top.severity}] "${top.description}", then \`check run\`.`;
    }
  }
  return 'edit the artifact to address the last verdict, then run `check run`.';
}

function stopReasonExplanation(r: StopReason): string {
  switch (r) {
    case 'passed':
      return 'the last verdict approved.';
    case 'budget-iter':
      return 'hit the maximum iteration count.';
    case 'budget-cost':
      return 'hit the cumulative cost cap.';
    case 'wall-clock':
      return 'hit the wall-clock deadline.';
    case 'fixpoint':
      return "two consecutive iterations produced the same artifact — more edits aren't changing anything.";
    case 'user-closed':
      return '`check close` was called explicitly.';
  }
}

function stopReasonNextStep(r: StopReason, spec: CheckSpec): string {
  if (r === 'passed') {
    return `call \`check close reason=passed task=${spec.task}\` to archive, then report the success to the user.`;
  }
  // All non-pass terminations: surface best-so-far + let the user decide.
  return (
    'the loop terminated without passing. Report the best-so-far snapshot and the stop reason to the user; ' +
    `they may want to extend the budget (declare a new task) or accept the best-so-far as good enough.`
  );
}

// ──────────────────────────────────────────────────────────────────────
// Draft-pending: short directive nudge.
// ──────────────────────────────────────────────────────────────────────

function renderDraftPending(spec: CheckSpec): string {
  const lines: string[] = [];
  lines.push(`## Iteration Loop (task: ${spec.task})`);
  lines.push('');
  lines.push('Status: **draft pending user acceptance**');
  lines.push(`Artifact: ${spec.artifact}`);
  lines.push(`Check kind: ${spec.kind}`);
  lines.push('');
  lines.push(
    'Next step: surface the draft to the user (print its contents and ask for review). ' +
      `Iterations cannot run until the user accepts via \`check accept ${spec.task}\` or by editing the draft file.`,
  );
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Active: full status block.
// ──────────────────────────────────────────────────────────────────────

function renderActive(spec: CheckSpec, state: IterationState | null, opts: RenderOptions): string {
  const now = opts.now ?? new Date();
  const maxIssues = Math.max(1, opts.maxIssues ?? 4);

  const lines: string[] = [];
  lines.push(`## Iteration Loop (task: ${spec.task})`);
  lines.push('');
  lines.push(`Artifact:    ${spec.artifact}`);
  lines.push(`Check:       ${formatCheckSummary(spec)}`);

  if (!state) {
    lines.push('Iteration:   0 / ' + (spec.budget?.maxIter ?? 5) + ' (not yet started)');
    lines.push('');
    lines.push(`Next step: run \`check run\` to execute iteration 1 and observe the verdict.`);
    return lines.join('\n');
  }

  const budget = budgetSnapshot(spec, state, now);
  lines.push(`Iteration:   ${budget.iterUsed} / ${budget.iterMax}`);

  if (state.lastVerdict) {
    const v = state.lastVerdict;
    const status = v.approved ? 'approved' : 'not approved';
    lines.push(`Last verdict: ${status} — score ${v.score.toFixed(2)}`);
    if (!v.approved && v.issues.length > 0) {
      const shown = v.issues.slice(0, maxIssues);
      for (const iss of shown) {
        const loc = iss.location ? ` @ ${iss.location}` : '';
        lines.push(`  [${iss.severity}] ${iss.description}${loc}`);
      }
      if (v.issues.length > shown.length) {
        lines.push(`  … and ${v.issues.length - shown.length} more issue(s)`);
      }
    }
  } else {
    lines.push('Last verdict: (none yet)');
  }

  if (state.bestSoFar) {
    lines.push(
      `Best so far:  iter ${state.bestSoFar.iteration} (score ${state.bestSoFar.score.toFixed(2)}) → ${state.bestSoFar.snapshotPath}`,
    );
  }

  lines.push(`Cost:        $${state.costUsd.toFixed(3)} / budget $${budget.costMax.toFixed(3)}`);
  lines.push(`Edits since last check: ${state.editsSinceLastCheck}`);

  if (state.stopReason) {
    lines.push('');
    lines.push(`Stopped:     ${state.stopReason} — ${stopReasonExplanation(state.stopReason)}`);
    lines.push('');
    lines.push('Next step: ' + stopReasonNextStep(state.stopReason, spec));
  } else {
    lines.push('');
    lines.push('Next step: ' + activeNextStep(state));
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Entry point — placed last so the helpers it fans out to are all
// defined above.
// ──────────────────────────────────────────────────────────────────────

/**
 * Entry point. Returns `null` when nothing worth injecting — the
 * caller uses that to skip the entire `## Iteration Loop` header.
 */
export function renderIterationBlock(
  spec: CheckSpec | null,
  specState: 'draft' | 'active' | 'none',
  state: IterationState | null,
  opts: RenderOptions = {},
): string | null {
  if (!spec || specState === 'none') return null;
  if (specState === 'draft') return renderDraftPending(spec);
  // state may be null if the extension just accepted and hasn't
  // reduced a branch entry yet — render the "iteration 0, not started"
  // shape.
  return renderActive(spec, state, opts);
}
