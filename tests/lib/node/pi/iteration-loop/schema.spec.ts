/**
 * Tests for lib/node/pi/iteration-loop/schema.ts.
 *
 * Shape validators must accept well-formed payloads and reject
 * malformed ones; the reducer / storage layers rely on them as the
 * trust boundary between "stuff we loaded from disk/session" and
 * "stuff we can operate on safely."
 */

import { describe, expect, test } from 'vitest';

import {
  buildCheckSpecFromParams,
  cloneIterationState,
  DEFAULT_BUDGET,
  emptyIterationState,
  resolveBudget,
  type CheckSpec,
  type HistoryEntry,
  type IterationState,
} from '../../../../../lib/node/pi/iteration-loop/schema.ts';
import {
  isBashCheckSpecShape,
  isBashPassOn,
  isBudgetSpecShape,
  isCheckKind,
  isCheckSpecShape,
  isCriticCheckSpecShape,
  isIterationStateShape,
  isVerdictShape,
} from '../../../../../lib/node/pi/iteration-loop/guards.ts';

const startedAt = '2026-05-01T00:00:00Z';

const validBashSpec = (): CheckSpec => ({
  task: 'default',
  kind: 'bash',
  artifact: 'out.svg',
  spec: { cmd: 'true', passOn: 'exit-zero' },
  createdAt: startedAt,
});

const validCriticSpec = (): CheckSpec => ({
  task: 'default',
  kind: 'critic',
  artifact: 'out.svg',
  spec: { rubric: 'must be a valid SVG' },
  createdAt: startedAt,
});

describe('isCheckKind', () => {
  test('accepts bash/critic, rejects everything else', () => {
    expect(isCheckKind('bash')).toBe(true);
    expect(isCheckKind('critic')).toBe(true);
    expect(isCheckKind('diff')).toBe(false);
    expect(isCheckKind(null)).toBe(false);
    expect(isCheckKind(undefined)).toBe(false);
  });
});

describe('isBashPassOn', () => {
  test('exit-zero / regex: / jq: / rejects others', () => {
    expect(isBashPassOn('exit-zero')).toBe(true);
    expect(isBashPassOn('regex:foo')).toBe(true);
    expect(isBashPassOn('jq:.ok')).toBe(true);
    expect(isBashPassOn('always')).toBe(false);
    expect(isBashPassOn('')).toBe(false);
  });
});

describe('isBudgetSpecShape', () => {
  test('undefined is ok (optional field)', () => {
    expect(isBudgetSpecShape(undefined)).toBe(true);
  });

  test('empty object ok', () => {
    expect(isBudgetSpecShape({})).toBe(true);
  });

  test('numeric fields must be non-negative finite', () => {
    expect(isBudgetSpecShape({ maxIter: 5 })).toBe(true);
    expect(isBudgetSpecShape({ maxIter: -1 })).toBe(false);
    expect(isBudgetSpecShape({ maxCostUsd: Number.NaN })).toBe(false);
  });
});

describe('isBashCheckSpecShape', () => {
  test('accepts minimal cmd', () => {
    expect(isBashCheckSpecShape({ cmd: 'true' })).toBe(true);
  });

  test('rejects missing cmd', () => {
    expect(isBashCheckSpecShape({})).toBe(false);
  });

  test('rejects non-string env values', () => {
    expect(isBashCheckSpecShape({ cmd: 'true', env: { X: 1 as unknown as string } })).toBe(false);
  });
});

describe('isCriticCheckSpecShape', () => {
  test('requires non-empty rubric', () => {
    expect(isCriticCheckSpecShape({ rubric: 'x' })).toBe(true);
    expect(isCriticCheckSpecShape({ rubric: '' })).toBe(false);
    expect(isCriticCheckSpecShape({})).toBe(false);
  });
});

describe('isCheckSpecShape', () => {
  test('accepts valid bash spec', () => {
    expect(isCheckSpecShape(validBashSpec())).toBe(true);
  });

  test('accepts valid critic spec', () => {
    expect(isCheckSpecShape(validCriticSpec())).toBe(true);
  });

  test('rejects kind/spec mismatch', () => {
    const bad = { ...validBashSpec(), spec: { rubric: 'hi' } };

    expect(isCheckSpecShape(bad)).toBe(false);
  });

  test('rejects unknown kind', () => {
    const bad = { ...validBashSpec(), kind: 'diff' } as unknown;

    expect(isCheckSpecShape(bad)).toBe(false);
  });

  test('rejects empty artifact', () => {
    const bad = { ...validBashSpec(), artifact: '' };

    expect(isCheckSpecShape(bad)).toBe(false);
  });
});

