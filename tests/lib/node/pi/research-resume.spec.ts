/**
 * Tests for lib/node/pi/research-resume.ts.
 *
 * Each test builds a throwaway run-root under $TMPDIR and exercises
 * exactly one helper. Fanout-state invalidation is tested by writing
 * a realistic `fanout.json` (version=1 shape) and inspecting the
 * rewritten file.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  countPriorReviewIterations,
  detectResumeStage,
  invalidateIncompleteFanoutTasks,
  listRecentRuns,
  sumFanoutDeficit,
  validateRunRoot,
} from '../../../../lib/node/pi/research-resume.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers.
// ──────────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'research-resume-spec-'));
}

function writePlan(runRoot: string, subQuestionIds: readonly string[]): void {
  mkdirSync(runRoot, { recursive: true });
  const plan = {
    kind: 'deep-research',
    version: 1,
    question: 'stub question',
    slug: 'stub-slug',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'planning',
    budget: {
      maxSubagents: subQuestionIds.length,
      maxFetches: 20,
      maxCostUsd: 5,
      wallClockSec: 600,
    },
    subQuestions: subQuestionIds.map((id) => ({
      id,
      question: `question ${id}`,
      status: 'pending',
    })),
  };
  writeFileSync(join(runRoot, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

function writeFanout(runRoot: string, entries: readonly { id: string; state: string; output?: string }[]): void {
  const data = {
    version: 1,
    mode: 'sync',
    agentName: 'web-researcher',
    tasks: entries.map((e) => ({
      id: e.id,
      prompt: `prompt for ${e.id}`,
      state: e.state,
      ...(e.output !== undefined ? { output: e.output } : {}),
    })),
  };
  writeFileSync(join(runRoot, 'fanout.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function writeFinding(runRoot: string, id: string, body = `finding ${id}\n`): void {
  const dir = join(runRoot, 'findings');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), body, 'utf8');
}

function writeReviewSnapshot(runRoot: string, iter: number, stage: 'structural' | 'subjective'): void {
  const dir = join(runRoot, 'snapshots', 'review');
  mkdirSync(dir, { recursive: true });
  const padded = iter.toString().padStart(3, '0');
  writeFileSync(join(dir, `iter-${padded}-${stage}.md`), `# snapshot ${iter} ${stage}\n`, 'utf8');
}

/**
 * Narrow a `{ ok: true, … } | { ok: false, error }` discriminator-union
 * to the ok branch, throwing with the error message otherwise. Keeps
 * the `if (!r.ok) throw` idiom out of `test(...)` callbacks so
 * `vitest/no-conditional-in-test` stays satisfied.
 */
function expectOk<T extends { ok: true }>(r: T | { ok: false; error: string }, label = 'result'): T {
  if (!r.ok) throw new Error(`expected ${label} ok, got error: ${r.error}`);
  return r;
}

/** Mirror of {@link expectOk} for the error branch. */
function expectErr<E extends { ok: false; error: string }>(r: { ok: true } | E, label = 'result'): E {
  if (r.ok) throw new Error(`expected ${label} error, got ok`);
  return r;
}

// ──────────────────────────────────────────────────────────────────────
// validateRunRoot
// ──────────────────────────────────────────────────────────────────────

