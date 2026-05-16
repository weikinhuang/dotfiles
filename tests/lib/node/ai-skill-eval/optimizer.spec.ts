// SPDX-License-Identifier: MIT
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  appendDescriptionHistory,
  loadTriggerEvalSet,
  runOptimizeLoop,
  type DescriptionHistoryEntry,
  type OptimizerHooks,
  type TriggerEval,
} from '../../../../lib/node/ai-skill-eval/optimizer.ts';
import { parseSkillMdText } from '../../../../lib/node/ai-skill-eval/skill-md.ts';

const SAMPLE_SKILL = `---
name: sample
description: 'Initial description for tests.'
---

# sample

Body text.
`;

function freshDir(prefix = 'optimizer-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function triggerEvalSet(): TriggerEval[] {
  return [
    { query: 'pos 1', should_trigger: true, id: 'pos-1' },
    { query: 'pos 2', should_trigger: true, id: 'pos-2' },
    { query: 'pos 3', should_trigger: true, id: 'pos-3' },
    { query: 'pos 4', should_trigger: true, id: 'pos-4' },
    { query: 'neg 1', should_trigger: false, id: 'neg-1' },
    { query: 'neg 2', should_trigger: false, id: 'neg-2' },
    { query: 'neg 3', should_trigger: false, id: 'neg-3' },
    { query: 'neg 4', should_trigger: false, id: 'neg-4' },
  ];
}

/** Canned reply formatter in TRIGGER/REASON/NEXT_STEP shape. */
function cannedReply(triggerYes: boolean): string {
  return [`TRIGGER: ${triggerYes ? 'yes' : 'no'}`, 'REASON: stub.', 'NEXT_STEP: stub action.', ''].join('\n');
}

/**
 * Construct an OptimizerHooks pair that:
 *   - records every eval-driver invocation (prompt + result paths),
 *   - returns a caller-controlled TRIGGER verdict based on the prompt
 *     contents + current iteration counter,
 *   - records every improver-driver invocation,
 *   - returns a caller-controlled canned <new_description> response.
 */
interface HooksRecorder {
  evalCalls: { prompt: string; resultFile: string }[];
  improverCalls: { prompt: string; outputFile: string }[];
  iteration: number;
}

function makeHooks(opts: {
  triggerYesFor: (prompt: string, iteration: number) => boolean;
  improverResponse: (prompt: string, iteration: number, callCount: number) => string;
  onIterationAdvance?: () => void;
}): { hooks: OptimizerHooks; rec: HooksRecorder } {
  const rec: HooksRecorder = { evalCalls: [], improverCalls: [], iteration: 1 };
  let improverCallsThisIter = 0;
  const hooks: OptimizerHooks = {
    runEvalDriver(promptFile, resultFile) {
      const prompt = readFileSync(promptFile, 'utf8');
      rec.evalCalls.push({ prompt, resultFile });
      const yes = opts.triggerYesFor(prompt, rec.iteration);
      writeFileSync(resultFile, cannedReply(yes));
      return Promise.resolve();
    },
    runImproverDriver(promptFile, outputFile) {
      const prompt = readFileSync(promptFile, 'utf8');
      improverCallsThisIter += 1;
      rec.improverCalls.push({ prompt, outputFile });
      const body = opts.improverResponse(prompt, rec.iteration, improverCallsThisIter);
      writeFileSync(outputFile, body);
      // Each improver turn completes one iteration; advance the counter
      // when a shorten-prompt is NOT in flight (i.e. first call of the
      // pair). That way `triggerYesFor` sees a fresh iteration on the
      // next eval pass.
      if (!prompt.includes('over the 1024-character hard limit')) {
        rec.iteration += 1;
        improverCallsThisIter = 0;
        opts.onIterationAdvance?.();
      }
      return Promise.resolve();
    },
  };
  return { hooks, rec };
}

