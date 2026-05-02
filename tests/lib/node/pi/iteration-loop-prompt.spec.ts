/**
 * Tests for lib/node/pi/iteration-loop-prompt.ts.
 *
 * Uses deterministic `now` + whole-string snapshot equality to catch
 * unintended format drift.
 */

import { describe, expect, test } from 'vitest';
import { renderIterationBlock } from '../../../../lib/node/pi/iteration-loop-prompt.ts';
import {
  type BashCheckSpec,
  type CheckSpec,
  emptyIterationState,
  type IterationState,
} from '../../../../lib/node/pi/iteration-loop-schema.ts';

const startedAt = '2026-05-01T00:00:00Z';
const now = new Date('2026-05-01T00:00:30Z');

const bashSpec = (): CheckSpec => ({
  task: 'default',
  kind: 'bash',
  artifact: 'out.svg',
  spec: { cmd: 'test -s out.svg', passOn: 'exit-zero' },
  createdAt: startedAt,
  budget: { maxIter: 5 },
});

const criticSpec = (): CheckSpec => ({
  task: 'default',
  kind: 'critic',
  artifact: 'out.svg',
  spec: { rubric: 'must be an SVG', modelOverride: 'llama-cpp/qwen3' },
  createdAt: startedAt,
});

describe('no-task / none', () => {
  test('returns null when spec is null', () => {
    expect(renderIterationBlock(null, 'none', null)).toBeNull();
  });

  test('returns null when state is none', () => {
    expect(renderIterationBlock(bashSpec(), 'none', null)).toBeNull();
  });
});

describe('draft pending', () => {
  test('names the task, artifact, kind, and next step', () => {
    const block = renderIterationBlock(bashSpec(), 'draft', null);

    expect(block).not.toBeNull();
    expect(block!).toContain('## Iteration Loop (task: default)');
    expect(block!).toContain('draft pending user acceptance');
    expect(block!).toContain('out.svg');
    expect(block!).toContain('check accept default');
  });
});

describe('active: no runs yet', () => {
  test('shows iteration 0/max with directive next step', () => {
    const block = renderIterationBlock(bashSpec(), 'active', null, { now });

    expect(block).not.toBeNull();
    expect(block!).toContain('Iteration:   0 / 5');
    expect(block!).toContain('Next step:');
    expect(block!).toContain('check run');
  });

  test('from a freshly-seeded state', () => {
    const state = emptyIterationState('default', startedAt);
    const block = renderIterationBlock(bashSpec(), 'active', state, { now });

    expect(block!).toContain('Iteration:   0 / 5');
    expect(block!).toContain('Cost:        $0.000 / budget $0.100');
  });
});

describe('active: after a not-approved run', () => {
  test('renders last verdict + issues + directive to fix top issue', () => {
    const state: IterationState = {
      task: 'default',
      iteration: 2,
      editsSinceLastCheck: 0,
      lastCheckTurn: 5,
      lastVerdict: {
        approved: false,
        score: 0.62,
        issues: [
          { severity: 'blocker', description: 'labels missing' },
          { severity: 'minor', description: 'colors off' },
        ],
      },
      bestSoFar: { iteration: 1, score: 0.7, snapshotPath: '/tmp/x', artifactHash: 'h', approved: false },
      costUsd: 0.014,
      history: [],
      stopReason: null,
      startedAt,
    };
    const block = renderIterationBlock(bashSpec(), 'active', state, { now });

    expect(block!).toContain('Last verdict: not approved — score 0.62');
    expect(block!).toContain('[blocker] labels missing');
    expect(block!).toContain('[minor] colors off');
    expect(block!).toContain('Best so far:  iter 1 (score 0.70)');
    expect(block!).toContain('labels missing');
    expect(block!.toLowerCase()).toContain('next step');
  });

  test('edits since last check ⇒ directive to run check FIRST', () => {
    const state: IterationState = {
      task: 'default',
      iteration: 1,
      editsSinceLastCheck: 2,
      lastCheckTurn: 3,
      lastVerdict: { approved: false, score: 0.3, issues: [] },
      bestSoFar: null,
      costUsd: 0,
      history: [],
      stopReason: null,
      startedAt,
    };
    const block = renderIterationBlock(bashSpec(), 'active', state, { now });

    expect(block!).toContain("you've made 2 edit(s) since the last check");
    expect(block!).toContain('BEFORE making more edits');
  });
});

describe('active: stopped loops', () => {
  test('stopReason=passed says "call close"', () => {
    const state: IterationState = {
      ...emptyIterationState('default', startedAt),
      iteration: 2,
      lastVerdict: { approved: true, score: 1, issues: [] },
      stopReason: 'passed',
    };
    const block = renderIterationBlock(bashSpec(), 'active', state, { now });

    expect(block!).toContain('Stopped:     passed');
    expect(block!).toContain('check close');
  });

  test('stopReason=budget-iter says "report best-so-far"', () => {
    const state: IterationState = {
      ...emptyIterationState('default', startedAt),
      iteration: 5,
      lastVerdict: { approved: false, score: 0.8, issues: [] },
      bestSoFar: { iteration: 3, score: 0.9, snapshotPath: '/x', artifactHash: 'h', approved: true },
      stopReason: 'budget-iter',
    };
    const block = renderIterationBlock(bashSpec(), 'active', state, { now });

    expect(block!).toContain('Stopped:     budget-iter');
    expect(block!).toContain('best-so-far');
  });

  test('fixpoint mentions "more edits aren\'t changing"', () => {
    const state: IterationState = {
      ...emptyIterationState('default', startedAt),
      iteration: 3,
      lastVerdict: { approved: false, score: 0.5, issues: [] },
      stopReason: 'fixpoint',
    };
    const block = renderIterationBlock(bashSpec(), 'active', state, { now });

    expect(block!).toContain('Stopped:     fixpoint');
    expect(block!).toContain("aren't changing anything");
  });
});

describe('check summary row', () => {
  test('bash shows cmd + passOn (truncated when long)', () => {
    const spec = bashSpec();
    (spec.spec as BashCheckSpec).cmd = 'x'.repeat(80);
    const block = renderIterationBlock(spec, 'active', null, { now });

    expect(block!).toContain('bash (exit-zero)');
    expect(block!).toContain('...');
  });

  test('critic shows agent + model override', () => {
    const block = renderIterationBlock(criticSpec(), 'active', null, { now });

    expect(block!).toContain('critic (agent: critic via llama-cpp/qwen3)');
  });
});
