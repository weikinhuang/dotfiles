/**
 * Tests for lib/node/pi/deep-research-planner.ts.
 *
 * Drives the planner end-to-end with a mock ResearchSessionLike +
 * scripted assistant replies, mirroring `research-structured.spec.ts`.
 * Asserts:
 *
 *   - Valid planner output lands as plan.json + provenance sidecar.
 *   - Schema violations (too few sub-questions, duplicate ids,
 *     missing fields) force retries; exhausting retries falls back
 *     to the one-sub-question plan.
 *   - Stuck response propagates without writing plan.json.
 *   - Tiny adapter integrations (slug, URL-type classification,
 *     error humanization) fire when enabled and no-op when disabled.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_PLANNER_BUDGET,
  fallbackPlan,
  plannerOutputSchema,
  PLANNER_MAX_SUB_QUESTIONS,
  PLANNER_MIN_SUB_QUESTIONS,
  renderPlannerPrompt,
  runPlanner,
} from '../../../../lib/node/pi/deep-research-planner.ts';
import { readPlan } from '../../../../lib/node/pi/research-plan.ts';
import { readProvenance } from '../../../../lib/node/pi/research-provenance.ts';
import { type ResearchSessionLike } from '../../../../lib/node/pi/research-structured.ts';
import { STUCK_STATUS } from '../../../../lib/node/pi/research-stuck.ts';
import { type TinyAdapter, type TinyCallContext } from '../../../../lib/node/pi/research-tiny.ts';
import { assertErr, assertKind } from './helpers.ts';

// ──────────────────────────────────────────────────────────────────────
// Mock session scripted by an array of assistant replies.
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

function validPlan(sub = 3): string {
  const subs = Array.from({ length: sub }, (_, i) => ({
    id: `sq-${i + 1}`,
    question: `What about angle ${i + 1}?`,
    searchHints: [`https://example.com/angle-${i + 1}`, `angle ${i + 1} overview`],
    successCriteria: [`angle ${i + 1} is fully described`],
  }));
  return JSON.stringify({
    slug: 'sample-question',
    subQuestions: subs,
    successCriteria: ['covers all angles'],
    rubricDraft: '- each angle has a section\n- every claim cited',
  });
}

// ──────────────────────────────────────────────────────────────────────
// Typed mock tiny adapter helpers.
// ──────────────────────────────────────────────────────────────────────

type TinyRewriteFn = (ctx: TinyCallContext<unknown>, task: string, input: string) => Promise<string | null>;
type TinyClassifyFn = (
  ctx: TinyCallContext<unknown>,
  task: string,
  input: string,
  labels: readonly string[],
) => Promise<string | null>;

function mockTinyAdapter(overrides: { rewrite?: TinyRewriteFn; classify?: TinyClassifyFn } = {}): TinyAdapter<unknown> {
  return {
    isEnabled: () => true,
    callTinyRewrite: overrides.rewrite ?? (() => Promise.resolve(null)),
    callTinyClassify: overrides.classify ?? (() => Promise.resolve(null)),
    callTinyMatch: () => Promise.resolve(null),
    getTotalCost: () => 0,
  };
}

function disabledTinyAdapter(): TinyAdapter<unknown> {
  return {
    isEnabled: () => false,
    callTinyRewrite: () => Promise.resolve(null),
    callTinyClassify: () => Promise.resolve(null),
    callTinyMatch: () => Promise.resolve(null),
    getTotalCost: () => 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Fixture scaffolding.
// ──────────────────────────────────────────────────────────────────────

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-deep-research-planner-spec-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Schema.
// ──────────────────────────────────────────────────────────────────────

describe('plannerOutputSchema', () => {
  test('rejects fewer than min sub-questions', () => {
    const result = plannerOutputSchema.validate({ subQuestions: [{ id: 'sq-1', question: 'q' }] });

    assertErr(result);

    expect(result.error).toContain('at least');
  });

  test('rejects more than max sub-questions', () => {
    const subs = Array.from({ length: PLANNER_MAX_SUB_QUESTIONS + 1 }, (_, i) => ({
      id: `sq-${i + 1}`,
      question: 'q',
    }));
    const result = plannerOutputSchema.validate({ subQuestions: subs });

    expect(result.ok).toBe(false);
  });

  test('rejects duplicate sub-question ids', () => {
    const result = plannerOutputSchema.validate({
      subQuestions: [
        { id: 'sq-1', question: 'q' },
        { id: 'sq-1', question: 'other' },
        { id: 'sq-2', question: 'third' },
      ],
    });

    assertErr(result);

    expect(result.error).toContain('unique');
  });

  test('accepts a minimal valid plan', () => {
    const result = plannerOutputSchema.validate(JSON.parse(validPlan(PLANNER_MIN_SUB_QUESTIONS)));

    expect(result.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// fallbackPlan.
// ──────────────────────────────────────────────────────────────────────

describe('fallbackPlan', () => {
  test('produces a one-sub-question plan equal to the whole question', () => {
    const plan = fallbackPlan('why is the sky blue', 'why-sky-blue', DEFAULT_PLANNER_BUDGET);

    expect(plan.kind).toBe('deep-research');
    expect(plan.subQuestions).toHaveLength(1);
    expect(plan.subQuestions[0].question).toBe('why is the sky blue');
    expect(plan.subQuestions[0].status).toBe('pending');
  });
});

// ──────────────────────────────────────────────────────────────────────
// runPlanner.
// ──────────────────────────────────────────────────────────────────────

describe('runPlanner', () => {
  test('(a) valid first-try response lands plan.json + provenance sidecar', async () => {
    const session = makeSession([validPlan(4)]);
    const result = await runPlanner({
      question: 'Compare WebGPU and WebGL adoption',
      cwd: sandbox,
      session,
      model: 'local/test-model',
      thinkingLevel: 'off',
      now: () => new Date('2025-03-04T05:06:07Z'),
    });

    expect(result.stuck).toBeUndefined();
    expect(result.usedFallback).toBe(false);
    expect(session.prompts).toHaveLength(1);

    const planPath = join(result.runRoot, 'plan.json');

    expect(existsSync(planPath)).toBe(true);

    const plan = readPlan(planPath);

    assertKind(plan, 'deep-research');

    expect(plan.subQuestions).toHaveLength(4);
    expect(plan.status).toBe('planning');

    // Provenance sidecar lives at plan.json.provenance.json.
    const prov = readProvenance(planPath);

    expect(prov).not.toBeNull();
    expect(prov?.model).toBe('local/test-model');
    expect(prov?.thinkingLevel).toBe('off');
    expect(prov?.timestamp).toBe('2025-03-04T05:06:07.000Z');
  });

  test('(b) malformed → retries → valid', async () => {
    // First response is not parseable JSON; second is a valid plan.
    const session = makeSession(['this is prose not JSON', validPlan(3)]);
    const onRetry = vi.fn();
    const result = await runPlanner({
      question: 'Tell me about rust 1.0',
      cwd: sandbox,
      session,
      model: 'local/test-model',
      thinkingLevel: null,
      onRetry,
    });

    expect(result.usedFallback).toBe(false);
    expect(session.prompts).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('(c) retries exhausted → deterministic fallback plan is written', async () => {
    // Four bad responses; default maxRetries is 3 so the fallback fires.
    const session = makeSession(['nope', 'still nope', 'really nope', 'should-not-be-consumed']);
    const result = await runPlanner({
      question: 'vague question',
      cwd: sandbox,
      session,
      model: 'm/x',
      thinkingLevel: null,
      maxRetries: 3,
    });

    expect(result.usedFallback).toBe(true);

    const plan = readPlan(join(result.runRoot, 'plan.json'));

    assertKind(plan, 'deep-research');

    expect(plan.subQuestions).toHaveLength(1);
    expect(plan.subQuestions[0].question).toBe('vague question');
  });

  test('(d) stuck response propagates with no plan.json on disk', async () => {
    const session = makeSession([`{"status":"${STUCK_STATUS}","reason":"question too vague"}`]);
    const result = await runPlanner({
      question: 'uh',
      cwd: sandbox,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.stuck?.reason).toBe('question too vague');
    // The runRoot directory exists (created up-front) but plan.json
    // is not written when the planner is stuck.
    expect(existsSync(join(result.runRoot, 'plan.json'))).toBe(false);
  });

  test('(e) tiny adapter disabled: deterministic slug + no tiny calls', async () => {
    const session = makeSession([validPlan(3)]);
    const tiny = disabledTinyAdapter();
    const rewriteSpy = vi.spyOn(tiny, 'callTinyRewrite');
    const result = await runPlanner({
      question: 'The Quick Brown Fox Jumps',
      cwd: sandbox,
      session,
      model: 'm/x',
      thinkingLevel: null,
      tinyAdapter: tiny,
      tinyCtx: {
        cwd: sandbox,
        model: undefined,
        modelRegistry: { find: () => undefined, authStorage: null },
      },
    });

    expect(result.runRoot.endsWith('the-quick-brown-fox-jumps')).toBe(true);
    expect(rewriteSpy).not.toHaveBeenCalled();
  });

  test('(f) tiny adapter enabled: slug flows through callTinyRewrite(slugify)', async () => {
    const session = makeSession([validPlan(3)]);
    const rewrite: TinyRewriteFn = vi.fn((_ctx, task) => Promise.resolve(task === 'slugify' ? 'tiny-slug' : null));
    const tiny = mockTinyAdapter({ rewrite });
    const result = await runPlanner({
      question: 'pick a topic',
      cwd: sandbox,
      session,
      model: 'm/x',
      thinkingLevel: null,
      tinyAdapter: tiny,
      tinyCtx: {
        cwd: sandbox,
        model: undefined,
        modelRegistry: { find: () => undefined, authStorage: null },
      },
    });

    expect(result.runRoot.endsWith('tiny-slug')).toBe(true);
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  test('(g) tiny URL-type classification reorders search hints by priority', async () => {
    // Planner emits two search hints per sub-question. The tiny
    // adapter classifies one as "content" (highest priority) and
    // the other as "search" (lower priority). Result: content
    // hint sorts first, deterministically.
    const subs = [
      { id: 'sq-1', question: 'q1', searchHints: ['https://search.example.com/?q=foo', 'https://example.com/page'] },
      { id: 'sq-2', question: 'q2', searchHints: ['https://foo', 'https://bar'] },
      { id: 'sq-3', question: 'q3', searchHints: ['only-one'] }, // single hint: no classification path
    ];
    const session = makeSession([JSON.stringify({ subQuestions: subs })]);
    const classify: TinyClassifyFn = (_ctx, _task, url) => {
      if (url.includes('search.example.com')) return Promise.resolve('search');
      if (url.includes('example.com/page')) return Promise.resolve('content');
      if (url === 'https://foo') return Promise.resolve('archive');
      if (url === 'https://bar') return Promise.resolve('other');
      return Promise.resolve(null);
    };
    const tiny = mockTinyAdapter({ classify });
    const result = await runPlanner({
      question: 'ordered-hints',
      cwd: sandbox,
      session,
      model: 'm/x',
      thinkingLevel: null,
      tinyAdapter: tiny,
      tinyCtx: {
        cwd: sandbox,
        model: undefined,
        modelRegistry: { find: () => undefined, authStorage: null },
      },
    });

    expect(result.plannerOutput?.subQuestions[0].searchHints).toEqual([
      'https://example.com/page',
      'https://search.example.com/?q=foo',
    ]);
    // sq-2: archive < other in priority ordering.
    expect(result.plannerOutput?.subQuestions[1].searchHints).toEqual(['https://foo', 'https://bar']);
    // sq-3: single hint, no reordering.
    expect(result.plannerOutput?.subQuestions[2].searchHints).toEqual(['only-one']);
  });

  test('(h) redundant planner output (valid schema but duplicated-content sub-questions) is still persisted - self-critic is the gate', async () => {
    // The planner schema is silent about SEMANTIC redundancy; it
    // only enforces structural uniqueness (id uniqueness). So a
    // structurally-valid "redundant" plan (same questions under
    // different ids) lands untouched, and it is the self-critic's
    // job to rewrite it. We regression-test the planner here so
    // a future tightening doesn't accidentally block valid plans.
    const redundant = JSON.stringify({
      subQuestions: [
        { id: 'sq-1', question: 'What is X?' },
        { id: 'sq-2', question: 'What is X?' },
        { id: 'sq-3', question: 'What is X?' },
      ],
    });
    const session = makeSession([redundant]);
    const result = await runPlanner({
      question: 'tell me about X',
      cwd: sandbox,
      session,
      model: 'm/x',
      thinkingLevel: null,
    });

    expect(result.usedFallback).toBe(false);
    expect(result.plan.subQuestions).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// renderPlannerPrompt.
// ──────────────────────────────────────────────────────────────────────

describe('renderPlannerPrompt', () => {
  test('echoes the budget cap numbers and min/max sub-question range', () => {
    const prompt = renderPlannerPrompt('q', DEFAULT_PLANNER_BUDGET);

    expect(prompt).toContain(String(DEFAULT_PLANNER_BUDGET.maxSubagents));
    expect(prompt).toContain(String(PLANNER_MIN_SUB_QUESTIONS));
    expect(prompt).toContain(String(PLANNER_MAX_SUB_QUESTIONS));
  });

  test('reads the plan as a usable bytes blob (no smart quotes)', () => {
    const prompt = renderPlannerPrompt('q', DEFAULT_PLANNER_BUDGET);

    // Ensure we emit regular ASCII for the JSON examples so qwen3 /
    // small models don't trip on typographic quotes.
    expect(prompt).not.toMatch(/[\u201c\u201d\u2018\u2019]/);
  });
});
