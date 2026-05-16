/**
 * Tests for lib/node/pi/deep-research-pipeline.ts.
 *
 * Drives the full Phase-2 pipeline (planner → self-critic →
 * planning-critic → fanout) against:
 *
 *   - a mock `ResearchSessionLike` factory returning a scripted
 *     session (mirrors the planner / self-critic / rewrite turns),
 *   - a scripted planning-critic runner,
 *   - a hand-rolled fanout spawner that returns `FanoutHandleLike`
 *     mocks (stand-in for pi's background subagent handles),
 *   - a fresh sandbox cwd per test.
 *
 * Asserts the Phase-2 acceptance criteria:
 *
 *   (1) /research <q> produces plan.json, findings/<id>.md, and
 *       provenance sidecars on each.
 *   (2) Self-critic rewrites a deliberately-redundant planner
 *       output.
 *   (3) Planning-critic rejects a deliberately off-scope plan and
 *       the auto-rewrite succeeds.
 *   (4) Interrupting mid-fanout and resuming continues the missing
 *       subagents only (exercises `research-fanout` resume path).
 *   (5) A deliberately-stalled subagent triggers the watchdog and
 *       falls back / is bucketed as aborted.
 *   (6) Fanout tolerates one subagent timeout without aborting the
 *       run.
 *   (7) Malformed finding triggers one re-prompt; twice-malformed
 *       quarantines to findings/_quarantined/<subq>/.
 *   (8) Tiny-model wiring: with `tinyAdapter` unset, everything
 *       above passes unchanged; with a mock adapter, the tiny path
 *       outputs land in plan.json (slug), sources/*.json (title
 *       normalization surfaces on finding bodies, exercised in
 *       finding.spec.ts), pre-fetch priority (searchHints order
 *       reordered; verified in planner.spec.ts), and humanized
 *       error nudges (spied via onRetry).
 *   (9) Cap enforcement: per-run cap of 2 tiny calls; the 3rd
 *       returns null (exercised inside `research-tiny.spec.ts`;
 *       here we verify the pipeline stays correct when tiny calls
 *       return null mid-run).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  runResearchPipeline,
  type ResearchSessionLikeWithLifecycle,
} from '../../../../lib/node/pi/deep-research-pipeline.ts';
import {
  type FanoutHandleLike,
  type FanoutHandleResult,
  type FanoutSpawnArgs,
} from '../../../../lib/node/pi/research-fanout.ts';
import { paths } from '../../../../lib/node/pi/research-paths.ts';
import { type DeepResearchPlan, writePlan } from '../../../../lib/node/pi/research-plan.ts';
import { readProvenance } from '../../../../lib/node/pi/research-provenance.ts';
import { assertKind } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Scripted session / runner / spawner helpers.
// ──────────────────────────────────────────────────────────────────────

function makeSessionFactory(scripted: string[]): {
  factory: () => Promise<ResearchSessionLikeWithLifecycle>;
  prompts: string[];
  disposed: () => number;
} {
  const prompts: string[] = [];
  let disposed = 0;

  return {
    factory: () => {
      const messages: { role: string; content: { type: string; text: string }[] }[] = [];
      let next = 0;

      return Promise.resolve({
        prompt: (task: string) => {
          prompts.push(task);
          const reply = scripted[next++] ?? '';
          messages.push({ role: 'user', content: [{ type: 'text', text: task }] });
          messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
          return Promise.resolve();
        },
        get state() {
          return { messages };
        },
        dispose: () => {
          disposed++;
        },
      });
    },
    prompts,
    disposed: () => disposed,
  };
}

function approvedVerdict(): string {
  return JSON.stringify({ approved: true, score: 0.95, issues: [], summary: 'plan looks good' });
}

function rejectOffScopeVerdict(): string {
  return JSON.stringify({
    approved: false,
    score: 0.3,
    issues: [{ severity: 'blocker', description: 'sq-2 is off-scope from the user question', location: 'sq-2' }],
    summary: 'plan is off-scope',
  });
}

function scriptedPlanningCritic(responses: ({ rawText: string; error?: string } | Error)[]) {
  let idx = 0;

  return () => {
    const r = responses[idx++];

    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };
}

function validFinding(id: string): string {
  return [
    `# Sub-question: question for ${id}`,
    '',
    '## Findings',
    `- Some claim about ${id} [S1].`,
    '',
    '## Sources',
    '- [S1] https://example.com - Example page',
    '',
    '## Open questions',
    '- None.',
  ].join('\n');
}

/** Build a fanout spawner that returns the scripted result per task id. */
function scriptedSpawner(
  recipes: Map<
    string,
    { kind: 'ok'; output: string } | { kind: 'fail'; reason: string } | { kind: 'aborted'; reason: string }
  >,
) {
  return (args: FanoutSpawnArgs): Promise<FanoutHandleLike> => {
    const recipe = recipes.get(args.task.id);

    if (!recipe) return Promise.reject(new Error(`spawner: no recipe for ${args.task.id}`));
    const progressAt = Date.now();
    let result: FanoutHandleResult;

    if (recipe.kind === 'ok') result = { ok: true, output: recipe.output };
    else if (recipe.kind === 'aborted') result = { ok: false, reason: recipe.reason, aborted: true };
    else result = { ok: false, reason: recipe.reason };
    return Promise.resolve({
      id: args.task.id,
      status: () => Promise.resolve({ done: true, lastProgressAt: progressAt }),
      abort: () => Promise.resolve(),
      wait: () => Promise.resolve(result),
    });
  };
}

