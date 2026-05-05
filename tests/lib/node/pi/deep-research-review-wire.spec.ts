/**
 * Tests for lib/node/pi/deep-research-review-wire.ts.
 *
 * Exercises the extension-shell wiring with a mocked iteration-
 * loop: verifies the three Phase-4 acceptance scenarios at the
 * wrapper level on top of the core review-loop tests.
 *
 * Scenarios:
 *
 *   (A) Unresolved footnote → structural refinement → pass.
 *       Notify surfaces the passed summary.
 *   (B) Structurally-clean + critic-rejected → subjective
 *       refinement → pass.
 *   (C) Structural-override: critic approves but structural
 *       re-check fails → wire notifies a warning with the
 *       "critic approved ... structure wins" phrasing.
 *   (D) maxIter=1 + structural fail → budget-exhausted warning
 *       with a best-so-far pointer.
 *
 * Plus:
 *
 *   - First-time consent bootstrap (notify fires once).
 *   - Iteration-loop check specs land under `.pi/checks/`
 *     via writeDraft + acceptDraft, then archive-on-close.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { consentPath, readConsent } from '../../../../lib/node/pi/deep-research-review-config.ts';
import {
  type CriticRunner,
  type RefinementRunner,
  type StructuralRunner,
} from '../../../../lib/node/pi/deep-research-review-loop.ts';
import {
  buildStructuralSpec,
  buildSubjectiveSpec,
  formatOutcome,
  runDeepResearchReview,
  STRUCTURAL_TASK,
  SUBJECTIVE_TASK,
} from '../../../../lib/node/pi/deep-research-review-wire.ts';
import { type StructuralCheckResult } from '../../../../lib/node/pi/deep-research-structural-check.ts';
import { type Verdict } from '../../../../lib/node/pi/iteration-loop-schema.ts';
import { activePath, archiveDir } from '../../../../lib/node/pi/iteration-loop-storage.ts';
import { assertKind } from './helpers.ts';

let sandbox: string;
let cwd: string;
let runRoot: string;
let memoryRoot: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-dr-review-wire-'));
  cwd = join(sandbox, 'workspace');
  runRoot = join(cwd, 'research', 'demo');
  memoryRoot = join(sandbox, 'memory');
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });
  writeFileSync(join(runRoot, 'report.md'), '# report\n\ninitial body\n');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Verdict fixtures.
// ──────────────────────────────────────────────────────────────────────

function passingStructural(): StructuralCheckResult {
  return {
    ok: true,
    failures: [],
    stats: {
      footnoteMarkers: 2,
      footnoteEntries: 2,
      sections: 2,
      subQuestions: 2,
      placeholders: 0,
      sourcesInStore: 2,
      bareUrlsInBody: 0,
    },
  };
}

function failingStructural(): StructuralCheckResult {
  return {
    ok: false,
    failures: [
      {
        id: 'no-unresolved-placeholders',
        message: 'unresolved placeholder {{SRC:abc}} remains in the report',
        location: '{{SRC:abc}}',
      },
    ],
    stats: {
      footnoteMarkers: 0,
      footnoteEntries: 0,
      sections: 2,
      subQuestions: 2,
      placeholders: 1,
      sourcesInStore: 2,
      bareUrlsInBody: 0,
    },
  };
}

function approvedCritic(): Verdict {
  return { approved: true, score: 0.9, issues: [], summary: 'great' };
}

function rejectedCritic(): Verdict {
  return {
    approved: false,
    score: 0.55,
    issues: [{ severity: 'major', description: 'sq-1 under-cited' }],
    summary: 'spotty citations',
  };
}

// ──────────────────────────────────────────────────────────────────────
// Scripted runners (shared across scenarios).
// ──────────────────────────────────────────────────────────────────────

function scripted<T>(recipes: T[]): (opts: { iteration: number }) => Promise<T> {
  let idx = 0;
  return (_opts) => {
    const r = recipes[idx++];
    if (r === undefined) throw new Error(`scripted: out of recipes (call #${idx})`);
    return Promise.resolve(r);
  };
}

function refiner(): {
  refine: RefinementRunner;
  calls: { stage: 'structural' | 'subjective' }[];
} {
  const calls: { stage: 'structural' | 'subjective' }[] = [];
  const refine: RefinementRunner = (req) => {
    calls.push({ stage: req.stage });
    writeFileSync(join(runRoot, 'report.md'), `# report (refined ${calls.length}, ${req.stage})\n`);
    return Promise.resolve({ ok: true });
  };
  return { refine, calls };
}

// ──────────────────────────────────────────────────────────────────────
// Scenario (A) — unresolved footnote → structural refinement → pass.
// ──────────────────────────────────────────────────────────────────────

describe('runDeepResearchReview — scenario A (structural refinement)', () => {
  test('unresolved footnote: fails structural, refines, passes', async () => {
    const runStructural: StructuralRunner = scripted<StructuralCheckResult>([
      failingStructural(),
      passingStructural(),
      passingStructural(),
    ]);
    const runCritic: CriticRunner = scripted<Verdict>([approvedCritic()]);
    const { refine, calls } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n- cite every claim\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 3,
      consent: { root: memoryRoot },
      notify,
      now: () => new Date('2025-04-05T06:07:08Z'),
    });

    assertKind(result.outcome, 'passed');

    expect(calls).toEqual([{ stage: 'structural' }]);

    // Consent landed in the memory root.
    expect(existsSync(consentPath({ root: memoryRoot }))).toBe(true);
    expect(readConsent({ root: memoryRoot }).consented).toBe(true);
    expect(result.firstTimeConsent).toBe(true);

    // First notify = consent bootstrap, last = summary.
    const messages = notify.mock.calls.map(([m]) => m);

    expect(messages[0]).toContain('first-time review-loop consent');
    expect(messages.at(-1)).toContain('review PASSED');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Scenario (B) — clean but poorly-cited → subjective refinement.
// ──────────────────────────────────────────────────────────────────────

describe('runDeepResearchReview — scenario B (subjective refinement)', () => {
  test('structurally clean, critic rejects, refines, critic approves', async () => {
    const runStructural = scripted<StructuralCheckResult>([
      passingStructural(),
      passingStructural(),
      passingStructural(),
    ]);
    const runCritic = scripted<Verdict>([rejectedCritic(), approvedCritic()]);
    const { refine, calls } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 3,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'passed');

    expect(calls).toEqual([{ stage: 'subjective' }]);
    expect(result.summary).toContain('review PASSED');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Scenario (C) — structural-override (structure wins).
// ──────────────────────────────────────────────────────────────────────

describe('runDeepResearchReview — scenario C (structure wins)', () => {
  test('critic approves but re-check fails → structural-override warning', async () => {
    const runStructural = scripted<StructuralCheckResult>([passingStructural(), failingStructural()]);
    const runCritic = scripted<Verdict>([approvedCritic()]);
    const { refine, calls } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 3,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'structural-override');

    expect(calls).toHaveLength(0);
    expect(result.summary).toContain('review FAILED');
    expect(result.summary).toContain('Structure wins');
    expect(result.level).toBe('warning');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Scenario (D) — budget exhaustion with best-so-far.
// ──────────────────────────────────────────────────────────────────────

describe('runDeepResearchReview — scenario D (budget exhausted)', () => {
  test('maxIter=1 + failing structural → warning summary + best-so-far + near-pass closeness + resume command', async () => {
    const runStructural = scripted<StructuralCheckResult>([failingStructural()]);
    const runCritic = scripted<Verdict>([]);
    const { refine } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 1,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'budget-exhausted');

    expect(result.outcome.stage).toBe('structural');
    expect(result.summary).toContain('budget exhausted');
    expect(result.summary).toContain('best-so-far');
    expect(result.outcome.bestSoFar).not.toBeNull();
    expect(result.level).toBe('warning');

    // The single failing-structural recipe uses one failure id,
    // so classifyReviewCloseness returns 'near-pass' and the
    // summary carries the parent-agent-facing closeness verdict
    // plus a ready-to-invoke resume command.
    expect(result.summary).toContain('Near-pass');
    expect(result.summary).toContain('Resume:');
    expect(result.summary).toContain(`--run-root ${runRoot}`);
    expect(result.summary).toContain('--from=review');
    // maxIter was 1, REVIEW_RESUME_BUMP is 2 → resume target = 3.
    expect(result.summary).toContain('--review-max-iter 3');
  });

  test('multi-failure structural exhaustion → stuck closeness + resume command', async () => {
    const manyFailures: StructuralCheckResult = {
      ok: false,
      failures: [
        { id: 'no-unresolved-placeholders', message: 'placeholder A' },
        { id: 'no-unresolved-placeholders', message: 'placeholder B' },
      ],
      stats: {
        footnoteMarkers: 0,
        footnoteEntries: 0,
        sections: 0,
        subQuestions: 0,
        placeholders: 2,
        sourcesInStore: 0,
        bareUrlsInBody: 0,
      },
    };
    const runStructural = scripted<StructuralCheckResult>([manyFailures]);
    const runCritic = scripted<Verdict>([]);
    const { refine } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 1,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'budget-exhausted');

    expect(result.summary).toContain('Stuck');
    expect(result.summary).toContain('Resume:');
    expect(result.summary).toContain('--review-max-iter 3');
  });

  test('subjective budget exhaustion with critic score ≥ 0.7 → near-pass closeness', async () => {
    const nearPassCritic: Verdict = {
      approved: false,
      score: 0.75,
      issues: [{ severity: 'minor', description: 'one small tweak' }],
      summary: 'nearly there',
    };
    const runStructural = scripted<StructuralCheckResult>([passingStructural()]);
    const runCritic = scripted<Verdict>([nearPassCritic]);
    const { refine } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 1,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'budget-exhausted');

    expect(result.outcome.stage).toBe('subjective');
    expect(result.summary).toContain('Near-pass');
    expect(result.summary).toContain('--review-max-iter 3');
  });
});

// Scenario (E) — stubbed short-circuit: report has
// `[section unavailable: …]` stubs → wire skips the loop and
// returns a terminal `kind: 'stubbed'` outcome with the
// recovery command already in the summary.

describe('runDeepResearchReview — scenario E (stubbed short-circuit)', () => {
  test('stubbed report bypasses the loop and returns kind=stubbed without running any runner', async () => {
    // Seed a report with two stubbed sub-question sections and
    // a plan.json that resolves both headings to concrete ids.
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
        '[section unavailable: fanout task aborted]',
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

    const runStructural = vi.fn<StructuralRunner>();
    const runCritic = vi.fn<CriticRunner>();
    const { refine, calls: refineCalls } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 4,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'stubbed');

    expect(result.outcome.stubbed).toHaveLength(2);
    expect(result.outcome.stubbed.map((s) => s.heading)).toEqual(['What is A?', 'What is B?']);
    expect(result.outcome.reportPath).toBe(join(runRoot, 'report.md'));

    // Neither runner was called — the short-circuit happens
    // before the loop spins up.
    expect(runStructural).not.toHaveBeenCalled();
    expect(runCritic).not.toHaveBeenCalled();
    expect(refineCalls).toHaveLength(0);

    // Summary carries the "review skipped" line + a copy-
    // pasteable re-fetch command with the resolved ids.
    expect(result.level).toBe('warning');
    expect(result.summary).toContain('review skipped');
    expect(result.summary).toContain('2 sub-question section(s)');
    expect(result.summary).toContain('--from=fanout');
    expect(result.summary).toContain('--sq=sq-1,sq-2');
    expect(result.summary).toContain(`--run-root ${runRoot}`);

    // Exactly one notify (the summary itself) — no consent
    // bootstrap on the short-circuit path since the loop never
    // ran, and no separate recovery-hint notify.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe(result.summary);
    expect(notify.mock.calls[0][1]).toBe('warning');

    // Consent was NOT recorded on the short-circuit path
    // (matches `consented: false` in the returned shape so
    // callers can distinguish the skip from a real run).
    expect(result.consented).toBe(false);
    expect(result.firstTimeConsent).toBe(false);
  });

  test('stubbed short-circuit with unresolvable heading falls back to <id1>,<id2> placeholder', async () => {
    writeFileSync(
      join(runRoot, 'report.md'),
      ['# report', '', '## Heading that does not appear in plan.json', '', '[section unavailable: x]', ''].join('\n'),
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
        budget: { maxSubagents: 1, maxFetches: 10, maxCostUsd: 1, wallClockSec: 60 },
        subQuestions: [{ id: 'sq-1', question: 'Totally different question', status: 'pending' }],
      }),
    );

    const runStructural = vi.fn<StructuralRunner>();
    const runCritic = vi.fn<CriticRunner>();
    const { refine } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 4,
      consent: { root: memoryRoot },
      notify,
    });

    assertKind(result.outcome, 'stubbed');

    expect(result.summary).toContain('<id1>,<id2>');
    expect(result.summary).toContain('could not resolve every heading');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Consent bootstrap behavior — the second run skips the consent notify.
// ──────────────────────────────────────────────────────────────────────

describe('runDeepResearchReview — consent flow', () => {
  test('second run does not re-notify consent', async () => {
    const runStructural = scripted<StructuralCheckResult>([passingStructural(), passingStructural()]);
    const runCritic = scripted<Verdict>([approvedCritic()]);
    const { refine } = refiner();
    const notify1 = vi.fn();

    await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 3,
      consent: { root: memoryRoot },
      notify: notify1,
    });

    // Second run on a fresh refiner reuses the recorded consent.
    const runStructural2 = scripted<StructuralCheckResult>([passingStructural(), passingStructural()]);
    const runCritic2 = scripted<Verdict>([approvedCritic()]);
    const notify2 = vi.fn();
    const result2 = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural: runStructural2,
      runCritic: runCritic2,
      refineReport: refine,
      maxIter: 3,
      consent: { root: memoryRoot },
      notify: notify2,
      taskNames: { structural: 'deep-research-structural-2', subjective: 'deep-research-subjective-2' },
    });

    expect(result2.firstTimeConsent).toBe(false);

    // Only the summary notify, not a second consent bootstrap.
    const messages = notify2.mock.calls.map(([m]) => m);

    expect(messages.filter((s) => s.includes('first-time'))).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Iteration-loop spec persistence.
// ──────────────────────────────────────────────────────────────────────

describe('runDeepResearchReview — iteration-loop storage', () => {
  test('declare + accept lands both task specs on disk; archive on close', async () => {
    const runStructural = scripted<StructuralCheckResult>([passingStructural(), passingStructural()]);
    const runCritic = scripted<Verdict>([approvedCritic()]);
    const { refine } = refiner();

    await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node lib/node/pi/deep-research-structural-check.ts ./research/demo',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 3,
      consent: { root: memoryRoot },
    });

    // After the loop terminates, the active task files should have
    // been archived. The active `.json` files are gone; the archive
    // dir carries `<ts>__<task>` entries.
    expect(existsSync(activePath(cwd, STRUCTURAL_TASK))).toBe(false);
    expect(existsSync(activePath(cwd, SUBJECTIVE_TASK))).toBe(false);

    const archives = readdirSync(archiveDir(cwd));

    expect(archives.some((name) => name.endsWith(STRUCTURAL_TASK))).toBe(true);
    expect(archives.some((name) => name.endsWith(SUBJECTIVE_TASK))).toBe(true);
  });

  test('writeDraft refused (active task already present) does not block the review loop', async () => {
    // Pre-populate an active structural task so `writeDraft` in
    // the wire returns { ok: false }. The review loop must still
    // run against the injected runners — the iteration-loop
    // storage is informational, not load-bearing.
    const { writeDraft: writeDraftDirect, acceptDraft: acceptDraftDirect } =
      await import('../../../../lib/node/pi/iteration-loop-storage.ts');
    const preSpec = buildStructuralSpec({
      task: STRUCTURAL_TASK,
      reportPath: join(runRoot, 'report.md'),
      bashCmd: 'echo preexisting',
      maxIter: 3,
      createdAt: '2025-01-01T00:00:00Z',
    });
    const w = writeDraftDirect(cwd, preSpec);

    expect(w.ok).toBe(true);

    const a = acceptDraftDirect(cwd, STRUCTURAL_TASK, '2025-01-01T00:00:00Z');

    expect(a.ok).toBe(true);

    const runStructural = scripted<StructuralCheckResult>([passingStructural(), passingStructural()]);
    const runCritic = scripted<Verdict>([approvedCritic()]);
    const { refine } = refiner();
    const notify = vi.fn();

    const result = await runDeepResearchReview({
      cwd,
      runRoot,
      rubricSubjective: '## Rubric\n',
      structuralBashCmd: 'node foo.ts bar',
      runStructural,
      runCritic,
      refineReport: refine,
      maxIter: 3,
      consent: { root: memoryRoot },
      notify,
    });

    // Loop still terminates successfully against the scripted
    // runners even though writeDraft was refused — the injected
    // runners are the authoritative verdict source.
    assertKind(result.outcome, 'passed');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Spec builders.
// ──────────────────────────────────────────────────────────────────────

describe('buildStructuralSpec / buildSubjectiveSpec', () => {
  test('structural spec is kind=bash with passOn=exit-zero', () => {
    const spec = buildStructuralSpec({
      task: 'demo',
      reportPath: 'research/demo/report.md',
      bashCmd: 'node foo.ts arg',
      maxIter: 3,
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(spec.kind).toBe('bash');
    expect(spec.spec).toMatchObject({ cmd: 'node foo.ts arg', passOn: 'exit-zero' });
    expect(spec.budget?.maxIter).toBe(3);
  });

  test('subjective spec is kind=critic with the rubric inlined', () => {
    const spec = buildSubjectiveSpec({
      task: 'demo',
      reportPath: 'research/demo/report.md',
      rubric: '## Rubric\n- care about citations\n',
      maxIter: 2,
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(spec.kind).toBe('critic');
    expect(spec.spec).toMatchObject({ rubric: expect.stringContaining('care about citations') as unknown });
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatOutcome (direct).
// ──────────────────────────────────────────────────────────────────────

describe('formatOutcome', () => {
  test('passed → info level with iteration count + critic score', () => {
    const out = formatOutcome({
      kind: 'passed',
      iterations: 2,
      reportPath: '/r/report.md',
      critic: approvedCritic(),
      structural: passingStructural(),
    });

    expect(out.level).toBe('info');
    expect(out.summary).toContain('review PASSED');
    expect(out.summary).toContain('0.90');
  });

  test('budget-exhausted structural → warning + best-so-far pointer', () => {
    const out = formatOutcome({
      kind: 'budget-exhausted',
      stage: 'structural',
      iterations: 3,
      bestSoFar: {
        iteration: 2,
        score: 0,
        approved: false,
        snapshotPath: '/snap/iter-002-structural.md',
        stage: 'structural',
      },
      lastStructural: failingStructural(),
      lastCritic: null,
    });

    expect(out.level).toBe('warning');
    expect(out.summary).toContain('budget exhausted');
    expect(out.summary).toContain('iter-002-structural.md');
    // Without FormatOutcomeContext, the closeness block is
    // omitted so existing callers don't grow new text.
    expect(out.summary).not.toContain('Near-pass');
    expect(out.summary).not.toContain('Resume:');
  });

  test('budget-exhausted structural + FormatOutcomeContext → near-pass closeness + resume command', () => {
    const out = formatOutcome(
      {
        kind: 'budget-exhausted',
        stage: 'structural',
        iterations: 4,
        bestSoFar: {
          iteration: 4,
          score: 0,
          approved: false,
          snapshotPath: '/snap/iter-004-structural.md',
          stage: 'structural',
        },
        lastStructural: failingStructural(),
        lastCritic: null,
      },
      { runRoot: '/tmp/research/demo', maxIter: 4 },
    );

    expect(out.level).toBe('warning');
    expect(out.summary).toContain('Near-pass');
    // REVIEW_RESUME_BUMP = 2 → resume target = maxIter + 2 = 6.
    expect(out.summary).toContain(
      'Resume: `/research --resume --run-root /tmp/research/demo --from=review --review-max-iter 6`',
    );
  });

  test('budget-exhausted subjective (score 0.42) + context → stuck closeness + resume command', () => {
    const out = formatOutcome(
      {
        kind: 'budget-exhausted',
        stage: 'subjective',
        iterations: 4,
        bestSoFar: {
          iteration: 4,
          score: 0.42,
          approved: false,
          snapshotPath: '/snap/iter-004-subjective.md',
          stage: 'subjective',
        },
        lastStructural: passingStructural(),
        lastCritic: {
          approved: false,
          score: 0.42,
          issues: [{ severity: 'major', description: 'thin citations' }],
          summary: 'weak',
        },
      },
      { runRoot: '/tmp/research/demo', maxIter: 3 },
    );

    expect(out.summary).toContain('Stuck');
    expect(out.summary).toContain('critic score: 0.42');
    expect(out.summary).toContain('--review-max-iter 5');
  });

  test('structural-override → warning with "structure wins" phrasing', () => {
    const out = formatOutcome({
      kind: 'structural-override',
      iterations: 1,
      structural: failingStructural(),
      critic: approvedCritic(),
    });

    expect(out.level).toBe('warning');
    expect(out.summary).toContain('Structure wins');
  });

  test('error → error level with the error text', () => {
    const out = formatOutcome({
      kind: 'error',
      error: 'boom',
      iterations: 0,
      bestSoFar: null,
    });

    expect(out.level).toBe('error');
    expect(out.summary).toContain('boom');
  });

  test('stubbed → warning level naming the stub count', () => {
    const out = formatOutcome({
      kind: 'stubbed',
      stubbed: [
        { heading: 'What is A?', reason: 'no findings' },
        { heading: 'What is B?', reason: '' },
      ],
      reportPath: '/r/report.md',
    });

    expect(out.level).toBe('warning');
    expect(out.summary).toContain('review skipped');
    expect(out.summary).toContain('2 sub-question section(s)');
  });
});
