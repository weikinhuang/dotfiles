/**
 * Tests for lib/node/pi/deep-research-rubric.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  renderStructuralRubric,
  renderSubjectiveRubric,
  rubricPaths,
  STRUCTURAL_CHECK_ITEMS,
  writeRubricFiles,
} from '../../../../lib/node/pi/deep-research-rubric.ts';
import { type DeepResearchPlan } from '../../../../lib/node/pi/research-plan.ts';

let sandbox: string;

function makePlan(): DeepResearchPlan {
  return {
    kind: 'deep-research',
    slug: 'demo-plan',
    question: 'What is the state of X in 2025?',
    status: 'planning',
    budget: { maxSubagents: 6, maxFetches: 40, maxCostUsd: 3, wallClockSec: 1800 },
    subQuestions: [
      { id: 'sq-1', question: 'Overview?', status: 'pending' },
      { id: 'sq-2', question: 'Timeline?', status: 'pending' },
      { id: 'sq-3', question: 'Trade-offs?', status: 'pending' },
    ],
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-rubric-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Structural check items.
// ──────────────────────────────────────────────────────────────────────

describe('STRUCTURAL_CHECK_ITEMS', () => {
  test('every item has a unique id and a non-empty text', () => {
    const seenIds = new Set<string>();
    for (const item of STRUCTURAL_CHECK_ITEMS) {
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.text.length).toBeGreaterThan(0);
      expect(seenIds.has(item.id)).toBe(false);

      seenIds.add(item.id);
    }
  });

  test('includes the four headline acceptance checks', () => {
    const ids = STRUCTURAL_CHECK_ITEMS.map((i) => i.id);

    expect(ids).toContain('report-exists');
    expect(ids).toContain('footnote-markers-resolve');
    expect(ids).toContain('footnote-urls-in-store');
    expect(ids).toContain('no-unresolved-placeholders');
    expect(ids).toContain('every-sub-question-has-section');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Renderers.
// ──────────────────────────────────────────────────────────────────────

describe('renderStructuralRubric', () => {
  test('includes every structural item and names every sub-question', () => {
    const plan = makePlan();
    const body = renderStructuralRubric(plan);

    for (const item of STRUCTURAL_CHECK_ITEMS) {
      expect(body).toContain(item.id);
      expect(body).toContain(item.text);
    }

    expect(body).toContain('sq-1');
    expect(body).toContain('Overview?');
    expect(body).toContain('sq-2');
    expect(body).toContain('Timeline?');
    expect(body).toContain('sq-3');
    expect(body).toContain('Trade-offs?');
  });

  test('mentions kind=bash so readers know this is deterministic', () => {
    const body = renderStructuralRubric(makePlan());

    expect(body).toContain('kind=bash');
  });

  test('prefixes the title with the plan slug for greppability', () => {
    const body = renderStructuralRubric(makePlan());

    expect(body).toContain('# Structural Rubric - demo-plan');
  });
});

describe('renderSubjectiveRubric', () => {
  test('excludes structural items (critic should not re-judge them)', () => {
    const body = renderSubjectiveRubric(makePlan());

    for (const item of STRUCTURAL_CHECK_ITEMS) {
      // The whole bullet text shouldn't appear verbatim in the
      // subjective rubric - this is the contract that keeps the
      // critic focused on judgement-only items.
      expect(body).not.toContain(item.text);
    }
  });

  test('mentions kind=critic so readers know the audience', () => {
    const body = renderSubjectiveRubric(makePlan());

    expect(body).toContain('kind=critic');
  });

  test('lists each sub-question for context', () => {
    const body = renderSubjectiveRubric(makePlan());

    expect(body).toContain('sq-1');
    expect(body).toContain('Timeline?');
  });
});

// ──────────────────────────────────────────────────────────────────────
// writeRubricFiles.
// ──────────────────────────────────────────────────────────────────────

describe('writeRubricFiles', () => {
  test('writes both files into the run root when they do not exist', () => {
    const runRoot = join(sandbox, 'research', 'demo');
    const result = writeRubricFiles({ runRoot, plan: makePlan() });

    expect(result.wrote).toEqual({ structural: true, subjective: true });
    expect(existsSync(result.paths.structural)).toBe(true);
    expect(existsSync(result.paths.subjective)).toBe(true);

    expect(readFileSync(result.paths.structural, 'utf8')).toContain('Structural Rubric');
    expect(readFileSync(result.paths.subjective, 'utf8')).toContain('Subjective Rubric');
  });

  test('rubric paths are at the run root (not nested)', () => {
    const runRoot = join(sandbox, 'research', 'demo2');
    const rp = rubricPaths(runRoot);

    expect(rp.structural).toBe(join(runRoot, 'rubric-structural.md'));
    expect(rp.subjective).toBe(join(runRoot, 'rubric-subjective.md'));
  });

  test('overwrites existing files when preserveExisting is false (default)', () => {
    const runRoot = join(sandbox, 'research', 'demo3');
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, 'rubric-structural.md'), 'old content');
    writeFileSync(join(runRoot, 'rubric-subjective.md'), 'old content');

    writeRubricFiles({ runRoot, plan: makePlan() });

    expect(readFileSync(join(runRoot, 'rubric-structural.md'), 'utf8')).not.toContain('old content');
    expect(readFileSync(join(runRoot, 'rubric-subjective.md'), 'utf8')).not.toContain('old content');
  });

  test('preserveExisting: true leaves a user-edited rubric alone', () => {
    const runRoot = join(sandbox, 'research', 'demo4');
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, 'rubric-structural.md'), 'user-edited content');

    const result = writeRubricFiles({ runRoot, plan: makePlan(), preserveExisting: true });

    expect(result.wrote.structural).toBe(false);
    expect(result.wrote.subjective).toBe(true);
    expect(readFileSync(join(runRoot, 'rubric-structural.md'), 'utf8')).toBe('user-edited content');
    expect(readFileSync(join(runRoot, 'rubric-subjective.md'), 'utf8')).toContain('Subjective Rubric');
  });

  test('preserveExisting accepts a custom existsSync for test injection', () => {
    const runRoot = join(sandbox, 'research', 'demo5');
    const result = writeRubricFiles({
      runRoot,
      plan: makePlan(),
      preserveExisting: true,
      existsSync: (p) => p.endsWith('rubric-structural.md'),
    });

    expect(result.wrote).toEqual({ structural: false, subjective: true });
  });

  test('idempotent second call with preserveExisting: false re-emits', () => {
    const runRoot = join(sandbox, 'research', 'demo6');
    writeRubricFiles({ runRoot, plan: makePlan() });
    const first = readFileSync(join(runRoot, 'rubric-structural.md'), 'utf8');
    writeRubricFiles({ runRoot, plan: makePlan() });
    const second = readFileSync(join(runRoot, 'rubric-structural.md'), 'utf8');

    expect(first).toBe(second);
  });
});
