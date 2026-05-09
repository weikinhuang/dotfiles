// Tests for lib/node/ai-skill-eval/compare.ts — the R5.1 blind A/B comparator.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  aggregateCompare,
  assignLabels,
  buildComparatorPrompt,
  compareOutputDir,
  compareRecordPath,
  listRunFiles,
  loadComparatorTemplate,
  parseComparatorVerdict,
  pickCanonicalReplyFile,
  renderCompareMarkdown,
  runCompare,
  setComparatorTemplateForTest,
  type CompareRecord,
  type CriticInvoker,
  type RunCompareResult,
  VS_DIR_PREFIX,
} from '../../../../lib/node/ai-skill-eval/compare.ts';
import { iterationPath } from '../../../../lib/node/ai-skill-eval/workspace.ts';

/** Seed a with_skill/results/<eval>/run-<n>.txt tree mirroring what `run` writes. */
function seedReplies(
  workspace: string,
  skill: string,
  iteration: number,
  evalId: string,
  replies: readonly string[],
): string[] {
  const dir = join(iterationPath(workspace, skill, iteration), 'with_skill', 'results', evalId);
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  replies.forEach((body, i) => {
    const p = join(dir, `run-${i + 1}.txt`);
    writeFileSync(p, body);
    paths.push(p);
  });
  return paths;
}

describe('loadComparatorTemplate', () => {
  afterEach(() => setComparatorTemplateForTest(null));

  test('reads the shipped prompts/comparator.md and caches it', () => {
    setComparatorTemplateForTest(null);
    const a = loadComparatorTemplate();
    const b = loadComparatorTemplate();

    expect(a).toBe(b);
    expect(a).toContain('Blind Comparator');
    expect(a).toContain('winner');
  });

  test('setComparatorTemplateForTest overrides and resets the cache', () => {
    setComparatorTemplateForTest('STUB TEMPLATE');

    expect(loadComparatorTemplate()).toBe('STUB TEMPLATE');

    setComparatorTemplateForTest(null);

    expect(loadComparatorTemplate()).toContain('Blind Comparator');
  });
});

describe('buildComparatorPrompt', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ai-skill-eval-compare-prompt-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    setComparatorTemplateForTest(null);
  });

  test('includes rubric + inputs + inlined reply bodies, and names both paths', () => {
    const a = join(tmp, 'a.txt');
    const b = join(tmp, 'b.txt');
    writeFileSync(a, 'TRIGGER: yes\nREASON: from a\nNEXT_STEP: do-a\n');
    writeFileSync(b, 'TRIGGER: yes\nREASON: from b\nNEXT_STEP: do-b\n');

    const prompt = buildComparatorPrompt(
      {
        skill: 'my-skill',
        evalId: 'positive-1',
        evalPrompt: 'scenario text',
        expectations: ['first expectation', 'second expectation'],
        outputAPath: a,
        outputBPath: b,
      },
      'RUBRIC-STUB',
    );

    expect(prompt).toContain('RUBRIC-STUB');
    expect(prompt).toContain('Skill: my-skill');
    expect(prompt).toContain('Eval:  positive-1');
    expect(prompt).toContain(`output_a_path: ${a}`);
    expect(prompt).toContain(`output_b_path: ${b}`);
    expect(prompt).toContain('scenario text');
    expect(prompt).toContain('1. first expectation');
    expect(prompt).toContain('2. second expectation');
    expect(prompt).toContain('REASON: from a');
    expect(prompt).toContain('REASON: from b');
    expect(prompt).toContain('STRICT JSON');
  });

  test('renders a placeholder when expectations[] is empty', () => {
    const a = join(tmp, 'a.txt');
    const b = join(tmp, 'b.txt');
    writeFileSync(a, 'A');
    writeFileSync(b, 'B');
    const prompt = buildComparatorPrompt(
      {
        skill: 's',
        evalId: 'e',
        evalPrompt: 'p',
        expectations: [],
        outputAPath: a,
        outputBPath: b,
      },
      'RUBRIC',
    );

    expect(prompt).toContain('(none — judge on content + structure only)');
  });

  test('surfaces a read error inline when a reply file is missing', () => {
    const a = join(tmp, 'a.txt');
    writeFileSync(a, 'A-body');
    const missing = join(tmp, 'gone.txt');
    const prompt = buildComparatorPrompt(
      {
        skill: 's',
        evalId: 'e',
        evalPrompt: 'p',
        expectations: [],
        outputAPath: a,
        outputBPath: missing,
      },
      'RUBRIC',
    );

    expect(prompt).toContain(`[error reading ${missing}`);
    expect(prompt).toContain('A-body');
  });
});

