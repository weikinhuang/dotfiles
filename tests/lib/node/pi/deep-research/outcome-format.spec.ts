/**
 * Tests for lib/node/pi/deep-research/outcome-format.ts.
 *
 * `surfaceOutcome` is the human-readable notify block the
 * `/research` slash command (and the resume pipeline path) show
 * the user. This spec drives it with each `PipelineOutcome` kind
 * and asserts the exact message content + notify level so the
 * extension's user-facing surface stays pinned.
 */

import { describe, expect, test, vi } from 'vitest';

import { surfaceOutcome } from '../../../../../lib/node/pi/deep-research/outcome-format.ts';
import { type PipelineOutcome } from '../../../../../lib/node/pi/deep-research/pipeline.ts';
import { type FanoutResult } from '../../../../../lib/node/pi/research/fanout.ts';
import { type DeepResearchPlan } from '../../../../../lib/node/pi/research/plan.ts';
import { type CommandNotify, type CommandNotifyLevel } from '../../../../../lib/node/pi/research/runs.ts';

const plan: DeepResearchPlan = {
  kind: 'deep-research',
  slug: 'demo',
  question: 'q',
  status: 'done',
  budget: { maxSubagents: 1, maxFetches: 1, maxCostUsd: 1, wallClockSec: 60 },
  subQuestions: [],
};

function fanoutResult(overrides: Partial<FanoutResult> = {}): FanoutResult {
  return { completed: [{ id: 'sq-1', output: '' }], failed: [], aborted: [], ...overrides };
}

function mockNotify(): ReturnType<typeof vi.fn<CommandNotify>> {
  return vi.fn<CommandNotify>();
}

function firstCall(notify: ReturnType<typeof mockNotify>): [string, CommandNotifyLevel] {
  return notify.mock.calls[0];
}

describe('surfaceOutcome', () => {
  test('report-complete with no stubs/quarantine notifies at info with the report path + counts', () => {
    const outcome: PipelineOutcome = {
      kind: 'report-complete',
      runRoot: '/r',
      plan,
      fanout: fanoutResult(),
      quarantined: [],
      sections: [],
      merge: { reportPath: '/r/report.md', footnoteCount: 3, stubbedSubQuestions: [], usedFallback: false },
    };
    const notify = mockNotify();
    surfaceOutcome(outcome, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, level] = firstCall(notify);
    expect(level).toBe('info');
    expect(message).toContain('/research: report written at /r/report.md');
    expect(message).toContain('fanout: completed=1 failed=0 aborted=0');
    expect(message).toContain('synth: footnotes=3 stubbed=0 fallback-wrapper=no');
    expect(message).toContain('two-stage review');
  });

  test('report-complete with stubbed sub-questions escalates to warning', () => {
    const outcome: PipelineOutcome = {
      kind: 'report-complete',
      runRoot: '/r',
      plan,
      fanout: fanoutResult(),
      quarantined: [],
      sections: [],
      merge: { reportPath: '/r/report.md', footnoteCount: 0, stubbedSubQuestions: ['sq-1'], usedFallback: true },
    };
    const notify = mockNotify();
    surfaceOutcome(outcome, notify);

    expect(firstCall(notify)[1]).toBe('warning');
    expect(firstCall(notify)[0]).toContain('fallback-wrapper=yes');
  });

  test('fanout-complete reports counts and stays info when nothing quarantined', () => {
    const outcome: PipelineOutcome = {
      kind: 'fanout-complete',
      runRoot: '/r',
      plan,
      fanout: fanoutResult(),
      quarantined: [],
    };
    const notify = mockNotify();
    surfaceOutcome(outcome, notify);

    const [message, level] = firstCall(notify);
    expect(level).toBe('info');
    expect(message).toContain('/research: fanout complete under /r');
    expect(message).toContain('completed=1 failed=0 aborted=0 quarantined=0');
  });

  test('fanout-complete with quarantined items escalates to warning', () => {
    const outcome: PipelineOutcome = {
      kind: 'fanout-complete',
      runRoot: '/r',
      plan,
      fanout: fanoutResult(),
      quarantined: ['sq-2'],
    };
    const notify = mockNotify();
    surfaceOutcome(outcome, notify);

    expect(firstCall(notify)[1]).toBe('warning');
  });

  test('planner-stuck notifies at warning with the reason', () => {
    const notify = mockNotify();
    surfaceOutcome({ kind: 'planner-stuck', runRoot: '/r', reason: 'too vague' }, notify);

    const [message, level] = firstCall(notify);
    expect(level).toBe('warning');
    expect(message).toContain('planner emitted stuck - too vague');
  });

  test('checkpoint notifies at warning naming the plan path', () => {
    const outcome: PipelineOutcome = {
      kind: 'checkpoint',
      runRoot: '/r',
      plan,
      outcome: {
        kind: 'checkpoint',
        rewrites: 1,
        plan,
        verdict: { approved: false, score: 0, issues: [], summary: 'rejected' },
      },
    };
    const notify = mockNotify();
    surfaceOutcome(outcome, notify);

    const [message, level] = firstCall(notify);
    expect(level).toBe('warning');
    expect(message).toContain('/r/plan.json');
  });

  test('error notifies at error level and points at the journal', () => {
    const notify = mockNotify();
    surfaceOutcome({ kind: 'error', runRoot: '/r', plan, error: 'boom' }, notify);

    const [message, level] = firstCall(notify);
    expect(level).toBe('error');
    expect(message).toContain('pipeline hit an error (boom)');
    expect(message).toContain('/r/journal.md');
  });
});
