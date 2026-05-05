/**
 * Tests for the deep-research extension's Phase-1 command surface.
 *
 * The extension shell lives at
 * `config/pi/extensions/deep-research.ts` and is intentionally
 * thin — all logic is delegated to the pure helpers in
 * `lib/node/pi/research-runs.ts`. This spec drives those helpers
 * end-to-end against the exact `{cwd, notify, selftest}` shape
 * the extension uses, so the two stay in lockstep.
 *
 * Layout note: the repo convention (see
 * `tests/lib/node/pi/README.md`) puts pure-helper specs under
 * `tests/lib/node/pi/`. This spec sits under
 * `tests/config/pi/extensions/` because the Phase-1 handoff prompt
 * for `plans/pi-deep-research.md` requires that exact path — it
 * documents the extension's command surface, not the helper
 * module. All the code under test is still pure (no pi-runtime
 * imports).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';

import {
  type CriticRunner,
  type RefinementRunner,
  type StructuralRunner,
} from '../../../../lib/node/pi/deep-research-review-loop.ts';
import { runDeepResearchReview, type ReviewWireResult } from '../../../../lib/node/pi/deep-research-review-wire.ts';
import {
  initialStatuslineState,
  type PhaseEvent,
  reduceStatusline,
  renderStatuslineWidget,
} from '../../../../lib/node/pi/deep-research-statusline.ts';
import {
  createResearchSessionFlag,
  createResearchToolExecutor,
  type ResearchToolRunOutcome,
  type ResearchToolRunner,
  SINGLE_ACTIVE_ERROR,
} from '../../../../lib/node/pi/deep-research-tool.ts';
import { type AutoresearchPlan, type DeepResearchPlan } from '../../../../lib/node/pi/research-plan.ts';
import {
  type CommandNotify,
  type CommandNotifyLevel,
  findExistingRun,
  formatRunsTable,
  formatSelftestResult,
  listRuns,
  runListCommand,
  runSelftestCommand,
  type RunSummary,
} from '../../../../lib/node/pi/research-runs.ts';
import { type SelftestResult } from '../../../../lib/node/pi/research-selftest.ts';
import { formatStubHint } from '../../../../lib/node/pi/research-stub-hint.ts';
import { assertKind } from '../../../lib/node/pi/helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Typed mock helpers
// ──────────────────────────────────────────────────────────────────────

type NotifyMock = Mock<CommandNotify>;

/** Build a typed `notify` mock so destructured call args stay strongly typed. */
function mockNotify(): NotifyMock {
  return vi.fn<CommandNotify>();
}

function firstCall(notify: NotifyMock): [string, CommandNotifyLevel] {
  const calls = notify.mock.calls;
  if (calls.length === 0) throw new Error('notify was not called');

  return calls[0];
}

// ──────────────────────────────────────────────────────────────────────
// Fixture scaffolding
// ──────────────────────────────────────────────────────────────────────

function demoPlan(overrides: Partial<DeepResearchPlan> = {}): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: 'demo',
    question: 'What is the capital of France?',
    status: 'done',
    budget: { maxSubagents: 2, maxFetches: 4, maxCostUsd: 1, wallClockSec: 300 },
    subQuestions: [],
    ...overrides,
  };
}

