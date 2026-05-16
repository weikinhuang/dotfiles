/* Read "Internals" at the bottom - public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope because
 * TS function declarations are hoisted and this ordering reads
 * top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Pure factory for the Phase-5 `research` tool surface.
 *
 * The `research` tool exposes the deep-research pipeline to the
 * LLM as a callable so the model can kick off a long-horizon
 * research run mid-conversation. The actual pipeline work is
 * handed off to an injected runner; this module owns:
 *
 *   - the single-active-run session invariant, so a second
 *     concurrent `research` tool call fails fast with a clear
 *     message rather than spawning a parallel fanout;
 *   - the summary string returned to the LLM, including the
 *     report path for downstream linkification;
 *   - fire-and-forget notification on pipeline completion or
 *     failure.
 *
 * The pi-runtime wiring (registering the tool, building the
 * pipeline deps, bridging the notify hook to `ctx.ui.notify`)
 * lives in `config/pi/extensions/deep-research.ts`.
 *
 * No pi imports - the module is unit-testable under vitest.
 */

import { type CommandNotify, type CommandNotifyLevel } from './research-runs.ts';

// ──────────────────────────────────────────────────────────────────────
// Session flag.
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal flag interface the tool uses to enforce the single-active
 * research invariant. The extension owns a module-level instance;
 * tests can supply a hand-rolled object.
 */
export interface ResearchSessionFlag {
  /** True while a research run is in flight. */
  active: boolean;
}

/** Factory for a fresh session flag. */
export function createResearchSessionFlag(): ResearchSessionFlag {
  return { active: false };
}

// ──────────────────────────────────────────────────────────────────────
// Tool outcome types.
// ──────────────────────────────────────────────────────────────────────

/**
 * Shape the injected runner returns. Mirrors the subset of
 * {@link import('./deep-research-pipeline.ts').PipelineOutcome}
 * the tool's summary cares about.
 */
export type ResearchToolRunOutcome =
  | {
      kind: 'report-complete';
      reportPath: string;
      runRoot: string;
      subjectiveApproved?: boolean;
      /** Optional human-readable extra line - e.g. reviewer verdict. */
      summary?: string;
    }
  | {
      kind: 'fanout-complete';
      runRoot: string;
      completed: number;
      failed: number;
      aborted: number;
      /** Optional extra summary line. */
      summary?: string;
    }
  | {
      kind: 'planner-stuck';
      runRoot: string;
      reason: string;
    }
  | {
      kind: 'checkpoint';
      runRoot: string;
      reason: string;
    }
  | {
      kind: 'error';
      runRoot?: string;
      error: string;
    };

export type ResearchToolRunner = (question: string, signal?: AbortSignal) => Promise<ResearchToolRunOutcome>;

/**
 * Notify callback shape. Re-exported as local aliases over the
 * `CommandNotify` / `CommandNotifyLevel` types from
 * `research-runs.ts` so the slash-command side and the tool side
 * share a single definition - nothing duplicates, and the local
 * aliases keep the public surface of this module self-documenting.
 */
export type NotifyLevel = CommandNotifyLevel;
export type NotifyFn = CommandNotify;

export interface ResearchToolDeps {
  flag: ResearchSessionFlag;
  runPipeline: ResearchToolRunner;
  notify?: NotifyFn;
}

/** What the tool's `execute` returns. Mirrors a pi tool result. */
export interface ResearchToolResult {
  /** Concise summary handed to the LLM. */
  summary: string;
  /** Notification level suitable for `ctx.ui.notify`. */
  level: NotifyLevel;
  /** Outcome wrapped for downstream inspection (tests, renderers). */
  outcome: ResearchToolRunOutcome;
}

/**
 * Human-readable error message used when a second `research` tool
 * call would violate the single-active-run invariant.
 */
export const SINGLE_ACTIVE_ERROR =
  'research: another research run is already active in this session. Wait for it to finish before starting a new one.';

// ──────────────────────────────────────────────────────────────────────
// Factory.
// ──────────────────────────────────────────────────────────────────────

/**
 * Produce an `execute(question, signal)` function suitable for
 * plugging into `pi.registerTool(...)`. The factory owns the
 * single-active-run invariant: the flag is flipped on entry,
 * restored in a `finally`, and the caller sees a thrown
 * `Error(SINGLE_ACTIVE_ERROR)` if a second concurrent call hits
 * the guard.
 */
export function createResearchToolExecutor(
  deps: ResearchToolDeps,
): (question: string, signal?: AbortSignal) => Promise<ResearchToolResult> {
  return async function execute(question: string, signal?: AbortSignal): Promise<ResearchToolResult> {
    const trimmed = question.trim();
    if (!trimmed) {
      throw new Error('research: question is empty');
    }
    if (deps.flag.active) {
      throw new Error(SINGLE_ACTIVE_ERROR);
    }
    deps.flag.active = true;
    try {
      const outcome = await deps.runPipeline(trimmed, signal);
      const formatted = formatResearchToolSummary(outcome);
      deps.notify?.(formatted.summary, formatted.level);
      return { ...formatted, outcome };
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      const summary = `research: pipeline threw - ${message}`;
      deps.notify?.(summary, 'error');
      throw e;
    } finally {
      deps.flag.active = false;
    }
  };
}

/**
 * Render an outcome into a `{ summary, level }` pair. Callers
 * (both the tool and the extension shell's completion notify)
 * share this formatter so the LLM and the user see identical
 * language.
 */
export function formatResearchToolSummary(outcome: ResearchToolRunOutcome): { summary: string; level: NotifyLevel } {
  switch (outcome.kind) {
    case 'report-complete': {
      const lines: string[] = [];
      lines.push(`research: report written at ${outcome.reportPath}`);
      if (outcome.summary) lines.push(outcome.summary);
      const level: NotifyLevel = outcome.subjectiveApproved === false ? 'warning' : 'info';
      return { summary: lines.join('\n'), level };
    }
    case 'fanout-complete': {
      const lines: string[] = [];
      lines.push(`research: fanout complete under ${outcome.runRoot}`);
      lines.push(`  completed=${outcome.completed} failed=${outcome.failed} aborted=${outcome.aborted}`);
      if (outcome.summary) lines.push(outcome.summary);
      return { summary: lines.join('\n'), level: outcome.failed + outcome.aborted > 0 ? 'warning' : 'info' };
    }
    case 'planner-stuck':
      return {
        summary: `research: planner emitted stuck - ${outcome.reason}. No plan written; refine the question and retry.`,
        level: 'warning',
      };
    case 'checkpoint':
      return {
        summary: `research: plan rejected (${outcome.reason}). Inspect ${outcome.runRoot}/plan.json before resuming.`,
        level: 'warning',
      };
    case 'error':
      return {
        summary: outcome.runRoot
          ? `research: pipeline errored - ${outcome.error}. See ${outcome.runRoot}/journal.md for details.`
          : `research: pipeline errored - ${outcome.error}`,
        level: 'error',
      };
  }
}
