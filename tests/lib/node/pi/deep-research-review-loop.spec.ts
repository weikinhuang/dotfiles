/**
 * Tests for lib/node/pi/deep-research-review-loop.ts.
 *
 * The review loop is pure orchestration - this spec drives it with
 * scripted `runStructural` / `runCritic` / `refineReport` mocks and
 * asserts the Phase 4 acceptance-criteria shapes:
 *
 *   (1) Unresolved footnote → structural stage fails on iter 1,
 *       structural nudge is emitted, refinement runs, structural
 *       passes on iter 2, critic approves, terminal `passed`.
 *   (2) Structurally clean but poorly cited → critic stage fails
 *       on iter 1, subjective nudge is emitted, refinement runs,
 *       critic approves on iter 2, terminal `passed`.
 *   (3) Structurally-broken report with an approving critic →
 *       after the critic approves, the re-check structural fails
 *       and the outcome is `structural-override` - structure wins.
 *   (4) `maxIter = 1` + first structural fail → budget-exhausted
 *       with best-so-far pointing at the iter-1 snapshot.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildStructuralNudge,
  buildSubjectiveNudge,
  classifyReviewCloseness,
  NEAR_PASS_STRUCTURAL_MAX_FAILURES,
  NEAR_PASS_SUBJECTIVE_MIN_SCORE,
  REVIEW_RESUME_BUMP,
  runReviewLoop,
  type CriticRunner,
  type RefinementRunner,
  type ReviewLoopOutcome,
  type StructuralRunner,
} from '../../../../lib/node/pi/deep-research-review-loop.ts';
import { type StructuralCheckResult } from '../../../../lib/node/pi/deep-research-structural-check.ts';
import { type Verdict } from '../../../../lib/node/pi/iteration-loop-schema.ts';
import { assertKind } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixture + helper factories.
// ──────────────────────────────────────────────────────────────────────

let sandbox: string;
let runRoot: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-dr-review-loop-'));
  runRoot = join(sandbox, 'research', 'demo');
  mkdirSync(runRoot, { recursive: true });
  // Seed `report.md` with a distinctive first-iteration body so
  // snapshots taken during structural-fail / subjective-fail paths
  // carry a recognizable marker.
  writeFileSync(join(runRoot, 'report.md'), '# report\n\ninitial body\n');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function passingStructural(): StructuralCheckResult {
  return {
    ok: true,
    failures: [],
    stats: {
      footnoteMarkers: 3,
      footnoteEntries: 3,
      sections: 3,
      subQuestions: 3,
      placeholders: 0,
      sourcesInStore: 3,
      bareUrlsInBody: 0,
    },
  };
}

function failingStructural(): StructuralCheckResult {
  return {
    ok: false,
    failures: [
      {
        id: 'footnote-markers-resolve',
        message: 'report body references [^3] but no matching [^3]: entry is present in the footnotes block',
        location: '[^3]',
      },
    ],
    stats: {
      footnoteMarkers: 3,
      footnoteEntries: 2,
      sections: 3,
      subQuestions: 3,
      placeholders: 0,
      sourcesInStore: 3,
      bareUrlsInBody: 0,
    },
  };
}

function approvedCritic(): Verdict {
  return { approved: true, score: 0.92, issues: [], summary: 'every rubric item satisfied' };
}

function rejectedCritic(): Verdict {
  return {
    approved: false,
    score: 0.64,
    issues: [
      {
        severity: 'major',
        description: 'citation discipline: sq-2 section has bare claims without footnote support',
        location: 'sq-2',
      },
    ],
    summary: 'partial coverage; citations spotty in sq-2',
  };
}

/**
 * Build a scripted `StructuralRunner` that returns the next queued
 * result on each call. Throws if called more times than there are
 * recipes.
 */
function scriptedStructural(recipes: StructuralCheckResult[]): { runner: StructuralRunner; calls: () => number } {
  const calls: { iteration: number }[] = [];
  return {
    runner: (opts) => {
      calls.push(opts);
      const idx = calls.length - 1;
      const r = recipes[idx];
      if (!r) throw new Error(`structural runner: out of scripts (call #${calls.length})`);
      return Promise.resolve(r);
    },
    calls: () => calls.length,
  };
}

function scriptedCritic(recipes: Verdict[]): { runner: CriticRunner; calls: () => number } {
  const calls: { iteration: number }[] = [];
  return {
    runner: (opts) => {
      calls.push(opts);
      const idx = calls.length - 1;
      const r = recipes[idx];
      if (!r) throw new Error(`critic runner: out of scripts (call #${calls.length})`);
      return Promise.resolve(r);
    },
    calls: () => calls.length,
  };
}