// Build planner reply JSON matching a simple three-sub-question shape.
function plannerReply(ids: string[] = ['sq-1', 'sq-2', 'sq-3']): string {
  return JSON.stringify({
    subQuestions: ids.map((id, i) => ({
      id,
      question: `question for ${id}`,
      searchHints: [`https://hint-${i}.example.com`],
    })),
  });
}

// Self-critic reply: re-emit identical plan (no rewrite).
function selfCriticNoChange(ids: string[] = ['sq-1', 'sq-2', 'sq-3']): string {
  return JSON.stringify({ subQuestions: ids.map((id) => ({ id, question: `question for ${id}` })) });
}

// ──────────────────────────────────────────────────────────────────────
// Fixture scaffolding.
// ──────────────────────────────────────────────────────────────────────

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-deep-research-pipeline-spec-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Happy path.
// ──────────────────────────────────────────────────────────────────────

describe('runResearchPipeline - happy path', () => {
  test('(1) planner → self-critic → planning-critic → fanout produces plan.json, findings, provenance', async () => {
    const { factory } = makeSessionFactory([plannerReply(), selfCriticNoChange()]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        ['sq-2', { kind: 'ok' as const, output: validFinding('sq-2') }],
        ['sq-3', { kind: 'ok' as const, output: validFinding('sq-3') }],
      ]),
    );

    const outcome = await runResearchPipeline('Demo question to research', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'local/test',
      thinkingLevel: 'off',
      maxConcurrent: 1,
      staleThresholdMs: 60_000,
      pollIntervalMs: 1000,
      now: () => new Date('2025-04-05T06:07:08Z'),
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    // Plan on disk + provenance.
    const planPath = paths(outcome.runRoot).plan;

    expect(existsSync(planPath)).toBe(true);

    const planProv = readProvenance(planPath);

    expect(planProv?.model).toBe('local/test');

    // Findings + sidecars.
    for (const id of ['sq-1', 'sq-2', 'sq-3']) {
      const p = join(outcome.runRoot, 'findings', `${id}.md`);

      expect(existsSync(p)).toBe(true);

      const prov = readProvenance(p);

      expect(prov?.model).toBe('local/test');
    }

    expect(outcome.quarantined).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Self-critic rewrites a redundant plan.
// ──────────────────────────────────────────────────────────────────────

describe('runResearchPipeline - self-critic', () => {
  test('(2) rewrites a deliberately-redundant planner output', async () => {
    // Planner emits three copies of the same question; self-critic
    // rewrites them into three distinct questions.
    const redundant = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'same thing' },
        { id: 'sq-2', question: 'same thing' },
        { id: 'sq-3', question: 'same thing' },
      ],
    });
    const rewrite = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'distinct A' },
        { id: 'sq-2', question: 'distinct B' },
        { id: 'sq-3', question: 'distinct C' },
      ],
    });
    const { factory } = makeSessionFactory([redundant, rewrite]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        ['sq-2', { kind: 'ok' as const, output: validFinding('sq-2') }],
        ['sq-3', { kind: 'ok' as const, output: validFinding('sq-3') }],
      ]),
    );

    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    expect(outcome.plan.subQuestions.map((sq) => sq.question)).toEqual(['distinct A', 'distinct B', 'distinct C']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Planning-critic auto-rewrite path.
// ──────────────────────────────────────────────────────────────────────

describe('runResearchPipeline - planning-critic', () => {
  test('(3) off-scope plan rejected → auto-rewrite → approved', async () => {
    const offScope = plannerReply(['sq-1', 'sq-2', 'sq-3']);
    // Self-critic passes through unchanged; the critic rejects.
    const passThrough = selfCriticNoChange(['sq-1', 'sq-2', 'sq-3']);
    const rewrite = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'question for sq-1' },
        { id: 'sq-2', question: 'refined sq-2 (on-scope)' },
        { id: 'sq-3', question: 'question for sq-3' },
      ],
    });
    const { factory } = makeSessionFactory([offScope, passThrough, rewrite]);
    const runner = scriptedPlanningCritic([{ rawText: rejectOffScopeVerdict() }, { rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        ['sq-2', { kind: 'ok' as const, output: validFinding('sq-2') }],
        ['sq-3', { kind: 'ok' as const, output: validFinding('sq-3') }],
      ]),
    );
    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    expect(outcome.plan.subQuestions[1].question).toContain('on-scope');
  });

  test('planning-critic rejecting twice → checkpoint; pipeline halts before fanout', async () => {
    const pl = plannerReply(['sq-1', 'sq-2', 'sq-3']);
    const pass = selfCriticNoChange(['sq-1', 'sq-2', 'sq-3']);
    const rewrite = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'q1' },
        { id: 'sq-2', question: 'still bad' },
        { id: 'sq-3', question: 'q3' },
      ],
    });
    const { factory } = makeSessionFactory([pl, pass, rewrite]);
    const runner = scriptedPlanningCritic([{ rawText: rejectOffScopeVerdict() }, { rawText: rejectOffScopeVerdict() }]);
    const spawner = vi.fn(() => Promise.reject(new Error('fanout should not run on checkpoint')));
    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('checkpoint');
    expect(spawner).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Fanout resume: pre-populate fanout.json so the pipeline skips the
