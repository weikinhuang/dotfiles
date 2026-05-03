/**
 * Tests for `lib/node/pi/deep-research-tool.ts`.
 *
 * Covers:
 *
 *   - single-active-run invariant: a second concurrent call
 *     throws `SINGLE_ACTIVE_ERROR` without invoking the runner,
 *   - the flag is released after both success and failure paths,
 *   - notify() fires with the summary + level on completion,
 *   - `formatResearchToolSummary` produces the expected message
 *     for each outcome kind.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  createResearchSessionFlag,
  createResearchToolExecutor,
  formatResearchToolSummary,
  type NotifyFn,
  type ResearchToolRunOutcome,
  type ResearchToolRunner,
  SINGLE_ACTIVE_ERROR,
} from '../../../../lib/node/pi/deep-research-tool.ts';

// ──────────────────────────────────────────────────────────────────────
// formatResearchToolSummary
// ──────────────────────────────────────────────────────────────────────

describe('formatResearchToolSummary', () => {
  test('report-complete returns info level + report path', () => {
    const { summary, level } = formatResearchToolSummary({
      kind: 'report-complete',
      reportPath: '/tmp/research/demo/report.md',
      runRoot: '/tmp/research/demo',
      subjectiveApproved: true,
    });

    expect(level).toBe('info');
    expect(summary).toContain('/tmp/research/demo/report.md');
  });

  test('report-complete with subjectiveApproved=false warns', () => {
    const { level } = formatResearchToolSummary({
      kind: 'report-complete',
      reportPath: '/tmp/research/demo/report.md',
      runRoot: '/tmp/research/demo',
      subjectiveApproved: false,
    });

    expect(level).toBe('warning');
  });

  test('fanout-complete with all passing is info', () => {
    const { summary, level } = formatResearchToolSummary({
      kind: 'fanout-complete',
      runRoot: '/tmp/x',
      completed: 3,
      failed: 0,
      aborted: 0,
    });

    expect(level).toBe('info');
    expect(summary).toContain('completed=3 failed=0 aborted=0');
  });

  test('fanout-complete with any failure is warning', () => {
    const { level } = formatResearchToolSummary({
      kind: 'fanout-complete',
      runRoot: '/tmp/x',
      completed: 2,
      failed: 1,
      aborted: 0,
    });

    expect(level).toBe('warning');
  });

  test('planner-stuck is warning with reason included', () => {
    const { summary, level } = formatResearchToolSummary({
      kind: 'planner-stuck',
      runRoot: '/tmp/x',
      reason: 'question too vague',
    });

    expect(level).toBe('warning');
    expect(summary).toContain('question too vague');
  });

  test('checkpoint points at the plan for the user to edit', () => {
    const { summary } = formatResearchToolSummary({
      kind: 'checkpoint',
      runRoot: '/tmp/x',
      reason: 'rejected twice',
    });

    expect(summary).toContain('/tmp/x/plan.json');
  });

  test('error is error level with journal hint when runRoot known', () => {
    const { summary, level } = formatResearchToolSummary({
      kind: 'error',
      runRoot: '/tmp/x',
      error: 'boom',
    });

    expect(level).toBe('error');
    expect(summary).toContain('/tmp/x/journal.md');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Single-active-run invariant
// ──────────────────────────────────────────────────────────────────────

describe('single-active-run invariant', () => {
  test('first call acquires the flag; a second concurrent call errors out', async () => {
    const flag = createResearchSessionFlag();
    let release!: (o: ResearchToolRunOutcome) => void;
    const pending = new Promise<ResearchToolRunOutcome>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn<ResearchToolRunner>().mockImplementation(() => pending);
    const exec = createResearchToolExecutor({ flag, runPipeline: runner });

    const firstP = exec('q1');
    // Let the executor flip the flag before racing the second call.
    await Promise.resolve();

    expect(flag.active).toBe(true);

    // Concurrent second call hits the invariant guard.
    await expect(exec('q2')).rejects.toThrow(SINGLE_ACTIVE_ERROR);
    expect(runner).toHaveBeenCalledTimes(1);

    // Release the first so its promise settles.
    release({
      kind: 'report-complete',
      reportPath: '/tmp/r/report.md',
      runRoot: '/tmp/r',
      subjectiveApproved: true,
    });
    await firstP;

    expect(flag.active).toBe(false);
  });

  test('flag is released after success so a subsequent call proceeds', async () => {
    const flag = createResearchSessionFlag();
    const runner = vi.fn<ResearchToolRunner>().mockImplementation(() =>
      Promise.resolve<ResearchToolRunOutcome>({
        kind: 'fanout-complete',
        runRoot: '/tmp/x',
        completed: 1,
        failed: 0,
        aborted: 0,
      }),
    );
    const exec = createResearchToolExecutor({ flag, runPipeline: runner });

    await exec('q1');

    expect(flag.active).toBe(false);

    await exec('q2');

    expect(runner).toHaveBeenCalledTimes(2);
  });

  test('flag is released after a runner throw', async () => {
    const flag = createResearchSessionFlag();
    const exec = createResearchToolExecutor({
      flag,
      runPipeline: () => Promise.reject(new Error('boom')),
    });

    await expect(exec('q')).rejects.toThrow('boom');
    expect(flag.active).toBe(false);
  });

  test('empty question throws without touching the flag', async () => {
    const flag = createResearchSessionFlag();
    const runner = vi.fn<ResearchToolRunner>();
    const exec = createResearchToolExecutor({ flag, runPipeline: runner });

    await expect(exec('   ')).rejects.toThrow('research: question is empty');
    expect(runner).not.toHaveBeenCalled();
    expect(flag.active).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// notify wiring
// ──────────────────────────────────────────────────────────────────────

describe('notify wiring', () => {
  test('notify fires with the summary + level on pipeline completion', async () => {
    const flag = createResearchSessionFlag();
    const notify = vi.fn<NotifyFn>();
    const exec = createResearchToolExecutor({
      flag,
      runPipeline: () =>
        Promise.resolve<ResearchToolRunOutcome>({
          kind: 'report-complete',
          reportPath: '/tmp/r/report.md',
          runRoot: '/tmp/r',
          subjectiveApproved: true,
        }),
      notify,
    });
    const result = await exec('q');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('info');
    expect(notify.mock.calls[0][0]).toContain('/tmp/r/report.md');
    expect(result.summary).toContain('/tmp/r/report.md');
    expect(result.outcome.kind).toBe('report-complete');
  });

  test('notify fires with error level when the runner throws', async () => {
    const flag = createResearchSessionFlag();
    const notify = vi.fn<NotifyFn>();
    const exec = createResearchToolExecutor({
      flag,
      runPipeline: () => Promise.reject(new Error('nope')),
      notify,
    });

    await expect(exec('q')).rejects.toThrow('nope');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('error');
    expect(notify.mock.calls[0][0]).toContain('nope');
  });
});