describe('buildCheckSpecFromParams', () => {
  test('builds bash specs with trimmed artifact and optional budget', () => {
    const result = buildCheckSpecFromParams(
      'default',
      {
        kind: 'bash',
        artifact: ' out.svg ',
        cmd: ' test -s out.svg ',
        passOn: 'regex:<svg',
        env: { CI: '1' },
        workdir: 'site',
        timeoutMs: 30_000,
        maxIter: 4,
        maxCostUsd: 0.5,
        wallClockSeconds: 120,
      },
      '2026-05-01T00:00:00Z',
    );

    expect(result).toEqual({
      ok: true,
      spec: {
        task: 'default',
        kind: 'bash',
        artifact: 'out.svg',
        spec: {
          cmd: 'test -s out.svg',
          passOn: 'regex:<svg',
          env: { CI: '1' },
          workdir: 'site',
          timeoutMs: 30_000,
        },
        createdAt: '2026-05-01T00:00:00Z',
        budget: { maxIter: 4, maxCostUsd: 0.5, wallClockSeconds: 120 },
      },
    });
  });

  test('omits default bash passOn from the persisted spec', () => {
    const result = buildCheckSpecFromParams(
      'default',
      { kind: 'bash', artifact: 'out.svg', cmd: 'true', passOn: 'exit-zero' },
      '2026-05-01T00:00:00Z',
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.spec.spec).toEqual({ cmd: 'true' });
  });

  test('builds critic specs with optional agent and model override', () => {
    const result = buildCheckSpecFromParams(
      'default',
      {
        kind: 'critic',
        artifact: 'out.svg',
        rubric: 'must be a valid SVG',
        agent: 'critic',
        modelOverride: 'llama-cpp/qwen3',
      },
      '2026-05-01T00:00:00Z',
    );

    expect(result).toMatchObject({
      ok: true,
      spec: {
        kind: 'critic',
        spec: { rubric: 'must be a valid SVG', agent: 'critic', modelOverride: 'llama-cpp/qwen3' },
      },
    });
  });

  test('returns validation errors for incomplete declarations', () => {
    expect(buildCheckSpecFromParams('default', {}, startedAt)).toMatchObject({ ok: false });
    expect(buildCheckSpecFromParams('default', { kind: 'bash', artifact: 'out.svg' }, startedAt)).toMatchObject({
      ok: false,
      error: 'declare kind=bash requires `cmd`',
    });
    expect(buildCheckSpecFromParams('default', { kind: 'critic', artifact: 'out.svg' }, startedAt)).toMatchObject({
      ok: false,
      error: 'declare kind=critic requires `rubric`',
    });
  });

  test('rejects unsupported bash passOn and unknown kinds', () => {
    expect(
      buildCheckSpecFromParams(
        'default',
        { kind: 'bash', artifact: 'out.svg', cmd: 'true', passOn: 'always' },
        startedAt,
      ),
    ).toMatchObject({ ok: false, error: 'invalid passOn "always" - use exit-zero, regex:<pat>, or jq:<expr>' });
    expect(buildCheckSpecFromParams('default', { kind: 'diff', artifact: 'out.svg' }, startedAt)).toMatchObject({
      ok: false,
      error: 'unknown kind "diff"',
    });
  });
});

describe('isVerdictShape', () => {
  test('accepts minimal approved', () => {
    expect(isVerdictShape({ approved: true, score: 1, issues: [] })).toBe(true);
  });

  test('score must be 0..1', () => {
    expect(isVerdictShape({ approved: false, score: 1.5, issues: [] })).toBe(false);
    expect(isVerdictShape({ approved: false, score: -0.1, issues: [] })).toBe(false);
  });

  test('rejects invalid issue severity', () => {
    expect(
      isVerdictShape({
        approved: false,
        score: 0,
        issues: [{ severity: 'critical', description: 'x' }],
      }),
    ).toBe(false);
  });
});

describe('isIterationStateShape', () => {
  test('accepts empty state', () => {
    expect(isIterationStateShape(emptyIterationState('default', '2026-05-01T00:00:00Z'))).toBe(true);
  });

  test('rejects missing fields', () => {
    expect(isIterationStateShape({ task: 'default' })).toBe(false);
  });

  test('rejects malformed history entry', () => {
    const s = emptyIterationState('default', '2026-05-01T00:00:00Z');
    const bogusHistory = [{ iteration: 1 }] as unknown as HistoryEntry[];
    const mutated: IterationState = { ...s, history: bogusHistory };

    expect(isIterationStateShape(mutated)).toBe(false);
  });
});

describe('resolveBudget', () => {
  test('returns defaults when budget omitted', () => {
    expect(resolveBudget(validBashSpec())).toEqual(DEFAULT_BUDGET);
  });

  test('overrides individually', () => {
    const spec = { ...validBashSpec(), budget: { maxIter: 10 } };
    const r = resolveBudget(spec);

    expect(r.maxIter).toBe(10);
    expect(r.maxCostUsd).toBe(DEFAULT_BUDGET.maxCostUsd);
  });
});

describe('cloneIterationState', () => {
  test('deep-copies history + issues + bestSoFar', () => {
    const s = emptyIterationState('default', '2026-05-01T00:00:00Z');
    s.history.push({
      iteration: 1,
      score: 0.5,
      approved: false,
      summary: 's',
      stopReason: null,
      ranAt: '2026-05-01T00:00:01Z',
    });
    s.bestSoFar = { iteration: 1, score: 0.5, snapshotPath: '/x', artifactHash: 'abc', approved: true };
    s.lastVerdict = {
      approved: false,
      score: 0.5,
      issues: [{ severity: 'major', description: 'd' }],
    };
    const c = cloneIterationState(s);
    c.history[0].score = 0.99;
    c.bestSoFar!.score = 0.99;
    c.lastVerdict!.issues[0].description = 'mutated';

    expect(s.history[0].score).toBe(0.5);
    expect(s.bestSoFar.score).toBe(0.5);
    expect(s.lastVerdict.issues[0].description).toBe('d');
  });
});