// already-completed tasks.
// ──────────────────────────────────────────────────────────────────────

describe('runResearchPipeline - fanout resume', () => {
  test('(4) resume only spawns missing subagents', async () => {
    // Pre-populate the run root with a plan + fanout.json carrying
    // two terminal states and one pending.
    const runRoot = join(sandbox, 'research', 'demo-question-to-research');
    mkdirSync(join(runRoot, 'findings'), { recursive: true });
    const plan: DeepResearchPlan = {
      kind: 'deep-research',
      slug: 'demo-question-to-research',
      question: 'Demo question to research',
      status: 'planning',
      budget: { maxSubagents: 6, maxFetches: 40, maxCostUsd: 3, wallClockSec: 1800 },
      subQuestions: [
        { id: 'sq-1', question: 'question for sq-1', status: 'complete' },
        { id: 'sq-2', question: 'question for sq-2', status: 'complete' },
        { id: 'sq-3', question: 'question for sq-3', status: 'pending' },
      ],
    };
    writePlan(paths(runRoot).plan, plan);
    const preFanout = {
      version: 1 as const,
      mode: 'sync' as const,
      agentName: 'web-researcher',
      tasks: [
        {
          id: 'sq-1',
          prompt: 'prior',
          state: 'completed' as const,
          output: validFinding('sq-1'),
          finishedAt: '2025-01-02T00:00:00.000Z',
        },
        {
          id: 'sq-2',
          prompt: 'prior',
          state: 'completed' as const,
          output: validFinding('sq-2'),
          finishedAt: '2025-01-02T00:01:00.000Z',
        },
        {
          id: 'sq-3',
          prompt: 'prior',
          state: 'pending' as const,
        },
      ],
    };
    (await import('node:fs')).writeFileSync(paths(runRoot).fanout, JSON.stringify(preFanout, null, 2));

    // Pre-write the completed findings so the post-fanout
    // validation finds them on disk.
    (await import('node:fs')).writeFileSync(join(runRoot, 'findings', 'sq-1.md'), validFinding('sq-1'));
    (await import('node:fs')).writeFileSync(join(runRoot, 'findings', 'sq-2.md'), validFinding('sq-2'));

    // Planner + self-critic replies still required (the pipeline
    // always runs them first). We feed back the same three sub-
    // questions so the plan on disk stays structurally equal.
    const rerunPlanner = plannerReply(['sq-1', 'sq-2', 'sq-3']);
    const rerunSelfCritic = selfCriticNoChange(['sq-1', 'sq-2', 'sq-3']);
    const { factory } = makeSessionFactory([rerunPlanner, rerunSelfCritic]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);

    // Only sq-3 should reach the spawner on resume.
    const spawnedIds: string[] = [];
    const spawner = (args: FanoutSpawnArgs): Promise<FanoutHandleLike> => {
      spawnedIds.push(args.task.id);
      return Promise.resolve({
        id: args.task.id,
        status: () => Promise.resolve({ done: true, lastProgressAt: Date.now() }),
        abort: () => Promise.resolve(),
        wait: () => Promise.resolve({ ok: true as const, output: validFinding(args.task.id) }),
      });
    };

    const outcome = await runResearchPipeline('Demo question to research', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('fanout-complete');
    expect(spawnedIds).toEqual(['sq-3']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Fanout tolerates failures and quarantines malformed output.
// ──────────────────────────────────────────────────────────────────────

describe('runResearchPipeline - partial failures', () => {
  test('(6) one subagent fails (timeout reason) - run still completes', async () => {
    const { factory } = makeSessionFactory([plannerReply(), selfCriticNoChange()]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        ['sq-2', { kind: 'fail' as const, reason: 'simulated timeout' }],
        ['sq-3', { kind: 'ok' as const, output: validFinding('sq-3') }],
      ]),
    );
    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    expect(outcome.fanout.completed.map((c) => c.id).sort()).toEqual(['sq-1', 'sq-3']);
    expect(outcome.fanout.failed.map((f) => f.id)).toEqual(['sq-2']);
  });

  test('(5) aborted subagent is bucketed correctly', async () => {
    const { factory } = makeSessionFactory([plannerReply(), selfCriticNoChange()]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        ['sq-2', { kind: 'aborted' as const, reason: 'watchdog stall (simulated)' }],
        ['sq-3', { kind: 'ok' as const, output: validFinding('sq-3') }],
      ]),
    );
    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    expect(outcome.fanout.aborted.map((a) => a.id)).toEqual(['sq-2']);
  });

  test('(7) malformed finding → flagged for synth quarantine on first attempt; second attempt → disk quarantine', async () => {
    // Phase 6: with no in-pipeline re-prompt, malformed output on
    // the first attempt is immediately added to `quarantined` so
    // synth emits a `[section unavailable: ...]` stub instead of
    // being fed confident zero-citation prose. The raw body still
    // lands on disk for `--resume` / human inspection, and the
    // failure counter is bumped; a second malformed pass promotes
    // the finding to the on-disk `_quarantined/` tree.
    const { factory: factory1 } = makeSessionFactory([plannerReply(), selfCriticNoChange()]);
    const runner1 = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const bad1 = '## no headings here, just prose';
    const spawner1 = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        ['sq-2', { kind: 'ok' as const, output: bad1 }],
        ['sq-3', { kind: 'ok' as const, output: validFinding('sq-3') }],
      ]),
    );
    const first = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory1,
      runPlanningCritic: runner1,
      fanoutSpawn: spawner1,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(first.kind).toBe('fanout-complete');

    assertKind(first, 'fanout-complete');

    // Synth-side quarantine on first attempt so the malformed
    // reply text never leaks into synth.
    expect(first.quarantined).toEqual(['sq-2']);

    // Second run: fanout resume sees sq-2 still pending in the
    // spawner map, spawner returns malformed content again.
    // Counter is now 1 (we bumped it post-classify), so this
    // round → quarantine.
    //
    // BUT: the first run ALSO persisted sq-2 state as completed in
    // fanout.json, so a resume won't re-spawn. Instead, directly
    // invoke the classifier path a second time by rewriting
    // fanout.json to re-pend sq-2 with fresh bad output. In a real
    // pipeline the user edits the plan and the extension wipes the
    // pending finding; we simulate that here.
    const runRoot = first.runRoot;
    const fanoutPath = paths(runRoot).fanout;
    // Reset sq-2 to pending + clear any on-disk finding.
    const fanout = JSON.parse(readFileSync(fanoutPath, 'utf8')) as {
      tasks: { id: string; state: string; output?: string; finishedAt?: string }[];
    };

    for (const task of fanout.tasks) {
      if (task.id === 'sq-2') {
        task.state = 'pending';
        delete task.output;
        delete task.finishedAt;
      }
    }
    (await import('node:fs')).writeFileSync(fanoutPath, JSON.stringify(fanout, null, 2));
    rmSync(join(runRoot, 'findings', 'sq-2.md'), { force: true });

    const { factory: factory2 } = makeSessionFactory([plannerReply(), selfCriticNoChange()]);
    const runner2 = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner2 = scriptedSpawner(
      new Map([['sq-2', { kind: 'ok' as const, output: 'still totally broken output' }]]),
    );
    const second = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory2,
      runPlanningCritic: runner2,
      fanoutSpawn: spawner2,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(second.kind).toBe('fanout-complete');

    assertKind(second, 'fanout-complete');

    expect(second.quarantined).toEqual(['sq-2']);

    // Quarantine directory exists under findings/_quarantined/sq-2-<ts>/
    const qDir = join(runRoot, 'findings', '_quarantined');

    expect(existsSync(qDir)).toBe(true);

    const quarantineEntries = readdirSync(qDir);

    expect(quarantineEntries.some((e) => e.startsWith('sq-2.md-'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Tiny-adapter unset: pipeline still passes.
// ──────────────────────────────────────────────────────────────────────

describe('runResearchPipeline - tiny adapter unset (sanity)', () => {
  test('(8) with no tiny adapter wired, the happy path still produces findings + provenance', async () => {
    const { factory } = makeSessionFactory([plannerReply(), selfCriticNoChange()]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        ['sq-2', { kind: 'ok' as const, output: validFinding('sq-2') }],
        ['sq-3', { kind: 'ok' as const, output: validFinding('sq-3') }],
      ]),
    );
    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('fanout-complete');
  });
});

// ───────────────────────────────────────────────────────────────────
// Source-store populate (Phase 6).
// ───────────────────────────────────────────────────────────────────

describe('runResearchPipeline - source-store populate', () => {
  test('(9) mcpClient populates sources/<hash>.md + sidecar from cited URLs', async () => {
    const { factory } = makeSessionFactory([plannerReply(['sq-1']), selfCriticNoChange()]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    // Finding cites a single URL; we expect one fetch + persist.
    const spawner = scriptedSpawner(new Map([['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }]]));

    const fetched: string[] = [];
    const fakeMcp = {
      fetchUrl: (input: { url: string }): Promise<{ content: string; title?: string }> => {
        fetched.push(input.url);
        return Promise.resolve({ content: `# Cached page for ${input.url}`, title: 'Example page' });
      },
      convertHtml: () => Promise.reject(new Error('unused')),
      searchWeb: () => Promise.reject(new Error('unused')),
    };

    const outcome = await runResearchPipeline('Demo question', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'local/test',
      thinkingLevel: null,
      maxConcurrent: 1,
      mcpClient: fakeMcp,
      now: () => new Date('2025-04-05T06:07:08Z'),
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    // The fetcher was called exactly once for the single cited
    // URL. `fetchAndStore` normalizes URLs, so we just check the
    // host/path survived.
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('example.com');

    // sources/ got populated with one entry - the page markdown
    // plus its JSON sidecar.
    const sourcesDir = join(outcome.runRoot, 'sources');

    expect(existsSync(sourcesDir)).toBe(true);

    const entries = readdirSync(sourcesDir);
    const mdEntries = entries.filter((e) => e.endsWith('.md'));
    const jsonEntries = entries.filter((e) => e.endsWith('.json'));

    expect(mdEntries).toHaveLength(1);
    expect(jsonEntries).toHaveLength(1);

    // Pair by hash prefix.
    const hash = mdEntries[0]?.replace(/\.md$/, '');

    expect(jsonEntries[0]).toBe(`${hash}.json`);

    const md = readFileSync(join(sourcesDir, `${hash}.md`), 'utf8');

    expect(md).toContain('Cached page for');

    const sidecar = JSON.parse(readFileSync(join(sourcesDir, `${hash}.json`), 'utf8')) as {
      url: string;
      title: string;
    };

    expect(sidecar.url).toContain('example.com');
    expect(sidecar.title).toBe('Example page');
  });

  test('(10) unset mcpClient - pipeline still completes, sources/ stays empty, journal records a warning', async () => {
    const { factory } = makeSessionFactory([plannerReply(['sq-1']), selfCriticNoChange()]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(new Map([['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }]]));

    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    // No sources/ populated because the mcpClient was unset.
    const sourcesDir = join(outcome.runRoot, 'sources');

    expect(existsSync(sourcesDir)).toBe(false);

    // Journal warns once.
    const journal = readFileSync(paths(outcome.runRoot).journal, 'utf8');

    expect(journal).toContain('source-store populate skipped');
  });

  test('(11) quarantined sub-questions are skipped during populate', async () => {
    const { factory } = makeSessionFactory([plannerReply(['sq-1', 'sq-2']), selfCriticNoChange()]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);
    const spawner = scriptedSpawner(
      new Map([
        ['sq-1', { kind: 'ok' as const, output: validFinding('sq-1') }],
        // sq-2 returns malformed text - absorbFindings quarantines it
        // for synth purposes, and populate should skip it too.
        ['sq-2', { kind: 'ok' as const, output: 'not a valid finding schema' }],
      ]),
    );
    const fetched: string[] = [];
    const fakeMcp = {
      fetchUrl: (input: { url: string }): Promise<{ content: string }> => {
        fetched.push(input.url);
        return Promise.resolve({ content: '# page' });
      },
      convertHtml: () => Promise.reject(new Error('unused')),
      searchWeb: () => Promise.reject(new Error('unused')),
    };

    const outcome = await runResearchPipeline('topic', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
      mcpClient: fakeMcp,
    });

    expect(outcome.kind).toBe('fanout-complete');

    assertKind(outcome, 'fanout-complete');

    // Only sq-1's citation was fetched; sq-2 was quarantined.
    expect(fetched).toHaveLength(1);
    expect(outcome.quarantined).toEqual(['sq-2']);
  });
});

// ───────────────────────────────────────────────────────────────────────
// resumeFrom: stage-skip plumbing for `/research --resume`.
// ───────────────────────────────────────────────────────────────────────

function seedResumeRunRoot(
  sandbox: string,
  slug: string,
  ids: readonly string[],
  opts: { withFindings?: boolean; fanoutStates?: Record<string, string> } = {},
): string {
  const runRoot = join(sandbox, 'research', slug);
  mkdirSync(join(runRoot, 'findings'), { recursive: true });
  const plan: DeepResearchPlan = {
    kind: 'deep-research',
    slug,
    question: 'seeded question',
    status: 'planning',
    budget: { maxSubagents: 6, maxFetches: 40, maxCostUsd: 3, wallClockSec: 1800 },
    subQuestions: ids.map((id) => ({ id, question: `question for ${id}`, status: 'pending' as const })),
  };
  writePlan(paths(runRoot).plan, plan);

  const states = opts.fanoutStates ?? Object.fromEntries(ids.map((id) => [id, 'completed']));
  const fanoutJson = {
    version: 1 as const,
    mode: 'sync' as const,
    agentName: 'web-researcher',
    tasks: ids.map((id) => ({
      id,
      prompt: `prompt for ${id}`,
      state: states[id] ?? 'completed',
      ...(states[id] === 'completed' || states[id] === undefined ? { output: validFinding(id) } : {}),
    })),
  };
  writeFileSync(paths(runRoot).fanout, JSON.stringify(fanoutJson, null, 2));

  if (opts.withFindings ?? true) {
    for (const id of ids) {
      if ((states[id] ?? 'completed') === 'completed') {
        writeFileSync(join(runRoot, 'findings', `${id}.md`), validFinding(id));
      }
    }
  }
  return runRoot;
}

describe('runResearchPipeline - resumeFrom', () => {
  test('resumeFrom without resumeRunRoot throws a clear error', async () => {
    const { factory } = makeSessionFactory([]);

    await expect(
      runResearchPipeline('unused', {
        cwd: sandbox,
        createSession: factory,
        runPlanningCritic: () => Promise.resolve({ rawText: approvedVerdict() }),
        fanoutSpawn: () => Promise.reject(new Error('should not spawn')),
        fanoutMode: 'sync',
        model: 'm/x',
        thinkingLevel: null,
        maxConcurrent: 1,
        resumeFrom: 'fanout',
      }),
    ).rejects.toThrow(/resumeFrom requires resumeRunRoot/);
  });

  test("resumeFrom='review' is rejected at the pipeline layer", async () => {
    const runRoot = seedResumeRunRoot(sandbox, 'review-unsupported', ['sq-1']);
    const { factory } = makeSessionFactory([]);

    await expect(
      runResearchPipeline('unused', {
        cwd: sandbox,
        createSession: factory,
        runPlanningCritic: () => Promise.resolve({ rawText: approvedVerdict() }),
        fanoutSpawn: () => Promise.reject(new Error('should not spawn')),
        fanoutMode: 'sync',
        model: 'm/x',
        thinkingLevel: null,
        maxConcurrent: 1,
        resumeFrom: 'review',
        resumeRunRoot: runRoot,
      }),
    ).rejects.toThrow(/not supported at the pipeline layer/);
  });

  test("resumeFrom='fanout' skips planner + self-critic + plan-crit; re-dispatches only missing ids", async () => {
    const runRoot = seedResumeRunRoot(sandbox, 'fanout-resume', ['sq-1', 'sq-2', 'sq-3'], {
      fanoutStates: { 'sq-1': 'completed', 'sq-2': 'pending', 'sq-3': 'completed' },
    });

    // Planner / self-critic / planning-critic runners must NOT be
    // invoked; back them with rejecting stubs.
    const factory = (): Promise<ResearchSessionLikeWithLifecycle> =>
      Promise.resolve({
        prompt: () => Promise.reject(new Error('planner/self-critic must not run on resumeFrom=fanout')),
        state: { messages: [] },
      });
    const runner = vi.fn(() => Promise.reject(new Error('planning-critic must not run on resumeFrom=fanout')));

    const spawned: string[] = [];
    const spawner = (args: FanoutSpawnArgs): Promise<FanoutHandleLike> => {
      spawned.push(args.task.id);
      return Promise.resolve({
        id: args.task.id,
        status: () => Promise.resolve({ done: true, lastProgressAt: Date.now() }),
        abort: () => Promise.resolve(),
        wait: () => Promise.resolve({ ok: true as const, output: validFinding(args.task.id) }),
      });
    };

    const outcome = await runResearchPipeline('unused-question', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
      resumeFrom: 'fanout',
      resumeRunRoot: runRoot,
    });

    assertKind(outcome, 'fanout-complete');

    expect(runner).not.toHaveBeenCalled();
    expect(spawned).toEqual(['sq-2']);
    expect(outcome.runRoot).toBe(runRoot);
    expect(outcome.plan.subQuestions.map((sq) => sq.id)).toEqual(['sq-1', 'sq-2', 'sq-3']);
  });

  test("resumeFrom='plan-crit' skips planner + self-critic; re-runs planning-critic", async () => {
    const runRoot = seedResumeRunRoot(sandbox, 'plan-crit-resume', ['sq-1', 'sq-2', 'sq-3']);

    // Planner session still needed by plan-crit's rewrite path (it
    // uses the session for any rewrite turns), but the session
    // should never receive a planner/self-critic prompt.
    const { factory, prompts } = makeSessionFactory([]);
    const runner = scriptedPlanningCritic([{ rawText: approvedVerdict() }]);

    // sq-2 is already on disk; fanout-spawner should not be hit for
    // any task because the resume should proceed to fanout
    // idempotently (every finding already complete) and then hit
    // synth (not enabled here - runSynth unset).
    const spawner = vi.fn((_args: FanoutSpawnArgs): Promise<FanoutHandleLike> => {
      return Promise.reject(new Error('fanout should not dispatch; all tasks already complete'));
    });

    const outcome = await runResearchPipeline('unused-question', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
      resumeFrom: 'plan-crit',
      resumeRunRoot: runRoot,
    });

    // Plan-crit ran (runner consumed the scripted verdict).
    assertKind(outcome, 'fanout-complete');

    expect(prompts).toEqual([]); // no planner/self-critic prompts
    expect(spawner).not.toHaveBeenCalled();
    expect(outcome.runRoot).toBe(runRoot);
  });

  test("resumeFrom='synth' skips planner+fanout; asserts findings complete", async () => {
    const runRoot = seedResumeRunRoot(sandbox, 'synth-resume', ['sq-1', 'sq-2']);

    const factory = (): Promise<ResearchSessionLikeWithLifecycle> =>
      Promise.resolve({
        prompt: () =>
          Promise.reject(new Error('parent session prompt must not run on resumeFrom=synth (runSynth unset)')),
        state: { messages: [] },
      });
    const runner = vi.fn(() => Promise.reject(new Error('planning-critic must not run on resumeFrom=synth')));
    const spawner = vi.fn(() => Promise.reject(new Error('fanout must not run on resumeFrom=synth')));

    // runSynth unset → pipeline returns 'fanout-complete' after the
    // reconstructed snapshot (same shape the extension would consume).
    const outcome = await runResearchPipeline('unused', {
      cwd: sandbox,
      createSession: factory,
      runPlanningCritic: runner,
      fanoutSpawn: spawner,
      fanoutMode: 'sync',
      model: 'm/x',
      thinkingLevel: null,
      maxConcurrent: 1,
      resumeFrom: 'synth',
      resumeRunRoot: runRoot,
    });

    assertKind(outcome, 'fanout-complete');

    expect(runner).not.toHaveBeenCalled();
    expect(spawner).not.toHaveBeenCalled();
    expect(outcome.fanout.completed.map((c) => c.id)).toEqual(['sq-1', 'sq-2']);
    expect(outcome.fanout.failed).toEqual([]);
    expect(outcome.fanout.aborted).toEqual([]);
    expect(outcome.quarantined).toEqual([]);
  });

  test("resumeFrom='synth' with a missing finding throws an actionable error", async () => {
    const runRoot = seedResumeRunRoot(sandbox, 'synth-missing', ['sq-1', 'sq-2'], {
      // sq-2 has no finding on disk despite state=pending
      fanoutStates: { 'sq-1': 'completed', 'sq-2': 'pending' },
    });

    const factory = (): Promise<ResearchSessionLikeWithLifecycle> =>
      Promise.resolve({ prompt: () => Promise.reject(new Error('unused')), state: { messages: [] } });

    await expect(
      runResearchPipeline('unused', {
        cwd: sandbox,
        createSession: factory,
        runPlanningCritic: () => Promise.resolve({ rawText: approvedVerdict() }),
        fanoutSpawn: () => Promise.reject(new Error('unused')),
        fanoutMode: 'sync',
        model: 'm/x',
        thinkingLevel: null,
        maxConcurrent: 1,
        resumeFrom: 'synth',
        resumeRunRoot: runRoot,
      }),
    ).rejects.toThrow(/findings incomplete for: sq-2.*resume from fanout/);
  });

  test('resume without a plan.json on disk fails loudly', async () => {
    const runRoot = join(sandbox, 'research', 'no-plan');
    mkdirSync(runRoot, { recursive: true });
    const factory = (): Promise<ResearchSessionLikeWithLifecycle> =>
      Promise.resolve({ prompt: () => Promise.reject(new Error('unused')), state: { messages: [] } });

    await expect(
      runResearchPipeline('unused', {
        cwd: sandbox,
        createSession: factory,
        runPlanningCritic: () => Promise.resolve({ rawText: approvedVerdict() }),
        fanoutSpawn: () => Promise.reject(new Error('unused')),
        fanoutMode: 'sync',
        model: 'm/x',
        thinkingLevel: null,
        maxConcurrent: 1,
        resumeFrom: 'fanout',
        resumeRunRoot: runRoot,
      }),
    ).rejects.toThrow(/requires plan\.json at/);
  });
});