describe('parseComparatorVerdict', () => {
  test('picks A/B/tie and a reason out of surrounding prose', () => {
    const raw = `pre ${JSON.stringify({ winner: 'A', reason: 'A is cleaner' })} post`;
    const v = parseComparatorVerdict(raw);

    expect(v.winner).toBe('A');
    expect(v.reason).toBe('A is cleaner');
    expect(v.scores).toBeUndefined();
  });

  test("coerces 'Output B' / 'tie' / case-insensitive variants", () => {
    expect(parseComparatorVerdict(JSON.stringify({ winner: 'b', reason: '' })).winner).toBe('B');
    expect(parseComparatorVerdict(JSON.stringify({ winner: 'Output A', reason: '' })).winner).toBe('A');
    expect(parseComparatorVerdict(JSON.stringify({ winner: 'TIE', reason: '' })).winner).toBe('tie');
    expect(parseComparatorVerdict(JSON.stringify({ winner: 'DRAW', reason: '' })).winner).toBe('tie');
  });

  test('falls back to `reasoning` when `reason` is absent (upstream schema)', () => {
    const v = parseComparatorVerdict(JSON.stringify({ winner: 'A', reasoning: 'legacy field' }));

    expect(v.reason).toBe('legacy field');
  });

  test('accepts {a, b} and {A, B} score shapes', () => {
    const v1 = parseComparatorVerdict(
      JSON.stringify({ winner: 'A', reason: 'r', scores: { a: { overall_score: 8 }, b: { overall_score: 5 } } }),
    );

    expect(v1.scores?.a).toEqual({ overall_score: 8 });
    expect(v1.scores?.b).toEqual({ overall_score: 5 });

    const v2 = parseComparatorVerdict(
      JSON.stringify({ winner: 'A', reason: 'r', scores: { A: { overall_score: 9 }, B: { overall_score: 4 } } }),
    );

    expect(v2.scores?.a).toEqual({ overall_score: 9 });
    expect(v2.scores?.b).toEqual({ overall_score: 4 });
  });

  test('throws on missing JSON object or unknown winner', () => {
    expect(() => parseComparatorVerdict('no json here')).toThrow('did not contain a JSON object');
    expect(() => parseComparatorVerdict(JSON.stringify({ winner: 'maybe', reason: '' }))).toThrow(/winner must be/);
  });
});

describe('assignLabels', () => {
  test('rng<0.5 keeps A=first, B=second; otherwise swaps', () => {
    expect(assignLabels(1, 2, () => 0.1)).toEqual({ A: 1, B: 2 });
    expect(assignLabels(1, 2, () => 0.9)).toEqual({ A: 2, B: 1 });
  });
});

describe('listRunFiles / pickCanonicalReplyFile', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ai-skill-eval-compare-canonical-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test('listRunFiles sorts numerically and ignores strays', () => {
    const dir = join(iterationPath(ws, 'skill', 1), 'with_skill', 'results', 'e1');
    mkdirSync(dir, { recursive: true });
    for (const name of ['run-10.txt', 'run-1.txt', 'run-2.txt', 'README.md', 'run-.txt']) {
      writeFileSync(join(dir, name), 'x');
    }
    const files = listRunFiles(ws, 'skill', 1, 'e1');

    expect(files.map((p) => p.replace(`${dir}/`, ''))).toEqual(['run-1.txt', 'run-2.txt', 'run-10.txt']);
  });

  test('pickCanonicalReplyFile returns the majority-trigger run', () => {
    const files = seedReplies(ws, 'skill', 1, 'e1', [
      'TRIGGER: no\nREASON:\nNEXT_STEP:',
      'TRIGGER: yes\nREASON:\nNEXT_STEP:',
      'TRIGGER: yes\nREASON:\nNEXT_STEP:',
    ]);

    expect(pickCanonicalReplyFile(ws, 'skill', 1, 'e1')).toBe(files[1]);
  });

  test('pickCanonicalReplyFile returns null when no runs exist', () => {
    expect(pickCanonicalReplyFile(ws, 'skill', 9, 'missing-eval')).toBeNull();
  });
});