describe('runOptimizeLoop', () => {
  test('exits early with all_passed when every train query triggers correctly', async () => {
    const parsed = parseSkillMdText('SKILL.md', SAMPLE_SKILL);
    const workspace = freshDir();
    // Trigger "yes" on positives ("pos" in the scenario) and "no" on negatives.
    const { hooks, rec } = makeHooks({
      triggerYesFor: (prompt) => prompt.includes('Scenario: pos '),
      improverResponse: () => '<new_description>ignored - loop should exit early</new_description>',
    });
    const res = await runOptimizeLoop({
      parsed,
      skillName: 'sample',
      evalSet: triggerEvalSet(),
      workspace,
      holdout: 0.4,
      maxIterations: 3,
      runsPerQuery: 1,
      triggerThreshold: 0.5,
      numWorkers: 1,
      hooks,
    });

    expect(res.exitReason).toBe('all_passed');
    expect(res.iterations).toHaveLength(1);
    expect(res.iterations[0].trainPassed).toBe(res.iterations[0].trainTotal);
    // No improver call when the first iteration already passes.
    expect(rec.improverCalls).toHaveLength(0);
  });

  test('picks the best iteration by train score with earliest-iteration tiebreak', async () => {
    const parsed = parseSkillMdText('SKILL.md', SAMPLE_SKILL);
    const workspace = freshDir();
    // holdout=0 so train covers the whole eval set and we can craft a
    // failure-curve per iteration without worrying about which items
    // landed in test. Iteration 1: two failures (neg-1 + neg-2 trigger).
    // Iteration 2: one failure (neg-1 still triggers). Iteration 3: two
    // failures again (regression). Best should be iteration 2.
    const { hooks } = makeHooks({
      triggerYesFor: (prompt, iteration) => {
        const isPos = prompt.includes('Scenario: pos ');
        if (iteration === 1) {
          if (/Scenario: neg 1\b/.test(prompt)) return true;
          if (/Scenario: neg 2\b/.test(prompt)) return true;
          return isPos;
        }
        if (iteration === 2) {
          if (/Scenario: neg 1\b/.test(prompt)) return true;
          return isPos;
        }
        // iteration 3: regression - two false triggers.
        if (/Scenario: neg 1\b/.test(prompt)) return true;
        if (/Scenario: neg 3\b/.test(prompt)) return true;
        return isPos;
      },
      improverResponse: (_prompt, iteration) =>
        `<new_description>candidate for iter ${iteration + 1}</new_description>`,
    });
    const res = await runOptimizeLoop({
      parsed,
      skillName: 'sample',
      evalSet: triggerEvalSet(),
      workspace,
      holdout: 0,
      maxIterations: 3,
      runsPerQuery: 1,
      triggerThreshold: 0.5,
      numWorkers: 1,
      hooks,
    });

    expect(res.iterations).toHaveLength(3);
    expect(res.bestSource).toBe('train');
    expect(res.iterations.map((it) => `${it.trainPassed}/${it.trainTotal}`)).toStrictEqual(['6/8', '7/8', '6/8']);
    expect(res.bestIteration).toBe(2);
    expect(res.iterations[1].description).toBe('candidate for iter 2');
    expect(res.bestDescription).toBe('candidate for iter 2');
  });

  test('respects --max-iterations when no iteration is perfect', async () => {
    const parsed = parseSkillMdText('SKILL.md', SAMPLE_SKILL);
    const workspace = freshDir();
    const { hooks } = makeHooks({
      triggerYesFor: () => true, // fails every negative every iteration
      improverResponse: () => '<new_description>still imperfect</new_description>',
    });
    const res = await runOptimizeLoop({
      parsed,
      skillName: 'sample',
      evalSet: triggerEvalSet(),
      workspace,
      holdout: 0.4,
      maxIterations: 2,
      runsPerQuery: 1,
      triggerThreshold: 0.5,
      numWorkers: 1,
      hooks,
    });

    expect(res.exitReason).toBe('max_iterations');
    expect(res.iterations).toHaveLength(2);
  });

  test('fires the 1024-char shortener when the first improver response blows the limit', async () => {
    const parsed = parseSkillMdText('SKILL.md', SAMPLE_SKILL);
    const workspace = freshDir();
    const overLong = 'x'.repeat(1100);
    const short = 'crisp description';
    let improverCalls = 0;
    const hooks: OptimizerHooks = {
      runEvalDriver(_promptFile, resultFile) {
        // Every query returns TRIGGER=no - all positives in the eval set
        // fail, guaranteeing the improver runs.
        writeFileSync(resultFile, cannedReply(false));
        return Promise.resolve();
      },
      runImproverDriver(promptFile, outputFile) {
        const prompt = readFileSync(promptFile, 'utf8');
        improverCalls += 1;
        const shortening = prompt.includes('over the 1024-character hard limit');
        writeFileSync(
          outputFile,
          shortening ? `<new_description>${short}</new_description>` : `<new_description>${overLong}</new_description>`,
        );
        return Promise.resolve();
      },
    };
    const res = await runOptimizeLoop({
      parsed,
      skillName: 'sample',
      evalSet: triggerEvalSet(),
      workspace,
      holdout: 0,
      maxIterations: 2,
      runsPerQuery: 1,
      triggerThreshold: 0.5,
      numWorkers: 1,
      hooks,
    });

    // Two improver calls on iteration-1: one primary, one shortener.
    expect(improverCalls).toBe(2);
    expect(res.iterations[0].improverOverLong).toBe(true);
    // Iteration 2's description should be the short candidate.
    expect(res.iterations[1].description).toBe(short);
  });

  test('blinds test_* keys out of the history passed to the improver', async () => {
    const parsed = parseSkillMdText('SKILL.md', SAMPLE_SKILL);
    const workspace = freshDir();
    let capturedImproverPrompt = '';
    const hooks: OptimizerHooks = {
      runEvalDriver(_promptFile, resultFile) {
        // Every query returns TRIGGER=no - positives fail, so the
        // improver runs each iteration.
        writeFileSync(resultFile, cannedReply(false));
        return Promise.resolve();
      },
      runImproverDriver(promptFile, outputFile) {
        const prompt = readFileSync(promptFile, 'utf8');
        // Capture the SECOND iteration's improver prompt, which is the
        // first time history is non-empty.
        if (prompt.includes('PREVIOUS ATTEMPTS')) capturedImproverPrompt = prompt;
        writeFileSync(outputFile, '<new_description>next try</new_description>');
        return Promise.resolve();
      },
    };
    const res = await runOptimizeLoop({
      parsed,
      skillName: 'sample',
      evalSet: triggerEvalSet(),
      workspace,
      // holdout > 0 so the iteration records DO have test_* fields that
      // the blinding logic must strip before feeding to the improver.
      holdout: 0.4,
      maxIterations: 3,
      runsPerQuery: 1,
      triggerThreshold: 0.5,
      numWorkers: 1,
      hooks,
    });

    expect(res.iterations.length).toBeGreaterThanOrEqual(2);
    // Sanity: the captured iterations actually recorded non-null test
    // scores - otherwise the blinding assertions would be vacuous.
    expect(res.iterations[0].testTotal).not.toBeNull();
    // The improver prompt for iteration 2 should name train_passed but
    // never mention test_passed / test_total / test_results.
    expect(capturedImproverPrompt).not.toMatch(/test_passed/);
    expect(capturedImproverPrompt).not.toMatch(/test_total/);
    expect(capturedImproverPrompt).not.toMatch(/test_results/);
    expect(capturedImproverPrompt).toMatch(/train=/);
  });

  test('writes the iteration-N workspace layout and improver logs', async () => {
    const parsed = parseSkillMdText('SKILL.md', SAMPLE_SKILL);
    const workspace = freshDir();
    const { hooks } = makeHooks({
      triggerYesFor: () => false, // train fails → improver runs each iter
      improverResponse: () => '<new_description>candidate</new_description>',
    });
    const res = await runOptimizeLoop({
      parsed,
      skillName: 'sample',
      evalSet: triggerEvalSet(),
      workspace,
      holdout: 0.4,
      maxIterations: 2,
      runsPerQuery: 1,
      triggerThreshold: 0.5,
      numWorkers: 1,
      hooks,
    });

    expect(existsSync(join(workspace, 'sample', 'iteration-1'))).toBe(true);
    expect(existsSync(join(workspace, 'sample', 'iteration-1', 'with_skill', 'prompts', 'pos-1.txt'))).toBe(true);
    expect(existsSync(join(workspace, 'sample', 'iteration-1', 'with_skill', 'results', 'pos-1', 'run-1.txt'))).toBe(
      true,
    );
    expect(existsSync(join(workspace, 'sample', 'iteration-1', 'with_skill', 'grades', 'pos-1.json'))).toBe(true);
    // Improver logs for iteration-1 (there will be an iteration-2 too
    // since max_iterations=2, and the FINAL iteration skips the improver
    // call because the loop breaks right after grading).
    expect(existsSync(join(workspace, 'sample', 'iteration-1', 'optimize', 'improver', 'prompt.txt'))).toBe(true);
    expect(existsSync(join(workspace, 'sample', 'iteration-1', 'optimize', 'improver', 'response.txt'))).toBe(true);
    expect(existsSync(join(workspace, 'sample', 'iteration-1', 'optimize', 'improver', 'parsed.json'))).toBe(true);
    expect(res.iterations).toHaveLength(2);
  });
});

