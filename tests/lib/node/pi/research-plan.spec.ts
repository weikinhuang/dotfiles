/**
 * Tests for lib/node/pi/research-plan.ts.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type AutoresearchPlan,
  type DeepResearchPlan,
  isPlan,
  type Plan,
  type PlanBudget,
  PlanValidationError,
  readPlan,
  upgrade,
  writePlan,
} from '../../../../lib/node/pi/research-plan.ts';

/**
 * Run `fn` and return whatever it threw, or `undefined` if it
 * returned normally. Lets tests capture the thrown error *outside*
 * a conditional block so the `expect` calls don't trip
 * vitest/no-conditional-expect.
 */
function catchThrown<T>(fn: () => T): unknown {
  try {
    fn();

    return undefined;
  } catch (err) {
    return err;
  }
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-plan-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const budget: PlanBudget = {
  maxSubagents: 5,
  maxFetches: 50,
  maxCostUsd: 0.25,
  wallClockSec: 600,
};

const deepResearch: DeepResearchPlan = {
  kind: 'deep-research',
  question: 'How do X and Y relate?',
  slug: 'how-do-x-and-y-relate',
  subQuestions: [
    { id: 'sq-1', question: 'What is X?', status: 'pending' },
    {
      id: 'sq-2',
      question: 'What is Y?',
      status: 'assigned',
      assignedAgent: 'explore',
      findingsPath: 'findings/sq-2.md',
    },
  ],
  budget,
  status: 'planning',
};

const autoresearch: AutoresearchPlan = {
  kind: 'autoresearch',
  topic: 'performance of foo vs bar',
  slug: 'foo-vs-bar',
  experiments: [
    {
      id: 'e-1',
      hypothesis: 'foo is faster under low load',
      status: 'pending',
      dir: 'experiments/e-1',
      metricsSchema: { type: 'object' },
    },
  ],
  budget,
  status: 'planning',
};

describe('isPlan', () => {
  test('accepts a valid deep-research plan', () => {
    expect(isPlan(deepResearch)).toBe(true);
  });

  test('accepts a valid autoresearch plan', () => {
    expect(isPlan(autoresearch)).toBe(true);
  });

  test('rejects missing kind', () => {
    const noKind: Record<string, unknown> = { ...(deepResearch as unknown as Record<string, unknown>) };
    delete noKind.kind;

    expect(isPlan(noKind)).toBe(false);
  });

  test('rejects unknown kind', () => {
    expect(isPlan({ ...deepResearch, kind: 'survey' })).toBe(false);
  });

  test('rejects invalid status for the discriminated variant', () => {
    expect(isPlan({ ...deepResearch, status: 'experiment' })).toBe(false);
    expect(isPlan({ ...autoresearch, status: 'fanout' })).toBe(false);
  });

  test('rejects malformed sub-question', () => {
    const broken = {
      ...deepResearch,
      subQuestions: [{ id: 'sq-1', question: 'ok', status: 'bogus' }],
    };

    expect(isPlan(broken as unknown)).toBe(false);
  });

  test('rejects experiment with missing metricsSchema key', () => {
    const broken = {
      ...autoresearch,
      experiments: [{ id: 'e', hypothesis: 'h', status: 'pending', dir: 'd' }],
    };

    expect(isPlan(broken as unknown)).toBe(false);
  });
});

describe('upgrade', () => {
  test('roundtrips a valid deep-research plan', () => {
    const roundtripped: Plan = upgrade(JSON.parse(JSON.stringify(deepResearch)));

    expect(roundtripped).toEqual(deepResearch);
  });

  test('roundtrips a valid autoresearch plan', () => {
    const roundtripped: Plan = upgrade(JSON.parse(JSON.stringify(autoresearch)));

    expect(roundtripped).toEqual(autoresearch);
  });

  test('ignores unknown top-level fields', () => {
    const dr = { ...deepResearch, version: 7, notes: 'hello' } as unknown;
    const out = upgrade(dr);

    expect(out).toEqual(deepResearch);
    expect((out as unknown as Record<string, unknown>).version).toBeUndefined();
  });

  test('ignores unknown sub-question fields', () => {
    const dr = {
      ...deepResearch,
      subQuestions: [{ ...deepResearch.subQuestions[0], extraField: true }],
    };
    const out = upgrade(dr) as DeepResearchPlan;

    expect(out.subQuestions[0]).toEqual(deepResearch.subQuestions[0]);
  });

  test('preserves metricsSchema: null', () => {
    const ar = {
      ...autoresearch,
      experiments: [{ ...autoresearch.experiments[0], metricsSchema: null }],
    };
    const out = upgrade(ar) as AutoresearchPlan;

    expect(out.experiments[0].metricsSchema).toBeNull();
  });
});

describe('upgrade — structural error paths', () => {
  test('rejects a non-object input with a $ path', () => {
    const err = catchThrown(() => upgrade('plan'));

    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).path).toBe('$');
  });

  test('localizes error to $.kind for an unknown discriminator', () => {
    const err = catchThrown(() => upgrade({ kind: 'survey' }));

    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).path).toBe('$.kind');
  });

  test('localizes error to $.subQuestions[2].status', () => {
    const broken = {
      ...deepResearch,
      subQuestions: [
        { id: 's1', question: 'q', status: 'pending' },
        { id: 's2', question: 'q', status: 'pending' },
        { id: 's3', question: 'q', status: 'xxx' },
      ],
    };
    const err = catchThrown(() => upgrade(broken));

    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).path).toBe('$.subQuestions[2].status');
  });

  test('rejects missing budget', () => {
    const noBudget: Record<string, unknown> = { ...(deepResearch as unknown as Record<string, unknown>) };
    delete noBudget.budget;
    const err = catchThrown(() => upgrade(noBudget));

    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).path).toBe('$.budget');
  });

  test('rejects negative budget values', () => {
    const broken = { ...deepResearch, budget: { ...budget, maxCostUsd: -1 } };

    expect(() => upgrade(broken)).toThrow(PlanValidationError);
  });

  test('rejects missing experiment metricsSchema key', () => {
    const broken = {
      ...autoresearch,
      experiments: [{ id: 'e', hypothesis: 'h', status: 'pending', dir: 'd' }],
    };
    const err = catchThrown(() => upgrade(broken));

    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).path).toBe('$.experiments[0].metricsSchema');
  });
});