describe('compareOutputDir / compareRecordPath', () => {
  test('path shape matches the R5.1 workspace layout', () => {
    const outDir = compareOutputDir('/ws', 'skill', 1, 2);

    expect(outDir).toBe(`/ws/skill/iteration-1/${VS_DIR_PREFIX}2`);

    const recordPath = compareRecordPath('/ws', 'skill', 1, 2, 'positive-1');

    expect(recordPath).toBe(`/ws/skill/iteration-1/${VS_DIR_PREFIX}2/compare-positive-1.json`);
  });
});

describe('runCompare', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ai-skill-eval-compare-run-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    setComparatorTemplateForTest(null);
  });

  /**
   * Seed iteration-1 and iteration-2 with run files for two evals so a
   * runCompare turn has something to chew on. `replies1` / `replies2`
   * are the per-run bodies under each iteration.
   */
  function seedPair(
    skill: string,
    iterations: [number, number],
    evals: readonly { id: string; replies1: string[]; replies2: string[] }[],
  ): void {
    for (const ev of evals) {
      seedReplies(ws, skill, iterations[0], ev.id, ev.replies1);
      seedReplies(ws, skill, iterations[1], ev.id, ev.replies2);
    }
  }

  test('randomises labels, writes per-eval records, and unblinds the winner', () => {
    seedPair(
      's',
      [1, 2],
      [
        { id: 'e1', replies1: ['TRIGGER: yes\n'], replies2: ['TRIGGER: yes\n'] },
        { id: 'e2', replies1: ['TRIGGER: no\n'], replies2: ['TRIGGER: yes\n'] },
      ],
    );

    // Deterministic PRNG: e1 keeps order (A=iter1, B=iter2), e2 swaps.
    const values = [0.1, 0.9];
    let cursor = 0;
    const rng = (): number => values[cursor++ % values.length];

    // Critic stub: the verdict winner is always 'A' (from the label, not iteration).
    const seenPaths: string[] = [];
    const critic: CriticInvoker = (_cmd, promptFile, outputFile) => {
      seenPaths.push(promptFile);
      const stdout = JSON.stringify({
        winner: 'A',
        reason: `picked A for ${promptFile.split('/').pop()}`,
      });
      writeFileSync(outputFile, stdout);
      return { exitCode: 0, stdout };
    };

    const result = runCompare({
      workspace: ws,
      skill: 's',
      iterationA: 1,
      iterationB: 2,
      criticCmd: ':',
      evals: [
        { id: 'e1', prompt: 'p1', expectations: ['exp'] },
        { id: 'e2', prompt: 'p2', expectations: [] },
      ],
      rng,
      critic,
      template: 'RUBRIC-STUB',
    });

    expect(result.records).toHaveLength(2);
    expect(result.errors).toEqual([]);

    const e1 = result.records.find((r) => r.eval_id === 'e1')!;

    expect(e1.label_mapping).toEqual({ A: 1, B: 2 });
    expect(e1.winner_label).toBe('A');
    expect(e1.winner_iteration).toBe(1);

    const e2 = result.records.find((r) => r.eval_id === 'e2')!;

    expect(e2.label_mapping).toEqual({ A: 2, B: 1 });
    expect(e2.winner_label).toBe('A');
    expect(e2.winner_iteration).toBe(2);

    // Per-eval JSON written to disk matches the in-memory record.
    const e1File = compareRecordPath(ws, 's', 1, 2, 'e1');
    const disk1 = JSON.parse(readFileSync(e1File, 'utf8')) as CompareRecord;

    expect(disk1.winner_iteration).toBe(1);
    expect(disk1.label_mapping).toEqual({ A: 1, B: 2 });

    // Summary exists alongside the records.
    const summary = JSON.parse(
      readFileSync(join(compareOutputDir(ws, 's', 1, 2), 'summary.json'), 'utf8'),
    ) as RunCompareResult;

    expect(summary.records).toHaveLength(2);
  });

  test('ties produce winner_iteration=null; aggregate splits wins/ties/errors', () => {
    seedPair(
      's',
      [1, 2],
      [
        { id: 'e1', replies1: ['TRIGGER: yes\n'], replies2: ['TRIGGER: yes\n'] },
        { id: 'e2', replies1: ['TRIGGER: yes\n'], replies2: ['TRIGGER: yes\n'] },
        { id: 'e3', replies1: ['TRIGGER: yes\n'], replies2: ['TRIGGER: yes\n'] },
      ],
    );
    // iter1 only for e4 -> should error out with a missing-file reason.
    seedReplies(ws, 's', 1, 'e4', ['TRIGGER: yes\n']);

    const winners: ('A' | 'B' | 'tie')[] = ['A', 'B', 'tie'];
    let cursor = 0;
    const critic: CriticInvoker = (_cmd, _prompt, outputFile) => {
      const w = winners[cursor++];
      const stdout = JSON.stringify({ winner: w, reason: `winner=${w}` });
      writeFileSync(outputFile, stdout);
      return { exitCode: 0, stdout };
    };

    const result = runCompare({
      workspace: ws,
      skill: 's',
      iterationA: 1,
      iterationB: 2,
      criticCmd: ':',
      evals: [
        { id: 'e1', prompt: 'p', expectations: [] },
        { id: 'e2', prompt: 'p', expectations: [] },
        { id: 'e3', prompt: 'p', expectations: [] },
        { id: 'e4', prompt: 'p', expectations: [] },
      ],
      rng: () => 0.1, // always A=iter1, B=iter2
      critic,
      template: 'RUBRIC',
    });

    expect(result.records).toHaveLength(3);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.eval_id).toBe('e4');

    const agg = aggregateCompare(result);

    expect(agg).toMatchObject({ wins_a: 1, wins_b: 1, ties: 1, decided: 3, errors: 1 });
    expect(agg.win_rate_a).toBeCloseTo(0.33, 2);
  });

  test('records critic exit failures + JSON parse failures as errors', () => {
    seedPair(
      's',
      [1, 2],
      [
        { id: 'bad-exit', replies1: ['TRIGGER: yes\n'], replies2: ['TRIGGER: yes\n'] },
        { id: 'bad-json', replies1: ['TRIGGER: yes\n'], replies2: ['TRIGGER: yes\n'] },
      ],
    );

    const critic: CriticInvoker = (_cmd, promptFile, outputFile) => {
      if (promptFile.includes('bad-exit')) {
        writeFileSync(outputFile, '');
        return { exitCode: 1, stdout: '' };
      }
      writeFileSync(outputFile, 'no json here');
      return { exitCode: 0, stdout: 'no json here' };
    };

    const result = runCompare({
      workspace: ws,
      skill: 's',
      iterationA: 1,
      iterationB: 2,
      criticCmd: ':',
      evals: [
        { id: 'bad-exit', prompt: 'p', expectations: [] },
        { id: 'bad-json', prompt: 'p', expectations: [] },
      ],
      rng: () => 0.1,
      critic,
      template: 'RUBRIC',
    });

    expect(result.records).toEqual([]);
    expect(result.errors.map((e) => e.eval_id).sort()).toEqual(['bad-exit', 'bad-json']);
    expect(result.errors.find((e) => e.eval_id === 'bad-exit')?.reason).toMatch(/critic exit 1/);
    expect(result.errors.find((e) => e.eval_id === 'bad-json')?.reason).toMatch(/did not contain a JSON object/);
  });
});