describe('loadTriggerEvalSet', () => {
  test('parses the flat shape', () => {
    const src = JSON.stringify([
      { query: 'pos q', should_trigger: true },
      { query: 'neg q', should_trigger: false, id: 'custom-id' },
    ]);
    const out = loadTriggerEvalSet(src, 'inline');

    expect(out).toStrictEqual([
      { query: 'pos q', should_trigger: true, id: undefined },
      { query: 'neg q', should_trigger: false, id: 'custom-id' },
    ]);
  });

  test('projects evals.json {evals: [...]} to the trigger shape', () => {
    const src = JSON.stringify({
      skill_name: 'x',
      evals: [
        { id: 'p-1', prompt: 'do a thing', should_trigger: true, expectations: ['ignored'] },
        { id: 'n-1', prompt: 'unrelated', should_trigger: false, expectations: ['ignored'] },
      ],
    });
    const out = loadTriggerEvalSet(src, 'evals.json');

    expect(out).toStrictEqual([
      { query: 'do a thing', should_trigger: true, id: 'p-1' },
      { query: 'unrelated', should_trigger: false, id: 'n-1' },
    ]);
  });

  test('rejects malformed input', () => {
    expect(() => loadTriggerEvalSet('null', 'src')).toThrowError();
    expect(() => loadTriggerEvalSet(JSON.stringify([{ query: 1, should_trigger: true }]), 'src')).toThrowError();
  });
});