/**
 * Build a refinement runner that rewrites `report.md` to a distinct
 * body per invocation so snapshot diffs are observable and the
 * review loop's iteration gating is testable end-to-end.
 */
function scriptedRefine(): {
  refine: RefinementRunner;
  calls: { stage: 'structural' | 'subjective'; nudge: string; iteration: number }[];
} {
  const calls: { stage: 'structural' | 'subjective'; nudge: string; iteration: number }[] = [];
  const refine: RefinementRunner = (req) => {
    calls.push({ stage: req.stage, nudge: req.nudge, iteration: req.iteration });
    writeFileSync(join(runRoot, 'report.md'), `# report (after ${req.stage} refinement ${calls.length})\n`);
    return Promise.resolve({ ok: true });
  };
  return { refine, calls };
}

// ──────────────────────────────────────────────────────────────────────
// (1) Unresolved footnote fails structural → refinement fixes it.
// ──────────────────────────────────────────────────────────────────────

describe('runReviewLoop - structural refinement', () => {
  test('(1) unresolved footnote fails structural, refinement fixes it, critic approves', async () => {
    const structural = scriptedStructural([
      failingStructural(), // iter 1 - fails
      passingStructural(), // iter 2 - passes
      passingStructural(), // iter 2 - re-check after critic approve
    ]);
    const critic = scriptedCritic([approvedCritic()]);
    const { refine, calls: refineCalls } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 3,
    });

    assertKind(outcome, 'passed');

    expect(outcome.iterations).toBe(2);
    expect(structural.calls()).toBe(3); // iter 1 fail, iter 2, iter 2 re-check
    expect(critic.calls()).toBe(1);
    expect(refineCalls).toHaveLength(1);
    expect(refineCalls[0].stage).toBe('structural');
    expect(refineCalls[0].nudge).toContain('structural review rejected');
    expect(refineCalls[0].nudge).toContain('[^3]');
  });
});

// ──────────────────────────────────────────────────────────────────────
// (2) Structurally clean but poorly cited → critic refines.
// ──────────────────────────────────────────────────────────────────────

describe('runReviewLoop - subjective refinement', () => {
  test('(2) critic rejects on iter 1, refinement fixes, critic approves on iter 2', async () => {
    const structural = scriptedStructural([
      passingStructural(), // iter 1 structural
      passingStructural(), // iter 2 structural
      passingStructural(), // iter 2 re-check
    ]);
    const critic = scriptedCritic([rejectedCritic(), approvedCritic()]);
    const { refine, calls: refineCalls } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 3,
    });

    assertKind(outcome, 'passed');

    expect(outcome.iterations).toBe(2);
    expect(critic.calls()).toBe(2);
    expect(structural.calls()).toBe(3);
    expect(refineCalls).toHaveLength(1);
    expect(refineCalls[0].stage).toBe('subjective');
    expect(refineCalls[0].nudge).toContain('subjective critic rejected');
    expect(refineCalls[0].nudge).toContain('citation discipline');
  });
});

// ──────────────────────────────────────────────────────────────────────
// (3) "Structure wins" override - critic approves but structural fails.
// ──────────────────────────────────────────────────────────────────────

