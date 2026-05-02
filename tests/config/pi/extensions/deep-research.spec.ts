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

import { type AutoresearchPlan, type DeepResearchPlan } from '../../../../lib/node/pi/research-plan.ts';
import {
  type CommandNotify,
  type CommandNotifyLevel,
  formatRunsTable,
  formatSelftestResult,
  listRuns,
  runListCommand,
  runSelftestCommand,
  type RunSummary,
} from '../../../../lib/node/pi/research-runs.ts';
import { type SelftestResult } from '../../../../lib/node/pi/research-selftest.ts';

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
      { slug: 'demo', status: 'fanout', wallClockSec: null, costUsd: null, error: null },
    ]);

    const notify = mockNotify();
    runListCommand({ cwd: sandbox, notify });

    expect(notify).toHaveBeenCalledTimes(1);

    const [message, level] = firstCall(notify);

    expect(level).toBe('info');
    // Header row present.
    expect(message).toMatch(/slug\s*\|\s*status\s*\|\s*wall-clock\s*\|\s*cost/);
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