describe('renderCompareMarkdown', () => {
  test('reports aggregate win rates, per-eval table, and errors', () => {
    const md = renderCompareMarkdown({
      skill: 's',
      iteration_a: 1,
      iteration_b: 2,
      records: [
        {
          skill: 's',
          eval_id: 'e1',
          iteration_a: 1,
          iteration_b: 2,
          label_mapping: { A: 1, B: 2 },
          output_a_path: '/a',
          output_b_path: '/b',
          winner_label: 'A',
          winner_iteration: 1,
          reason: 'A is cleaner\nand more complete',
          raw_verdict: {},
        },
        {
          skill: 's',
          eval_id: 'e2',
          iteration_a: 1,
          iteration_b: 2,
          label_mapping: { A: 2, B: 1 },
          output_a_path: '/a',
          output_b_path: '/b',
          winner_label: 'tie',
          winner_iteration: null,
          reason: 'evenly matched',
          raw_verdict: {},
        },
      ],
      errors: [{ eval_id: 'e3', reason: 'missing reply file' }],
    });

    expect(md).toContain('compare s: iteration-1 vs iteration-2');
    expect(md).toContain('iteration-1 wins: **1**');
    expect(md).toContain('iteration-2 wins: **0**');
    expect(md).toContain('ties: 1');
    expect(md).toContain('| e1 | iteration-1 (A) | A is cleaner and more complete |');
    expect(md).toContain('| e2 | tie | evenly matched |');
    expect(md).toContain('errors');
    expect(md).toContain('- e3: missing reply file');
  });
});
