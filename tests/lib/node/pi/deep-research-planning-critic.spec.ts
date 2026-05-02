/**
 * Tests for lib/node/pi/deep-research-planning-critic.ts.
 *
 * Drives the planning-critic dispatch loop with a scripted critic
 * runner + rewrite session. Covers:
 *
 *   - First-pass approval → proceed, no rewrite.
 *   - Off-scope plan rejected → auto-rewrite accepted → approved.
 *   - Double-rejection → checkpoint outcome (user escalation).
 *   - Runner error → `error` outcome.
 *   - Rewrite stuck → `rewrite-stuck` outcome.
 *   - buildPlanningCriticTask / renderRewritePrompt echo the
 *     critic's issues.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildPlanningCriticTask,
  DEFAULT_PLANNING_RUBRIC,
  type PlanningCriticRunner,
  renderRewritePrompt,
  runPlanningCritic,
} from '../../../../lib/node/pi/deep-research-planning-critic.ts';
import { paths } from '../../../../lib/node/pi/research-paths.ts';
import { type DeepResearchPlan, writePlan } from '../../../../lib/node/pi/research-plan.ts';
import { type ResearchSessionLike } from '../../../../lib/node/pi/research-structured.ts';
import { STUCK_STATUS } from '../../../../lib/node/pi/research-stuck.ts';
import { assertKind } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Mock session.
// ──────────────────────────────────────────────────────────────────────

function makeSession(scripted: string[]): ResearchSessionLike & { prompts: string[] } {
  const messages: { role: string; content: { type: string; text: string }[] }[] = [];
  const prompts: string[] = [];
  let next = 0;
  return {
    prompts,
    state: { messages },
    prompt: (task: string) => {
      prompts.push(task);
      const reply = scripted[next++] ?? '';
      messages.push({ role: 'user', content: [{ type: 'text', text: task }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      return Promise.resolve();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Typed runner helpers.
// ──────────────────────────────────────────────────────────────────────

/** Build a runner that returns each scripted response in order. */
function scriptedRunner(responses: ({ rawText: string; error?: string } | Error)[]): PlanningCriticRunner {
  let idx = 0;

  return () => {
    const r = responses[idx++];

    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };
}

/** Wrap a runner with a vitest spy so we can assert call count. */
function spyRunner(responses: ({ rawText: string; error?: string } | Error)[]): {
  runner: PlanningCriticRunner;
  spy: ReturnType<typeof vi.fn>;
} {
  const underlying = scriptedRunner(responses);
  const spy = vi.fn(underlying as unknown as (...args: unknown[]) => Promise<{ rawText: string; error?: string }>);
  return { runner: spy, spy };
}

// ──────────────────────────────────────────────────────────────────────
// Fixture scaffolding.
// ──────────────────────────────────────────────────────────────────────

let sandbox: string;
let runRoot: string;