describe('runReviewLoop - structure wins override', () => {
  test('(3) critic approves but re-check structural fails → structural-override', async () => {
    const structural = scriptedStructural([
      passingStructural(), // iter 1 primary structural - passes so critic gets a shot
      failingStructural(), // iter 1 re-check - regresses after critic approves
    ]);
    const critic = scriptedCritic([approvedCritic()]);
    const { refine, calls: refineCalls } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 3,
    });

    assertKind(outcome, 'structural-override');

    expect(outcome.iterations).toBe(1);
    expect(outcome.structural.ok).toBe(false);
    expect(outcome.critic.approved).toBe(true);
    // No refinement attempted - the override short-circuits.
    expect(refineCalls).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// (4) maxIter=1 + first structural fail → budget exhausted + best-so-far.
// ──────────────────────────────────────────────────────────────────────

describe('runReviewLoop - budget exhaustion', () => {
  test('(4) maxIter=1 and structural fails once → budget-exhausted; bestSoFar set', async () => {
    const structural = scriptedStructural([failingStructural()]);
    const critic = scriptedCritic([]);
    const { refine, calls: refineCalls } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 1,
    });

    assertKind(outcome, 'budget-exhausted');

    expect(outcome.stage).toBe('structural');
    expect(outcome.iterations).toBe(1);
    expect(outcome.lastCritic).toBeNull();
    expect(outcome.lastStructural.ok).toBe(false);
    expect(refineCalls).toHaveLength(0);
    // bestSoFar snapshots the initial report body (written in beforeEach).
    expect(outcome.bestSoFar).not.toBeNull();

    const body = readFileSync(outcome.bestSoFar!.snapshotPath, 'utf8');

    expect(body).toContain('initial body');
    expect(outcome.bestSoFar!.stage).toBe('structural');
    expect(outcome.bestSoFar!.approved).toBe(false);
    expect(outcome.bestSoFar!.iteration).toBe(1);
  });

  test('(4b) maxIter=3 exhausted with structural failing every time → budget-exhausted', async () => {
    const structural = scriptedStructural([failingStructural(), failingStructural(), failingStructural()]);
    const critic = scriptedCritic([]);
    const { refine, calls: refineCalls } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 3,
    });

    assertKind(outcome, 'budget-exhausted');

    expect(outcome.stage).toBe('structural');
    expect(outcome.iterations).toBe(3);
    expect(refineCalls).toHaveLength(2); // two refinements between three iterations
    expect(critic.calls()).toBe(0);
  });

  test('(4c) maxIter=3 exhausted with critic rejecting every time → subjective budget-exhausted', async () => {
    const structural = scriptedStructural([passingStructural(), passingStructural(), passingStructural()]);
    const critic = scriptedCritic([rejectedCritic(), rejectedCritic(), rejectedCritic()]);
    const { refine, calls: refineCalls } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 3,
    });

    assertKind(outcome, 'budget-exhausted');

    expect(outcome.stage).toBe('subjective');
    expect(outcome.iterations).toBe(3);
    expect(refineCalls).toHaveLength(2);
    expect(refineCalls.every((c) => c.stage === 'subjective')).toBe(true);
    expect(outcome.bestSoFar).not.toBeNull();
    // Subjective best-so-far carries the critic's score (0.64).
    expect(outcome.bestSoFar!.score).toBeCloseTo(0.64, 2);
    expect(outcome.bestSoFar!.stage).toBe('subjective');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Refinement-error path.
// ──────────────────────────────────────────────────────────────────────