describe('validateRunRoot', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('ok for a valid deep-research run root (absolute path)', () => {
    const runRoot = join(tmp, 'research', 'run-a');
    writePlan(runRoot, ['sq-1']);
    const r = expectOk(validateRunRoot(tmp, runRoot), 'validateRunRoot');

    expect(r.runRoot).toBe(runRoot);
    expect(r.slug).toBe('run-a');
  });

  test('ok for a cwd-relative path', () => {
    const runRoot = join(tmp, 'research', 'run-b');
    writePlan(runRoot, ['sq-1']);
    const r = expectOk(validateRunRoot(tmp, 'research/run-b'), 'validateRunRoot');

    expect(r.slug).toBe('run-b');
  });

  test('error when runRoot does not exist', () => {
    const r = expectErr(validateRunRoot(tmp, 'research/ghost'), 'validateRunRoot');

    expect(r.error).toMatch(/runRoot does not exist/);
  });

  test('error when runRoot has no plan.json', () => {
    const runRoot = join(tmp, 'research', 'empty');
    mkdirSync(runRoot, { recursive: true });
    const r = expectErr(validateRunRoot(tmp, runRoot), 'validateRunRoot');

    expect(r.error).toMatch(/no plan\.json/);
  });

  test('error when plan.json is malformed', () => {
    const runRoot = join(tmp, 'research', 'bad');
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, 'plan.json'), '{ not valid json', 'utf8');
    const r = expectErr(validateRunRoot(tmp, runRoot), 'validateRunRoot');

    expect(r.error).toMatch(/malformed plan\.json/);
  });

  test('error when runRoot is a file, not a directory', () => {
    const runRoot = join(tmp, 'research', 'afile');
    mkdirSync(join(tmp, 'research'), { recursive: true });
    writeFileSync(runRoot, 'not a dir', 'utf8');
    const r = expectErr(validateRunRoot(tmp, runRoot), 'validateRunRoot');

    expect(r.error).toMatch(/not a directory/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// listRecentRuns
// ──────────────────────────────────────────────────────────────────────

describe('listRecentRuns', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns [] when research/ is absent', () => {
    expect(listRecentRuns(tmp)).toEqual([]);
  });

  test('returns [] when research/ is empty', () => {
    mkdirSync(join(tmp, 'research'));

    expect(listRecentRuns(tmp)).toEqual([]);
  });

  test('lists only directories with plan.json; sorts by mtime desc', () => {
    writePlan(join(tmp, 'research', 'old'), ['sq-1']);
    writePlan(join(tmp, 'research', 'new'), ['sq-1']);
    // Dir without plan.json should not appear.
    mkdirSync(join(tmp, 'research', 'missing-plan'), { recursive: true });

    // Force an older mtime on 'old/plan.json'.
    const oldPlan = join(tmp, 'research', 'old', 'plan.json');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(oldPlan, past, past);

    const runs = listRecentRuns(tmp);

    expect(runs.map((r) => r.slug)).toEqual(['new', 'old']);
    expect(runs.every((r) => typeof r.mtimeMs === 'number')).toBe(true);
  });

  test('skips the quarantine directory', () => {
    writePlan(join(tmp, 'research', 'ok'), ['sq-1']);
    writePlan(join(tmp, 'research', '_quarantined'), ['sq-1']);
    const runs = listRecentRuns(tmp);

    expect(runs.map((r) => r.slug)).toEqual(['ok']);
  });

  test('skips dotfiles', () => {
    writePlan(join(tmp, 'research', 'ok'), ['sq-1']);
    writePlan(join(tmp, 'research', '.hidden'), ['sq-1']);
    const runs = listRecentRuns(tmp);

    expect(runs.map((r) => r.slug)).toEqual(['ok']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// countPriorReviewIterations
// ──────────────────────────────────────────────────────────────────────

describe('countPriorReviewIterations', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns 0 when snapshots/review/ is absent', () => {
    expect(countPriorReviewIterations(tmp)).toBe(0);
  });

  test('returns 0 when snapshots/review/ is empty', () => {
    mkdirSync(join(tmp, 'snapshots', 'review'), { recursive: true });

    expect(countPriorReviewIterations(tmp)).toBe(0);
  });

  test('returns max iteration across both stages', () => {
    writeReviewSnapshot(tmp, 1, 'structural');
    writeReviewSnapshot(tmp, 2, 'structural');
    writeReviewSnapshot(tmp, 3, 'subjective');

    expect(countPriorReviewIterations(tmp)).toBe(3);
  });

  test('ignores files that do not match the iter-NNN-stage.md pattern', () => {
    writeReviewSnapshot(tmp, 4, 'structural');
    const dir = join(tmp, 'snapshots', 'review');
    writeFileSync(join(dir, 'readme.md'), 'x', 'utf8');
    writeFileSync(join(dir, 'iter-abc-structural.md'), 'x', 'utf8');
    writeFileSync(join(dir, 'iter-04-structural.md'), 'x', 'utf8'); // wrong padding (2-digit)

    expect(countPriorReviewIterations(tmp)).toBe(4);
  });

  test('handles zero-padded larger iteration numbers', () => {
    writeReviewSnapshot(tmp, 12, 'subjective');
    writeReviewSnapshot(tmp, 100, 'structural');

    expect(countPriorReviewIterations(tmp)).toBe(100);
  });
});

// ──────────────────────────────────────────────────────────────────────
// sumFanoutDeficit
// ──────────────────────────────────────────────────────────────────────

describe('sumFanoutDeficit', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('no fanout.json and no findings → every sub-question needs re-fanout', () => {
    const needs = sumFanoutDeficit(tmp, ['sq-1', 'sq-2']);

    expect(needs).toEqual(['sq-1', 'sq-2']);
  });

  test('findings present and fanout completed → no deficit', () => {
    writeFinding(tmp, 'sq-1');
    writeFinding(tmp, 'sq-2');
    writeFanout(tmp, [
      { id: 'sq-1', state: 'completed' },
      { id: 'sq-2', state: 'completed' },
    ]);

    expect(sumFanoutDeficit(tmp, ['sq-1', 'sq-2'])).toEqual([]);
  });

  test('finding file missing on disk despite state=completed (sq-1/sq-3 anti-pattern) → flagged', () => {
    writeFinding(tmp, 'sq-2');
    writeFanout(tmp, [
      { id: 'sq-1', state: 'completed' }, // state lies; no finding on disk
      { id: 'sq-2', state: 'completed' },
    ]);

    expect(sumFanoutDeficit(tmp, ['sq-1', 'sq-2'])).toEqual(['sq-1']);
  });

  test('failed / aborted / pending states → flagged', () => {
    writeFinding(tmp, 'sq-1');
    writeFinding(tmp, 'sq-2');
    writeFinding(tmp, 'sq-3');
    writeFinding(tmp, 'sq-4');
    writeFanout(tmp, [
      { id: 'sq-1', state: 'completed' },
      { id: 'sq-2', state: 'failed' },
      { id: 'sq-3', state: 'aborted' },
      { id: 'sq-4', state: 'pending' },
    ]);

    expect(sumFanoutDeficit(tmp, ['sq-1', 'sq-2', 'sq-3', 'sq-4'])).toEqual(['sq-2', 'sq-3', 'sq-4']);
  });

  test('empty finding file (size 0) is treated as missing', () => {
    writeFinding(tmp, 'sq-1', '');
    writeFanout(tmp, [{ id: 'sq-1', state: 'completed' }]);

    expect(sumFanoutDeficit(tmp, ['sq-1'])).toEqual(['sq-1']);
  });

  test('malformed fanout.json → treat every sub-question as needing re-fanout', () => {
    writeFinding(tmp, 'sq-1');
    writeFileSync(join(tmp, 'fanout.json'), '{ not valid', 'utf8');

    expect(sumFanoutDeficit(tmp, ['sq-1', 'sq-2'])).toEqual(['sq-1', 'sq-2']);
  });

  test('preserves plan ordering regardless of fanout.json task order', () => {
    writeFinding(tmp, 'sq-2'); // present
    writeFinding(tmp, 'sq-4'); // present
    writeFanout(tmp, [
      { id: 'sq-5', state: 'completed' }, // irrelevant entry
      { id: 'sq-3', state: 'failed' },
      { id: 'sq-1', state: 'failed' },
    ]);

    expect(sumFanoutDeficit(tmp, ['sq-1', 'sq-2', 'sq-3', 'sq-4'])).toEqual(['sq-1', 'sq-3']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// detectResumeStage
// ──────────────────────────────────────────────────────────────────────

describe('detectResumeStage', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('no plan.json → error (nothing to resume)', () => {
    const r = expectErr(detectResumeStage(tmp), 'detectResumeStage');

    expect(r.error).toMatch(/no plan\.json/);
  });

  test('plan + missing findings → stage=fanout with deficit list', () => {
    writePlan(tmp, ['sq-1', 'sq-2', 'sq-3']);
    writeFinding(tmp, 'sq-2');
    writeFanout(tmp, [
      { id: 'sq-1', state: 'failed' },
      { id: 'sq-2', state: 'completed' },
      { id: 'sq-3', state: 'aborted' },
    ]);
    const r = expectOk(detectResumeStage(tmp), 'detectResumeStage');

    expect(r.stage).toBe('fanout');
    expect(r.needsRefanout).toEqual(['sq-1', 'sq-3']);
    expect(r.reason).toContain('sq-1');
  });

  test('all findings present, no report.md → stage=synth', () => {
    writePlan(tmp, ['sq-1', 'sq-2']);
    writeFinding(tmp, 'sq-1');
    writeFinding(tmp, 'sq-2');
    writeFanout(tmp, [
      { id: 'sq-1', state: 'completed' },
      { id: 'sq-2', state: 'completed' },
    ]);
    const r = expectOk(detectResumeStage(tmp), 'detectResumeStage');

    expect(r.stage).toBe('synth');
    expect(r.needsRefanout).toEqual([]);
  });

  test('report.md present → stage=review', () => {
    writePlan(tmp, ['sq-1']);
    writeFinding(tmp, 'sq-1');
    writeFanout(tmp, [{ id: 'sq-1', state: 'completed' }]);
    writeFileSync(join(tmp, 'report.md'), '# report\n', 'utf8');
    const r = expectOk(detectResumeStage(tmp), 'detectResumeStage');

    expect(r.stage).toBe('review');
    expect(r.needsRefanout).toEqual([]);
  });

  test('malformed plan.json → error', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'plan.json'), 'not json', 'utf8');
    const r = expectErr(detectResumeStage(tmp), 'detectResumeStage');

    expect(r.error).toMatch(/plan\.json is malformed/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// invalidateIncompleteFanoutTasks
// ──────────────────────────────────────────────────────────────────────

describe('invalidateIncompleteFanoutTasks', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('no fanout.json → ok with reset:[] (caller creates a fresh file)', () => {
    const r = invalidateIncompleteFanoutTasks(tmp, ['sq-1']);

    expect(r).toEqual({ ok: true, reset: [], untouched: [] });
  });

  test('resets only the targeted ids and drops their output/timestamps', () => {
    writeFanout(tmp, [
      { id: 'sq-1', state: 'failed', output: 'err' },
      { id: 'sq-2', state: 'completed', output: 'ok' },
      { id: 'sq-3', state: 'aborted', output: 'err' },
    ]);
    const r = invalidateIncompleteFanoutTasks(tmp, ['sq-1', 'sq-3']);

    expect(r.ok).toBe(true);
    expect(r.reset).toEqual(['sq-1', 'sq-3']);
    expect(r.untouched).toEqual(['sq-2']);

    // Verify on-disk shape.
    const persisted = JSON.parse(readFileSync(join(tmp, 'fanout.json'), 'utf8')) as {
      tasks: { id: string; state: string; prompt: string; output?: string }[];
    };
    const byId = Object.fromEntries(persisted.tasks.map((t) => [t.id, t]));

    expect(byId['sq-1'].state).toBe('pending');
    expect(byId['sq-1'].output).toBeUndefined();
    expect(byId['sq-1'].prompt).toContain('prompt for sq-1');
    expect(byId['sq-2'].state).toBe('completed');
    expect(byId['sq-2'].output).toBe('ok');
    expect(byId['sq-3'].state).toBe('pending');
    expect(byId['sq-3'].output).toBeUndefined();
  });

  test('empty ids list → no-op (all tasks untouched)', () => {
    writeFanout(tmp, [
      { id: 'sq-1', state: 'completed' },
      { id: 'sq-2', state: 'completed' },
    ]);
    const before = readFileSync(join(tmp, 'fanout.json'), 'utf8');
    const r = invalidateIncompleteFanoutTasks(tmp, []);

    expect(r.ok).toBe(true);
    expect(r.reset).toEqual([]);
    expect(r.untouched).toEqual(['sq-1', 'sq-2']);

    const after = readFileSync(join(tmp, 'fanout.json'), 'utf8');

    expect(after).toBe(before);
  });

  test('malformed fanout.json → ok=false with an error describing the failure', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'fanout.json'), '{ not json', 'utf8');
    const r = invalidateIncompleteFanoutTasks(tmp, ['sq-1']);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fanout\.json parse failed/);
  });

  test('wrong-version fanout.json → ok=false', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'fanout.json'), JSON.stringify({ version: 999 }), 'utf8');
    const r = invalidateIncompleteFanoutTasks(tmp, ['sq-1']);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unexpected shape/);
  });

  test('written file is a valid JSON document (round-trips)', () => {
    writeFanout(tmp, [{ id: 'sq-1', state: 'failed' }]);
    invalidateIncompleteFanoutTasks(tmp, ['sq-1']);
    const raw = readFileSync(join(tmp, 'fanout.json'), 'utf8');

    // atomic-write always terminates with a single newline; accept either.
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    // File is non-zero.
    expect(statSync(join(tmp, 'fanout.json')).size).toBeGreaterThan(0);
  });
});