describe('readPlan / writePlan', () => {
  test('writes + reads back a deep-research plan', () => {
    const p = join(cwd, 'plan.json');
    writePlan(p, deepResearch);

    expect(existsSync(p)).toBe(true);
    expect(readPlan(p)).toEqual(deepResearch);
  });

  test('writes + reads back an autoresearch plan', () => {
    const p = join(cwd, 'plan.json');
    writePlan(p, autoresearch);

    expect(readPlan(p)).toEqual(autoresearch);
  });

  test('the on-disk file is pretty-printed JSON with a trailing newline', () => {
    const p = join(cwd, 'plan.json');
    writePlan(p, deepResearch);

    const text = readFileSync(p, 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  ');
  });

  test('writePlan rejects a malformed plan before touching disk', () => {
    const p = join(cwd, 'plan.json');
    const bad = { ...deepResearch, subQuestions: [{}] } as unknown as Plan;

    expect(() => writePlan(p, bad)).toThrow(PlanValidationError);
    expect(existsSync(p)).toBe(false);
  });

  test('readPlan throws for missing file', () => {
    expect(() => readPlan(join(cwd, 'nope.json'))).toThrow(/does not exist/);
  });

  test('readPlan throws for invalid JSON', () => {
    const p = join(cwd, 'plan.json');
    writeFileSync(p, '{not json');

    expect(() => readPlan(p)).toThrow(/not valid JSON/);
  });

  test('readPlan wraps structural errors in PlanValidationError', () => {
    const p = join(cwd, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({ kind: 'deep-research', question: '', slug: 's', subQuestions: [], budget, status: 'planning' }),
    );

    expect(() => readPlan(p)).toThrow(PlanValidationError);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure modes.
// ──────────────────────────────────────────────────────────────────────

describe('readPlan / writePlan — failure modes', () => {
  test('atomic-write contract: no temp file remains after write', () => {
    const p = join(cwd, 'plan.json');
    writePlan(p, deepResearch);

    const residue = readdirSync(cwd).filter((n) => n.includes('.tmp-'));

    expect(residue).toEqual([]);
  });

  test('a plan with a legacy unknown status fails loudly instead of silently normalizing', () => {
    const p = join(cwd, 'plan.json');
    writeFileSync(p, JSON.stringify({ ...deepResearch, status: 'legacy-phase' }));

    expect(() => readPlan(p)).toThrow(PlanValidationError);
  });

  test('upgrading an array input fails with a $ path', () => {
    const err = catchThrown(() => upgrade(['plan']));

    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).path).toBe('$');
  });

  test('upgrading a plan whose sub-questions field is not an array fails localized to that path', () => {
    const err = catchThrown(() => upgrade({ ...deepResearch, subQuestions: 'not-an-array' }));

    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).path).toBe('$.subQuestions');
  });
});