function makePlan(subQs: { id: string; question: string }[]): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: 'demo',
    question: 'demo question',
    status: 'planning',
    budget: { maxSubagents: 6, maxFetches: 40, maxCostUsd: 3, wallClockSec: 1800 },
    subQuestions: subQs.map((sq) => ({ id: sq.id, question: sq.question, status: 'pending' })),
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-deep-research-planningcritic-spec-'));
  runRoot = join(sandbox, 'research', 'demo');
  mkdirSync(runRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const APPROVED_VERDICT = JSON.stringify({
  approved: true,
  score: 0.95,
  issues: [],
  summary: 'plan looks good',
});

const REJECT_OFF_SCOPE_VERDICT = JSON.stringify({
  approved: false,
  score: 0.3,
  issues: [
    {
      severity: 'blocker',
      description: 'sub-question "sq-2" is off-scope from the user question',
      location: 'sq-2',
    },
  ],
  summary: 'plan is off-scope',
});

const REJECT_AGAIN_VERDICT = JSON.stringify({
  approved: false,
  score: 0.3,
  issues: [
    {
      severity: 'major',
      description: 'rewrite still off-scope',
      location: 'sq-2',
    },
  ],
  summary: 'rewrite still bad',
});

// ──────────────────────────────────────────────────────────────────────
// runPlanningCritic.
// ──────────────────────────────────────────────────────────────────────

describe('runPlanningCritic', () => {
  test('(a) first-pass approval → approved outcome with rewrites=0', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, plan);
    const { runner, spy } = spyRunner([{ rawText: APPROVED_VERDICT }]);
    const session = makeSession([]); // no rewrite turn expected
    const result = await runPlanningCritic({
      runRoot,
      plan,
      runCritic: runner,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.kind).toBe('approved');

    assertKind(result, 'approved');

    expect(result.rewrites).toBe(0);
    expect(result.verdict.approved).toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(session.prompts).toHaveLength(0);
  });

  test('(b) off-scope rejected → auto-rewrite accepted → approved with rewrites=1', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'off-scope topic' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, plan);
    const rewrite = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'q1' },
        { id: 'sq-2', question: 'refined sq-2' },
        { id: 'sq-3', question: 'q3' },
      ],
    });
    const runner = scriptedRunner([{ rawText: REJECT_OFF_SCOPE_VERDICT }, { rawText: APPROVED_VERDICT }]);
    const session = makeSession([rewrite]);
    const result = await runPlanningCritic({
      runRoot,
      plan,
      runCritic: runner,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.kind).toBe('approved');

    assertKind(result, 'approved');

    expect(result.rewrites).toBe(1);
    expect(result.plan.subQuestions[1].question).toBe('refined sq-2');

    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain('REJECTED');
    expect(session.prompts[0]).toContain('off-scope');
  });

  test('(c) double rejection → checkpoint outcome', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, plan);
    const rewrite = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'q1' },
        { id: 'sq-2', question: 'q2-rewrite' },
        { id: 'sq-3', question: 'q3' },
      ],
    });
    const runner = scriptedRunner([{ rawText: REJECT_OFF_SCOPE_VERDICT }, { rawText: REJECT_AGAIN_VERDICT }]);
    const session = makeSession([rewrite]);
    const result = await runPlanningCritic({
      runRoot,
      plan,
      runCritic: runner,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.kind).toBe('checkpoint');

    assertKind(result, 'checkpoint');

    expect(result.rewrites).toBe(1);
    expect(result.verdict.summary).toContain('rewrite still bad');
  });

  test('(d) runner throws → error outcome (escalate infra failure, not fanout)', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, plan);
    const runner = scriptedRunner([new Error('spawn failed')]);
    const session = makeSession([]);
    const result = await runPlanningCritic({
      runRoot,
      plan,
      runCritic: runner,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.kind).toBe('error');
  });

  test('(e) rewrite emits stuck → rewrite-stuck outcome', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, plan);
    const runner = scriptedRunner([{ rawText: REJECT_OFF_SCOPE_VERDICT }]);
    const session = makeSession([`{"status":"${STUCK_STATUS}","reason":"cannot rewrite"}`]);
    const result = await runPlanningCritic({
      runRoot,
      plan,
      runCritic: runner,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.kind).toBe('rewrite-stuck');

    assertKind(result, 'rewrite-stuck');

    expect(result.stuck.reason).toBe('cannot rewrite');
  });

  test('(f) unparseable verdict → error (not silent pass)', async () => {
    const plan = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, plan);
    const runner = scriptedRunner([{ rawText: 'This is free-form prose, not JSON.' }]);
    const session = makeSession([]);
    const result = await runPlanningCritic({
      runRoot,
      plan,
      runCritic: runner,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.kind).toBe('error');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Helper renderers.
// ──────────────────────────────────────────────────────────────────────

describe('buildPlanningCriticTask', () => {
  test('points at the plan path and embeds the rubric', () => {
    const task = buildPlanningCriticTask('/tmp/plan.json', DEFAULT_PLANNING_RUBRIC);

    expect(task).toContain('/tmp/plan.json');
    expect(task).toContain('distinct angle');
  });
});

describe('renderRewritePrompt', () => {
  test('echoes the verdict issues verbatim so the rewrite is targeted', () => {
    const prompt = renderRewritePrompt(
      makePlan([
        { id: 'sq-1', question: 'q1' },
        { id: 'sq-2', question: 'q2' },
        { id: 'sq-3', question: 'q3' },
      ]),
      {
        approved: false,
        score: 0.2,
        issues: [
          { severity: 'blocker', description: 'sq-2 is redundant with sq-1', location: 'sq-2' },
          { severity: 'major', description: 'sq-3 is off-scope' },
        ],
        summary: 'plan needs work',
      },
    );

    expect(prompt).toContain('sq-2 is redundant with sq-1');
    expect(prompt).toContain('sq-3 is off-scope');
    expect(prompt).toContain('[blocker]');
  });
});