describe('runReviewLoop - refinement errors', () => {
  test('refine returns { ok: false } → error outcome with bestSoFar populated', async () => {
    const structural = scriptedStructural([failingStructural()]);
    const critic = scriptedCritic([]);
    const refine: RefinementRunner = vi.fn(() => Promise.resolve({ ok: false as const, error: 'synth offline' }));

    const outcome = await runReviewLoop({
      runRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 3,
    });

    assertKind(outcome, 'error');

    expect(outcome.error).toContain('synth offline');
    expect(outcome.bestSoFar).not.toBeNull();
  });

  test('runStructural throws → error outcome, no iterations counted', async () => {
    const runner: StructuralRunner = () => Promise.reject(new Error('cannot spawn bash'));
    const outcome = await runReviewLoop({
      runRoot,
      runStructural: runner,
      runCritic: scriptedCritic([]).runner,
      refineReport: scriptedRefine().refine,
      maxIter: 3,
    });

    assertKind(outcome, 'error');

    expect(outcome.error).toContain('cannot spawn bash');
    expect(outcome.iterations).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Nudge formatters - pure.
// ──────────────────────────────────────────────────────────────────────

describe('buildStructuralNudge / buildSubjectiveNudge', () => {
  test('structural nudge lists every failure with its id', () => {
    const nudge = buildStructuralNudge(failingStructural());

    expect(nudge).toContain('[footnote-markers-resolve]');
    expect(nudge).toContain('[^3]');
    expect(nudge).toContain('invent new sources');
  });

  test('structural nudge is empty when the result is ok', () => {
    expect(buildStructuralNudge(passingStructural())).toBe('');
  });

  test('subjective nudge includes score and each issue', () => {
    const nudge = buildSubjectiveNudge(rejectedCritic());

    expect(nudge).toContain('0.64');
    expect(nudge).toContain('[major]');
    expect(nudge).toContain('citation discipline');
    expect(nudge).toContain('structural check will re-verify');
  });

  test('subjective nudge is empty for an approved verdict with no issues', () => {
    expect(buildSubjectiveNudge(approvedCritic())).toBe('');
  });
});

describe('runReviewLoop - startIteration (resume flows)', () => {
  // Use the outer describe block's runRoot via require-style reuse would be ugly;
  // instead build a tiny local fixture identical to the other blocks.
  let localRoot: string;

  beforeEach(() => {
    localRoot = mkdtempSync(join(tmpdir(), 'review-loop-start-iter-'));
    mkdirSync(join(localRoot, 'snapshots', 'review'), { recursive: true });
    writeFileSync(join(localRoot, 'report.md'), '# report\ninitial body\n', 'utf8');
  });

  afterEach(() => {
    rmSync(localRoot, { recursive: true, force: true });
  });

  test('passing iteration labels respect startIteration', async () => {
    // Two structural recipes: one for the per-iteration check, one for
    // the post-critic-approve re-check (structure-wins defense).
    const structural = scriptedStructural([passingStructural(), passingStructural()]);
    const critic = scriptedCritic([approvedCritic()]);
    const { refine } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot: localRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 1,
      startIteration: 5,
    });
    assertKind(outcome, 'passed');

    expect(outcome.iterations).toBe(5);
  });

  test('budget exhaustion labels iterations from startIteration through startIteration + maxIter - 1', async () => {
    const structural = scriptedStructural([failingStructural(), failingStructural()]);
    const critic = scriptedCritic([]);
    const { refine } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot: localRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 2,
      startIteration: 5,
    });
    assertKind(outcome, 'budget-exhausted');

    // Two iterations ran: iter 5 and iter 6. `.iterations` reports the final iter.
    expect(outcome.iterations).toBe(6);
    // Both iters had score 0 (structural fail); selectBest breaks ties by
    // recency so bestSoFar is the later iteration.
    expect(outcome.bestSoFar?.iteration).toBe(6);
  });

  test('snapshot filenames reflect startIteration', async () => {
    const structural = scriptedStructural([failingStructural()]);
    const critic = scriptedCritic([]);
    const { refine } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot: localRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 1,
      startIteration: 12,
    });
    assertKind(outcome, 'budget-exhausted');

    expect(outcome.bestSoFar?.snapshotPath).toMatch(/iter-012-structural\.md$/);
  });

  test('startIteration defaults to 1 when omitted (unchanged legacy behavior)', async () => {
    const structural = scriptedStructural([passingStructural(), passingStructural()]);
    const critic = scriptedCritic([approvedCritic()]);
    const { refine } = scriptedRefine();

    const outcome = await runReviewLoop({
      runRoot: localRoot,
      runStructural: structural.runner,
      runCritic: critic.runner,
      refineReport: refine,
      maxIter: 1,
    });
    assertKind(outcome, 'passed');

    expect(outcome.iterations).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Stubbed outcome - produced by the review-wire short-circuit,
// not by the loop itself. Documented here so the discriminated
// union's {@link ReviewLoopOutcome} shape stays exhaustively
// covered across the lib boundary (wire tests drive the actual
// short-circuit).
// ──────────────────────────────────────────────────────────────────────

describe('ReviewLoopOutcome shape - stubbed variant', () => {
  test('{ kind: "stubbed" } is assignable to ReviewLoopOutcome and carries stubbed sections + reportPath', () => {
    const outcome: ReviewLoopOutcome = {
      kind: 'stubbed',
      stubbed: [{ heading: 'sq-1', reason: 'no findings' }],
      reportPath: '/tmp/demo/report.md',
    };
    assertKind(outcome, 'stubbed');

    expect(outcome.stubbed).toHaveLength(1);
    expect(outcome.reportPath).toBe('/tmp/demo/report.md');
    // `iterations` is deliberately absent - the short-circuit
    // never ran a review iteration. Document the omission so a
    // future edit that adds the field has to revisit the
    // contract explicitly.
    expect('iterations' in outcome).toBe(false);
  });
});

// Closeness classifier - pure predicate truth table.
// Non-budget-exhausted outcomes never get classified as near-pass
// or stuck; the wire only invokes the classifier inside its
// budget-exhausted branch. The `unknown` verdict here guards the
// contract: if a future edit starts calling the classifier on a
// `passed` outcome it will not accidentally classify as near-pass.

describe('classifyReviewCloseness', () => {
  function structuralExhausted(failures: number, hasSnapshot: boolean): ReviewLoopOutcome {
    return {
      kind: 'budget-exhausted',
      stage: 'structural',
      iterations: 4,
      bestSoFar: hasSnapshot
        ? {
            iteration: 3,
            score: 0,
            approved: false,
            snapshotPath: '/r/snap/iter-003-structural.md',
            stage: 'structural',
          }
        : null,
      lastStructural: {
        ok: false,
        failures: Array.from({ length: failures }, (_, i) => ({
          id: 'footnote-markers-resolve',
          message: `unresolved marker #${i + 1}`,
        })),
        stats: {
          footnoteMarkers: 0,
          footnoteEntries: 0,
          sections: 0,
          subQuestions: 0,
          placeholders: 0,
          sourcesInStore: 0,
          bareUrlsInBody: 0,
        },
      },
      lastCritic: null,
    };
  }

  function subjectiveExhausted(score: number | null, hasSnapshot: boolean): ReviewLoopOutcome {
    return {
      kind: 'budget-exhausted',
      stage: 'subjective',
      iterations: 4,
      bestSoFar: hasSnapshot
        ? {
            iteration: 3,
            score: score ?? 0,
            approved: false,
            snapshotPath: '/r/snap/iter-003-subjective.md',
            stage: 'subjective',
          }
        : null,
      lastStructural: passingStructural(),
      lastCritic:
        score === null
          ? null
          : { approved: false, score, issues: [{ severity: 'major', description: 'x' }], summary: 'x' },
    };
  }

  test('constants are the documented defaults', () => {
    expect(NEAR_PASS_STRUCTURAL_MAX_FAILURES).toBe(1);
    expect(NEAR_PASS_SUBJECTIVE_MIN_SCORE).toBe(0.7);
    expect(REVIEW_RESUME_BUMP).toBe(2);
  });

  test('structural: 1 failure + bestSoFar → near-pass (at threshold boundary)', () => {
    expect(classifyReviewCloseness(structuralExhausted(NEAR_PASS_STRUCTURAL_MAX_FAILURES, true))).toBe('near-pass');
  });

  test('structural: 2 failures + bestSoFar → stuck (above threshold)', () => {
    expect(classifyReviewCloseness(structuralExhausted(2, true))).toBe('stuck');
  });

  test('structural: 1 failure but no bestSoFar → stuck (no snapshot to refine from)', () => {
    expect(classifyReviewCloseness(structuralExhausted(1, false))).toBe('stuck');
  });

  test('subjective: critic score 0.75 + bestSoFar → near-pass', () => {
    expect(classifyReviewCloseness(subjectiveExhausted(0.75, true))).toBe('near-pass');
  });

  test('subjective: critic score at threshold (0.7) → near-pass (inclusive lower bound)', () => {
    expect(classifyReviewCloseness(subjectiveExhausted(NEAR_PASS_SUBJECTIVE_MIN_SCORE, true))).toBe('near-pass');
  });

  test('subjective: critic score 0.55 + bestSoFar → stuck', () => {
    expect(classifyReviewCloseness(subjectiveExhausted(0.55, true))).toBe('stuck');
  });

  test('subjective: lastCritic null (parse failure) → stuck', () => {
    expect(classifyReviewCloseness(subjectiveExhausted(null, true))).toBe('stuck');
  });

  test('subjective: score 0.75 but no bestSoFar → stuck', () => {
    expect(classifyReviewCloseness(subjectiveExhausted(0.75, false))).toBe('stuck');
  });

  test('passed outcome → unknown (the classifier is only meaningful on budget-exhausted)', () => {
    const outcome: ReviewLoopOutcome = {
      kind: 'passed',
      iterations: 2,
      reportPath: '/r/report.md',
      critic: approvedCritic(),
      structural: passingStructural(),
    };

    expect(classifyReviewCloseness(outcome)).toBe('unknown');
  });

  test('structural-override → unknown', () => {
    const outcome: ReviewLoopOutcome = {
      kind: 'structural-override',
      iterations: 1,
      structural: failingStructural(),
      critic: approvedCritic(),
    };

    expect(classifyReviewCloseness(outcome)).toBe('unknown');
  });

  test('error → unknown', () => {
    const outcome: ReviewLoopOutcome = {
      kind: 'error',
      error: 'boom',
      iterations: 0,
      bestSoFar: null,
    };

    expect(classifyReviewCloseness(outcome)).toBe('unknown');
  });

  test('stubbed → unknown (short-circuit, loop never ran)', () => {
    const outcome: ReviewLoopOutcome = {
      kind: 'stubbed',
      stubbed: [],
      reportPath: '/r/report.md',
    };

    expect(classifyReviewCloseness(outcome)).toBe('unknown');
  });
});
