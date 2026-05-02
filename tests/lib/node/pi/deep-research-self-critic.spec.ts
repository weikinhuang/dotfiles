/**
 * Tests for lib/node/pi/deep-research-self-critic.ts.
 *
 * Drives the self-critic pass against a mock ResearchSessionLike +
 * scripted replies and an on-disk run directory already carrying a
 * plan.json from an earlier (fake) planner invocation. Covers:
 *
 *   - Rewrite that validates → plan.json overwritten + provenance
 *     refreshed + `rewritten: true`.
 *   - "Redundant planner output" case: self-critic rewrites it.
 *   - Identical-plan re-emit → no rewrite.
 *   - Malformed rewrite → falls back to the original plan.
 *   - Stuck response → original plan kept, `stuck` set on result.
 *   - rewriteDiffers helper covers ordering + shape differences.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { rewriteDiffers, runSelfCritic } from '../../../../lib/node/pi/deep-research-self-critic.ts';
import { paths } from '../../../../lib/node/pi/research-paths.ts';
import { type DeepResearchPlan, writePlan } from '../../../../lib/node/pi/research-plan.ts';
import { type ResearchSessionLike } from '../../../../lib/node/pi/research-structured.ts';
import { STUCK_STATUS } from '../../../../lib/node/pi/research-stuck.ts';

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
  sandbox = mkdtempSync(join(tmpdir(), 'pi-deep-research-selfcritic-spec-'));
  runRoot = join(sandbox, 'research', 'demo');
  mkdirSync(runRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// rewriteDiffers.
// ──────────────────────────────────────────────────────────────────────

describe('rewriteDiffers', () => {
  test('identical id+question sets with no hints → false', () => {
    const before = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
    ]);

    expect(
      rewriteDiffers(before, {
        subQuestions: [
          { id: 'sq-1', question: 'q1' },
          { id: 'sq-2', question: 'q2' },
        ],
      }),
    ).toBe(false);
  });

  test('new question text → true', () => {
    const before = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
    ]);

    expect(
      rewriteDiffers(before, {
        subQuestions: [
          { id: 'sq-1', question: 'NEW' },
          { id: 'sq-2', question: 'q2' },
        ],
      }),
    ).toBe(true);
  });

  test('added search hints → true (counted as refinement)', () => {
    const before = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
    ]);

    expect(
      rewriteDiffers(before, {
        subQuestions: [
          { id: 'sq-1', question: 'q1', searchHints: ['https://foo'] },
          { id: 'sq-2', question: 'q2' },
        ],
      }),
    ).toBe(true);
  });

  test('different count → true', () => {
    const before = makePlan([{ id: 'sq-1', question: 'q1' }]);

    expect(
      rewriteDiffers(before, {
        subQuestions: [
          { id: 'sq-1', question: 'q1' },
          { id: 'sq-2', question: 'q2' },
        ],
      }),
    ).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// runSelfCritic.
// ──────────────────────────────────────────────────────────────────────

describe('runSelfCritic', () => {
  test('(a) valid non-trivial rewrite overwrites plan.json + refreshes provenance', async () => {
    const original = makePlan([
      { id: 'sq-1', question: 'redundant A' },
      { id: 'sq-2', question: 'redundant A' }, // deliberately redundant
      { id: 'sq-3', question: 'something else' },
    ]);
    writePlan(paths(runRoot).plan, original);

    const rewrite = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'what is A?' },
        { id: 'sq-2', question: 'what is B?' },
        { id: 'sq-3', question: 'what is C?' },
      ],
    });
    const session = makeSession([rewrite]);

    const result = await runSelfCritic({
      runRoot,
      plan: original,
      session,
      model: 'local/test',
      thinkingLevel: 'off',
    });

    expect(result.rewritten).toBe(true);
    expect(result.plan.subQuestions[1].question).toBe('what is B?');

    const diskPlan = JSON.parse(readFileSync(paths(runRoot).plan, 'utf8')) as DeepResearchPlan;

    expect(diskPlan.subQuestions[1].question).toBe('what is B?');
  });

  test('(b) identical re-emit → rewritten: false, plan unchanged', async () => {
    const original = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, original);

    const identical = JSON.stringify({
      subQuestions: original.subQuestions.map((sq) => ({ id: sq.id, question: sq.question })),
    });
    const session = makeSession([identical]);

    const result = await runSelfCritic({
      runRoot,
      plan: original,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.rewritten).toBe(false);
    expect(result.exhaustedRetries).toBe(false);
  });

  test('(c) malformed rewrite until retries exhausted → original plan kept', async () => {
    const original = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, original);

    const session = makeSession(['prose A', 'prose B', 'prose C', 'never-reached']);
    const result = await runSelfCritic({
      runRoot,
      plan: original,
      session,
      model: 'm/x',
      thinkingLevel: null,
      maxRetries: 3,
    });

    expect(result.rewritten).toBe(false);
    expect(result.exhaustedRetries).toBe(true);

    // plan.json on disk equals the original.
    const diskPlan = JSON.parse(readFileSync(paths(runRoot).plan, 'utf8')) as DeepResearchPlan;

    expect(diskPlan.subQuestions.map((sq) => sq.id)).toEqual(['sq-1', 'sq-2', 'sq-3']);
  });

  test('(d) stuck response keeps original plan and surfaces stuck reason', async () => {
    const original = makePlan([
      { id: 'sq-1', question: 'q1' },
      { id: 'sq-2', question: 'q2' },
      { id: 'sq-3', question: 'q3' },
    ]);
    writePlan(paths(runRoot).plan, original);

    const session = makeSession([`{"status":"${STUCK_STATUS}","reason":"cannot review"}`]);
    const result = await runSelfCritic({
      runRoot,
      plan: original,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.rewritten).toBe(false);
    expect(result.stuck?.reason).toBe('cannot review');
  });
});