describe('appendDescriptionHistory', () => {
  const baseEntry = (overrides: Partial<DescriptionHistoryEntry> = {}): DescriptionHistoryEntry => ({
    timestamp: '2026-01-01T00:00:00.000Z',
    description: 'old value',
    source: 'replaced',
    iteration: 2,
    score: '6/8',
    ...overrides,
  });

  test('creates a fresh single-element file when history does not exist', () => {
    const path = join(freshDir('history-'), 'description-history.json');
    const out = appendDescriptionHistory(path, baseEntry());

    expect(out).toHaveLength(1);

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as DescriptionHistoryEntry[];

    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].description).toBe('old value');
  });

  test('appends to an existing history file preserving prior entries', () => {
    const path = join(freshDir('history-'), 'description-history.json');
    writeFileSync(
      path,
      JSON.stringify(
        [baseEntry({ iteration: 1, description: 'first', timestamp: '2025-06-01T00:00:00.000Z' })],
        null,
        2,
      ),
    );
    const out = appendDescriptionHistory(path, baseEntry({ iteration: 2, description: 'second' }));

    expect(out).toHaveLength(2);
    expect(out[0].description).toBe('first');
    expect(out[1].description).toBe('second');
  });

  test('recovers from a corrupt history file by starting fresh', () => {
    const path = join(freshDir('history-'), 'description-history.json');
    writeFileSync(path, '{ not valid json ');
    const out = appendDescriptionHistory(path, baseEntry());

    expect(out).toHaveLength(1);
  });
});