function writeDemoRun(cwd: string, slug: string, plan: DeepResearchPlan | null, opts: { journal?: string } = {}): void {
  const runDir = join(cwd, 'research', slug);
  mkdirSync(runDir, { recursive: true });
  if (plan) {
    writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  }
  if (opts.journal !== undefined) {
    writeFileSync(join(runDir, 'journal.md'), opts.journal);
  }
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-deep-research-spec-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// /research --list
// ──────────────────────────────────────────────────────────────────────

describe('/research --list', () => {
  test('empty ./research/ returns the friendly empty-state message', () => {
    const notify = mockNotify();
    runListCommand({ cwd: sandbox, notify });

    expect(notify).toHaveBeenCalledTimes(1);

    const [message, level] = firstCall(notify);

    expect(level).toBe('info');
    expect(message).toContain('No research runs found');
  });

  test('lists a hand-authored ./research/demo/plan.json', () => {
    writeDemoRun(sandbox, 'demo', demoPlan({ status: 'fanout' }));

    const runs = listRuns(sandbox);

    expect(runs).toEqual<RunSummary[]>([
      {
        slug: 'demo',
        status: 'fanout',
        wallClockSec: null,
        costUsd: null,
        resumability: 'no-report',
        error: null,
      },
    ]);

    const notify = mockNotify();
    runListCommand({ cwd: sandbox, notify });

    expect(notify).toHaveBeenCalledTimes(1);

    const [message, level] = firstCall(notify);

    expect(level).toBe('info');
    // Header row present.
    expect(message).toMatch(/slug\s*\|\s*status\s*\|\s*resume\s*\|\s*wall-clock\s*\|\s*cost/);
    // Demo run appears with its status. Use substring matches since
    // the fixed-width formatter adds padding around each cell.
    expect(message).toContain('demo');
    expect(message).toContain('fanout');
  });

  test('derives wall-clock from journal entries when present', () => {
    const journal =
      '## [2025-01-02T03:04:05.000Z] [step] planner produced 1 sub-question\n' +
      '## [2025-01-02T03:05:35.000Z] [step] fanout complete\n';
    writeDemoRun(sandbox, 'demo', demoPlan(), { journal });

    const runs = listRuns(sandbox);
    const run = runs[0];

    expect(run.wallClockSec).toBe(90);
    expect(formatRunsTable([run])).toContain('1m 30s');
  });

  test('surfaces a slug without plan.json as an errored row', () => {
    const runDir = join(sandbox, 'research', 'no-plan');
    mkdirSync(runDir, { recursive: true });

    const runs = listRuns(sandbox);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ slug: 'no-plan', status: null, error: 'plan.json not found' });
    expect(formatRunsTable(runs)).toContain('! plan.json not found');
  });

  test('skips the autoresearch lab/ subdirectory', () => {
    writeDemoRun(sandbox, 'demo', demoPlan());
    mkdirSync(join(sandbox, 'research', 'lab', 'experiment-1'), { recursive: true });

    const runs = listRuns(sandbox);

    expect(runs.map((r) => r.slug)).toEqual(['demo']);
  });

  test('flags an autoresearch plan parked outside research/lab/', () => {
    const autoresearchPlan: AutoresearchPlan = {
      kind: 'autoresearch',
      slug: 'stray-lab',
      topic: 'misplaced experiment',
      status: 'done',
      budget: { maxSubagents: 1, maxFetches: 0, maxCostUsd: 0.1, wallClockSec: 60 },
      experiments: [],
    };
    const runDir = join(sandbox, 'research', 'stray-lab');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'plan.json'), JSON.stringify(autoresearchPlan, null, 2) + '\n');

    const runs = listRuns(sandbox);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      slug: 'stray-lab',
      status: null,
      error: 'plan.json kind=autoresearch — not a deep-research run',
    });
  });

  test('surfaces a PlanValidationError path in the errored row', () => {
    const malformed = { kind: 'deep-research', slug: 'broken', question: 'q' }; // missing status/budget/subQuestions
    const runDir = join(sandbox, 'research', 'broken');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'plan.json'), JSON.stringify(malformed, null, 2) + '\n');

    const runs = listRuns(sandbox);

    expect(runs).toHaveLength(1);
    // The enriched message carries the `$.status` (or similar) field
    // pointer from PlanValidationError so the user can jump straight
    // to the bad field.
    expect(runs[0].error).toMatch(/plan validation failed at \$\./);
  });

  test('resumability column reports no-report when report.md is absent and no fanout deficit', () => {
    // Zero-sub-question plan → no fanout deficit. No report.md
    // → earliest actionable stage is synth.
    writeDemoRun(sandbox, 'demo', demoPlan({ status: 'fanout', subQuestions: [] }));
    const run = listRuns(sandbox)[0];

    expect(run.resumability).toBe('no-report');
    expect(formatRunsTable([run])).toContain('no-report');
  });

  test('resumability column reports incomplete-fanout when findings are missing', () => {
    const slug = 'deficit';
    writeDemoRun(
      sandbox,
      slug,
      demoPlan({
        status: 'fanout',
        subQuestions: [
          { id: 'sq-1', question: 'A', status: 'pending' },
          { id: 'sq-2', question: 'B', status: 'pending' },
        ],
      }),
    );
    const run = listRuns(sandbox).find((r) => r.slug === slug)!;

    expect(run.resumability).toBe('incomplete-fanout');
  });

  test('resumability column reports stubbed when report.md has [section unavailable] sections', () => {
    const slug = 'stubs';
    writeDemoRun(
      sandbox,
      slug,
      demoPlan({
        status: 'done',
        subQuestions: [{ id: 'sq-1', question: 'A', status: 'complete' }],
      }),
    );
    const runDir = join(sandbox, 'research', slug);
    // Findings + completed fanout so the stage walker reaches the report.
    mkdirSync(join(runDir, 'findings'), { recursive: true });
    writeFileSync(join(runDir, 'findings', 'sq-1.md'), 'finding sq-1\n');
    writeFileSync(
      join(runDir, 'fanout.json'),
      JSON.stringify({
        version: 1,
        mode: 'sync',
        agentName: 'web-researcher',
        tasks: [{ id: 'sq-1', prompt: 'p', state: 'completed' }],
      }),
    );
    writeFileSync(
      join(runDir, 'report.md'),
      ['# Report', '', '## A', '', '[section unavailable: no findings]', ''].join('\n'),
    );

    const run = listRuns(sandbox).find((r) => r.slug === slug)!;

    expect(run.resumability).toBe('stubbed');
  });

  test('resumability column reports done when plan.status is done and report has no stubs', () => {
    const slug = 'shipped';
    writeDemoRun(
      sandbox,
      slug,
      demoPlan({
        status: 'done',
        subQuestions: [{ id: 'sq-1', question: 'A', status: 'complete' }],
      }),
    );
    const runDir = join(sandbox, 'research', slug);
    mkdirSync(join(runDir, 'findings'), { recursive: true });
    writeFileSync(join(runDir, 'findings', 'sq-1.md'), 'finding sq-1\n');
    writeFileSync(
      join(runDir, 'fanout.json'),
      JSON.stringify({
        version: 1,
        mode: 'sync',
        agentName: 'web-researcher',
        tasks: [{ id: 'sq-1', prompt: 'p', state: 'completed' }],
      }),
    );
    writeFileSync(
      join(runDir, 'report.md'),
      ['# Report', '', '## A', '', 'Real prose with a citation [^1].', ''].join('\n'),
    );

    const run = listRuns(sandbox).find((r) => r.slug === slug)!;

    expect(run.resumability).toBe('done');
  });

  test('resumability column reports needs-review when report.md exists but plan.status is not done', () => {
    const slug = 'mid-review';
    writeDemoRun(
      sandbox,
      slug,
      demoPlan({
        status: 'subjective-review',
        subQuestions: [{ id: 'sq-1', question: 'A', status: 'complete' }],
      }),
    );
    const runDir = join(sandbox, 'research', slug);
    mkdirSync(join(runDir, 'findings'), { recursive: true });
    writeFileSync(join(runDir, 'findings', 'sq-1.md'), 'finding sq-1\n');
    writeFileSync(
      join(runDir, 'fanout.json'),
      JSON.stringify({
        version: 1,
        mode: 'sync',
        agentName: 'web-researcher',
        tasks: [{ id: 'sq-1', prompt: 'p', state: 'completed' }],
      }),
    );
    writeFileSync(join(runDir, 'report.md'), ['# Report', '', '## A', '', 'Real prose [^1].', ''].join('\n'));

    const run = listRuns(sandbox).find((r) => r.slug === slug)!;

    expect(run.resumability).toBe('needs-review');
  });

  test('error rows carry resumability=error and costUsd stays null', () => {
    mkdirSync(join(sandbox, 'research', 'no-plan'), { recursive: true });
    const run = listRuns(sandbox).find((r) => r.slug === 'no-plan')!;

    expect(run.resumability).toBe('error');
    expect(run.costUsd).toBeNull();
  });

  test('costUsd is derived from cost-delta journal entries', () => {
    const journal =
      '## [2025-01-02T03:04:05.000Z] [step] cost delta · planning · 0.010000 USD\n' +
      '## [2025-01-02T03:05:35.000Z] [step] cost delta · fanout · 0.500000 USD\n';
    writeDemoRun(sandbox, 'withcost', demoPlan({ status: 'done' }), { journal });
    const run = listRuns(sandbox).find((r) => r.slug === 'withcost')!;

    expect(run.costUsd).toBeCloseTo(0.51, 6);
    expect(formatRunsTable([run])).toMatch(/\$0\.51/);
  });
});

// ───────────────────────────────────────────────────────────────────
// findExistingRun — slug-collision detection
// ───────────────────────────────────────────────────────────────────

describe('findExistingRun', () => {
  test('returns null when no research/ directory exists', () => {
    expect(findExistingRun(sandbox, 'What changed in React 19?')).toBeNull();
  });

  test('returns null when the derived slug is not on disk', () => {
    writeDemoRun(sandbox, 'different-slug', demoPlan({ status: 'done' }));

    expect(findExistingRun(sandbox, 'What changed in React 19?')).toBeNull();
  });

  test('returns the RunSummary when the slugified question matches an existing run', () => {
    // slugify("What changed in React 19?") → "what-changed-in-react-19"
    writeDemoRun(sandbox, 'what-changed-in-react-19', demoPlan({ status: 'done' }));
    const existing = findExistingRun(sandbox, 'What changed in React 19?');

    expect(existing).not.toBeNull();
    expect(existing!.slug).toBe('what-changed-in-react-19');
    expect(existing!.status).toBe('done');
  });

  test('carries the run\u2019s resumability verdict so the caller can render a prompt', () => {
    writeDemoRun(
      sandbox,
      'incomplete-slug',
      demoPlan({
        status: 'fanout',
        subQuestions: [
          { id: 'sq-1', question: 'A', status: 'pending' },
          { id: 'sq-2', question: 'B', status: 'pending' },
        ],
      }),
    );
    const existing = findExistingRun(sandbox, 'incomplete slug');

    expect(existing).not.toBeNull();
    expect(existing!.resumability).toBe('incomplete-fanout');
  });

  test('an empty question falls back to the timestamp-slug and still checks disk', () => {
    // slugify('') falls back to `r-<YYYYMMDD>-<HHMMSS>` — not on
    // disk, so we get null.
    expect(findExistingRun(sandbox, '   ')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// /research --selftest
// ──────────────────────────────────────────────────────────────────────

describe('/research --selftest', () => {
  test('reports success when selftestDeepResearch returns ok: true', async () => {
    const selftest = vi.fn<(opts: { cwd: string }) => Promise<SelftestResult>>().mockResolvedValue({
      ok: true,
      diffs: [],
      runRoot: '/tmp/fake-run-root',
    });
    const notify = mockNotify();

    await runSelftestCommand({ cwd: sandbox, selftest, notify });

    expect(selftest).toHaveBeenCalledTimes(1);
    expect(selftest).toHaveBeenCalledWith({ cwd: sandbox });
    expect(notify).toHaveBeenCalledTimes(1);

    const [message, level] = firstCall(notify);

    expect(level).toBe('info');
    expect(message).toContain('passed');
    expect(message).toContain('/tmp/fake-run-root');
  });

  test('reports failure with a per-diff summary when ok: false', async () => {
    const selftest = vi.fn<(opts: { cwd: string }) => Promise<SelftestResult>>().mockResolvedValue({
      ok: false,
      runRoot: '/tmp/fake-run-root',
      diffs: [
        { path: 'plan.json', kind: 'mismatch', expected: 'a', actual: 'b' },
        { path: 'report.md', kind: 'missing', expected: 'x' },
      ],
    });
    const notify = mockNotify();

    await runSelftestCommand({ cwd: sandbox, selftest, notify });

    expect(notify).toHaveBeenCalledTimes(1);

    const [message, level] = firstCall(notify);

    expect(level).toBe('error');
    expect(message).toContain('FAILED');
    expect(message).toContain('plan.json');
    expect(message).toContain('[mismatch]');
    expect(message).toContain('[missing]');
  });

  test('catches thrown errors and reports them as an error notify', async () => {
    const selftest = vi.fn<(opts: { cwd: string }) => Promise<SelftestResult>>().mockRejectedValue(new Error('boom'));
    const notify = mockNotify();

    await runSelftestCommand({ cwd: sandbox, selftest, notify });

    expect(notify).toHaveBeenCalledTimes(1);

    const [message, level] = firstCall(notify);

    expect(level).toBe('error');
    expect(message).toContain('threw during execution');
    expect(message).toContain('boom');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatSelftestResult (direct tests, for completeness)
// ──────────────────────────────────────────────────────────────────────

describe('formatSelftestResult', () => {
  test('collapses overflow diffs into a `… N more` footer', () => {
    const diffs = Array.from({ length: 13 }, (_, i) => ({
      path: `file-${i}.md`,
      kind: 'missing' as const,
      expected: '',
    }));
    const text = formatSelftestResult({ ok: false, runRoot: '/tmp/r', diffs });

    expect(text).toContain('file-0.md');
    expect(text).toContain('file-9.md');
    expect(text).not.toContain('file-10.md');
    expect(text).toContain('… 3 more');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 5 — `research` tool surface
// ──────────────────────────────────────────────────────────────────────
//
// These specs exercise the same helpers the extension shell wires
// into `pi.registerTool(...)`. The extension file itself has pi
// runtime imports we can't spin up under vitest, so we drive the
// pure `createResearchToolExecutor` factory with a scripted
// `runPipeline` to assert the same contract the LLM sees at the
// tool boundary: single-active-run invariant, summary surfaced,
// notify wired with the right level + report path.

describe('/research — model-driven research tool', () => {
  test('report-complete outcome surfaces the report path in the tool summary', async () => {
    const flag = createResearchSessionFlag();
    const runPipeline: ResearchToolRunner = () =>
      Promise.resolve<ResearchToolRunOutcome>({
        kind: 'report-complete',
        reportPath: '/tmp/research/demo/report.md',
        runRoot: '/tmp/research/demo',
        subjectiveApproved: true,
        summary: '/research: review PASSED after 1 iteration',
      });
    const notify = vi.fn<(m: string, l: 'info' | 'warning' | 'error') => void>();
    const execute = createResearchToolExecutor({ flag, runPipeline, notify });

    const result = await execute('when was Rust 1.0 released?');

    // Summary returned to the LLM points at the report.
    expect(result.outcome.kind).toBe('report-complete');
    expect(result.summary).toContain('/tmp/research/demo/report.md');

    // Notify fires once on completion with matching level.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('info');
    expect(notify.mock.calls[0][0]).toContain('/tmp/research/demo/report.md');
  });

  test('single-active-run invariant: a concurrent tool call errors out cleanly', async () => {
    const flag = createResearchSessionFlag();

    // A runner that resolves only when we say so.
    let firstResolve!: (o: ResearchToolRunOutcome) => void;
    const firstPending = new Promise<ResearchToolRunOutcome>((resolve) => {
      firstResolve = resolve;
    });
    const runPipeline: ResearchToolRunner = vi.fn<ResearchToolRunner>().mockImplementation(() => firstPending);

    const execute = createResearchToolExecutor({ flag, runPipeline });

    // Fire the first call but don't await it yet — it stays in flight.
    const firstP = execute('q1');
    // Give the event loop a turn so the executor has flipped `flag.active = true`.
    await Promise.resolve();

    expect(flag.active).toBe(true);

    // Second call while the first is in flight rejects with the
    // exact invariant error. The runner for the second call is
    // never invoked.
    await expect(execute('q2')).rejects.toThrow(SINGLE_ACTIVE_ERROR);
    expect(runPipeline).toHaveBeenCalledTimes(1);

    // Resolve the first so the test doesn't leak.
    firstResolve({
      kind: 'report-complete',
      reportPath: '/tmp/x/report.md',
      runRoot: '/tmp/x',
      subjectiveApproved: true,
    });
    await firstP;

    expect(flag.active).toBe(false);
  });

  test('session flag releases even when the runner throws', async () => {
    const flag = createResearchSessionFlag();
    const execute = createResearchToolExecutor({
      flag,
      runPipeline: () => Promise.reject(new Error('infra down')),
    });

    await expect(execute('q')).rejects.toThrow('infra down');
    expect(flag.active).toBe(false);

    // A second call now proceeds without hitting the invariant.
    const execute2 = createResearchToolExecutor({
      flag,
      runPipeline: () =>
        Promise.resolve<ResearchToolRunOutcome>({
          kind: 'fanout-complete',
          runRoot: '/tmp/x',
          completed: 1,
          failed: 0,
          aborted: 0,
        }),
    });
    const result = await execute2('q');

    expect(result.outcome.kind).toBe('fanout-complete');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 5 — statusline state machine drives the widget
// ──────────────────────────────────────────────────────────────────────
//
// The extension wires a `buildStatuslineController(ctx)` helper
// that wraps the pure reducer + renderer with a mutable state and
// a `ctx.ui.setWidget(...)` side-effect. This spec composes the
// same pure pieces and verifies that every phase transition
// produces a fresh widget body the extension would hand to
// `ctx.ui.setWidget("deep-research", lines)`.

describe('/research — statusline widget transitions', () => {
  test('every phase transition updates the widget contents', () => {
    // Fake `ctx.ui.setWidget` captures every call.
    interface WidgetCall {
      key: string;
      body: string[] | undefined;
    }
    const widgetCalls: WidgetCall[] = [];
    const setWidget = (key: string, body: string[] | undefined): void => {
      widgetCalls.push({ key, body: body ? [...body] : undefined });
    };

    // Build a mini controller that mirrors
    // `buildStatuslineController` in the extension.
    let state = initialStatuslineState(1_700_000_000_000);
    // `now` returns a growing clock so elapsed changes per tick.
    let clock = state.startedAt;
    const tick = (ms = 1_000): number => (clock += ms);
    const render = (): void => setWidget('deep-research', renderStatuslineWidget(state, clock));
    const emit = (e: PhaseEvent): void => {
      state = reduceStatusline(state, e);
      render();
    };

    // Full plan-to-done sequence per the Phase-5 handoff.
    const events: PhaseEvent[] = [
      { kind: 'planning' },
      { kind: 'self-crit' },
      { kind: 'plan-crit' },
      { kind: 'fanout-start', total: 6 },
      { kind: 'fanout-progress', done: 1 },
      { kind: 'fanout-progress', done: 2 },
      { kind: 'fanout-progress', done: 3 },
      { kind: 'fanout-progress', done: 6 },
      { kind: 'synth-start', total: 6 },
      { kind: 'synth-progress', done: 1 },
      { kind: 'synth-progress', done: 2 },
      { kind: 'merge' },
      { kind: 'structural', iteration: 1 },
      { kind: 'subjective', iteration: 1 },
      { kind: 'done', message: 'review passed' },
    ];
    for (const e of events) {
      tick();
      emit(e);
    }

    // One widget call per transition — no missed updates.
    expect(widgetCalls).toHaveLength(events.length);

    for (const c of widgetCalls) {
      expect(c.key).toBe('deep-research');
      expect(c.body).not.toBeUndefined();
      expect(c.body![0]).toMatch(/^deep-research: /);
    }

    // Spot-check: the label line moves through each expected
    // phase string in order.
    expect(widgetCalls.map((c) => (c.body ?? [])[0])).toEqual([
      'deep-research: planning',
      'deep-research: self-crit',
      'deep-research: plan-crit',
      'deep-research: fanout 0/6',
      'deep-research: fanout 1/6',
      'deep-research: fanout 2/6',
      'deep-research: fanout 3/6',
      'deep-research: fanout 6/6',
      'deep-research: synth 0/6',
      'deep-research: synth 1/6',
      'deep-research: synth 2/6',
      'deep-research: merge',
      'deep-research: structural (iter 1)',
      'deep-research: subjective (iter 1)',
      'deep-research: done',
    ]);

    // Line 2 carries elapsed + cost on every tick.
    for (const c of widgetCalls) {
      expect((c.body ?? [])[1]).toMatch(/^ {2}elapsed [0-9hms ]+ · cost \$\d+\.\d{3}$/);
    }

    // The terminal state includes a third message line.
    const finalBody = widgetCalls[widgetCalls.length - 1].body!;

    expect(finalBody).toHaveLength(3);
    expect(finalBody[2]).toBe('  review passed');
  });

  test('error events also update the widget and carry the reason', () => {
    const widgetCalls: (string[] | undefined)[] = [];
    let state = initialStatuslineState(0);
    const emit = (e: PhaseEvent): void => {
      state = reduceStatusline(state, e);
      widgetCalls.push(renderStatuslineWidget(state, 5_000));
    };

    emit({ kind: 'planning' });
    emit({ kind: 'error', message: 'planner stuck: too vague' });

    expect(widgetCalls.length).toBe(2);

    const last = widgetCalls[1]!;

    expect(last[0]).toBe('deep-research: error');
    expect(last[2]).toBe('  planner stuck: too vague');
  });
});

// ──────────────────────────────────────────────────────────────────────
// /research — stubbed short-circuit: wire emits exactly one notify,
// extension gate on `review.outcome.kind === 'stubbed'` suppresses the
// post-loop formatStubHint hint so the user (and the LLM tool caller)
// see one coherent "review skipped" message instead of two.
// ──────────────────────────────────────────────────────────────────────

describe('/research — stubbed review short-circuit notify discipline', () => {
  let sandbox: string;
  let cwd: string;
  let runRoot: string;
  let memoryRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pi-dr-stubbed-notify-'));
    cwd = join(sandbox, 'workspace');
    runRoot = join(cwd, 'research', 'demo');
    memoryRoot = join(sandbox, 'memory');
    mkdirSync(runRoot, { recursive: true });
    mkdirSync(memoryRoot, { recursive: true });
    writeFileSync(
      join(runRoot, 'report.md'),
      [
        '# report',
        '',
        '## What is A?',
        '',
        '[section unavailable: findings empty]',
        '',
        '## What is B?',
        '',
        '[section unavailable: fanout aborted]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(runRoot, 'plan.json'),
      JSON.stringify({
        kind: 'deep-research',
        version: 1,
        question: 'demo',
        slug: 'demo',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'planning',
        budget: { maxSubagents: 2, maxFetches: 10, maxCostUsd: 1, wallClockSec: 60 },
        subQuestions: [
          { id: 'sq-1', question: 'What is A?', status: 'pending' },
          { id: 'sq-2', question: 'What is B?', status: 'pending' },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test('runDeepResearchReview short-circuits without calling any runner and notifies exactly once', async () => {
    const runStructural = vi.fn<StructuralRunner>();
    const runCritic = vi.fn<CriticRunner>();
    const refineReport: RefinementRunner = vi.fn(() => Promise.resolve({ ok: true as const }));
    const notify = vi.fn<(m: string, l: CommandNotifyLevel) => void>();

    const result: ReviewWireResult = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport,
      maxIter: 4,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'stubbed');

    // The wire's stubbed short-circuit is the single source of truth
    // for the recovery notify. The extension's post-loop call site
    // guards `formatStubHint` behind `review?.outcome.kind !== 'stubbed'`
    // so these two observations together prove there's no double-emit:
    //
    //   1. Wire notified exactly once with the resolved --sq command.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('warning');
    expect(notify.mock.calls[0][0]).toContain('review skipped');
    expect(notify.mock.calls[0][0]).toContain('--sq=sq-1,sq-2');

    //   2. The extension's gate expression returns null on this path,
    //      so the post-loop `notify(stubHint, 'warning')` never fires.
    const stubHint = result.outcome.kind === 'stubbed' ? null : formatStubHint(runRoot);

    expect(stubHint).toBeNull();

    // Neither runner ever ran — the loop's cross-stage budget stays
    // untouched so a subsequent /research --resume --from=fanout can
    // pick up the full `reviewMaxIter` budget on its review phase.
    expect(runStructural).not.toHaveBeenCalled();
    expect(runCritic).not.toHaveBeenCalled();
    expect(refineReport).not.toHaveBeenCalled();
  });

  test('non-stubbed reviews still emit the post-loop formatStubHint notify (regression guard)', () => {
    // Baseline: on a non-stubbed review outcome the extension must
    // keep calling `formatStubHint`, so a stubbed report that
    // somehow slipped past the wire (defensive second layer) still
    // produces a recovery hint. The gate is outcome-kind-scoped,
    // not globally suppressing the hint.
    //
    // Simulate the extension's expression with a passed outcome.
    // `formatStubHint` still scans the report on disk, so this path
    // surfaces the same recovery command the user got via the wire
    // when the wire short-circuit fires. The two paths differ only
    // in which one emits — never both.
    const passedLike = { kind: 'passed' as const };
    const stubHint = (passedLike.kind as string) === 'stubbed' ? null : formatStubHint(runRoot);

    expect(stubHint).not.toBeNull();
    expect(stubHint).toContain('--sq=sq-1,sq-2');
  });
});
