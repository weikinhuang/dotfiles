// Tests for lib/node/ai-skill-eval/critic.ts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildCriticPrompt, mergeCriticVerdict, writeCriticPrompt } from '../../../../lib/node/ai-skill-eval/critic.ts';
import { type GradeRecord } from '../../../../lib/node/ai-skill-eval/types.ts';

describe('buildCriticPrompt', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ai-skill-eval-critic-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('includes skill, eval metadata, and the model reply verbatim', () => {
    const resultFile = join(tmp, 'result.txt');
    writeFileSync(resultFile, 'TRIGGER: yes\nREASON: because\nNEXT_STEP: do it\n');

    const prompt = buildCriticPrompt({
      skill: 'sample',
      evalId: 'positive-1',
      shouldTrigger: true,
      expectations: ['first', 'second'],
      resultFile,
    });

    expect(prompt).toContain('Skill: sample');
    expect(prompt).toContain('Eval:  positive-1  (should_trigger=true)');
    expect(prompt).toContain('1. first');
    expect(prompt).toContain('2. second');
    expect(prompt).toContain('TRIGGER: yes');
    expect(prompt).toContain('STRICT JSON');
  });

  test('writeCriticPrompt creates parents and writes the prompt', () => {
    const out = join(tmp, 'a', 'b', 'prompt.txt');
    writeCriticPrompt(out, 'hello');

    expect(readFileSync(out, 'utf8')).toBe('hello');
  });
});

describe('mergeCriticVerdict', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ai-skill-eval-critic-merge-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seedGrade = (partial: Partial<GradeRecord> = {}): string => {
    const file = join(tmp, 'g.json');
    mkdirSync(tmp, { recursive: true });
    const base: GradeRecord = {
      skill: 'sample',
      eval_id: 'positive-1',
      config: 'with_skill',
      should_trigger: true,
      runs: 1,
      triggers: 1,
      trigger_rate: 1,
      trigger_pass: true,
      per_run: [{ trigger: 'yes', reason: 'r', next_step: 's' }],
      expectations: [
        { text: 'first', passed: false, note: 'deterministic miss' },
        { text: 'second', passed: false, note: 'deterministic miss' },
      ],
      expectation_pass: 0,
      expectation_total: 2,
      grader: 'deterministic',
      ...partial,
    };
    writeFileSync(file, JSON.stringify(base));
    return file;
  };

  test('overrides per-expectation passed + note when the critic emits JSON', () => {
    const gradeFile = seedGrade();
    const raw = `some prose before ${JSON.stringify({
      expectations: [
        { text: 'first', passed: true, evidence: 'critic says first ok' },
        { text: 'second', passed: false, evidence: 'still missing' },
      ],
      flaws: ['skill is wordy'],
    })} and trailing prose`;

    mergeCriticVerdict(raw, gradeFile);
    const out = JSON.parse(readFileSync(gradeFile, 'utf8')) as GradeRecord;

    expect(out.grader).toBe('critic');
    expect(out.expectations[0]?.passed).toBe(true);
    expect(out.expectations[0]?.note).toBe('critic: critic says first ok');
    expect(out.expectations[1]?.passed).toBe(false);
    expect(out.expectation_pass).toBe(1);
    expect(out.flaws).toEqual(['skill is wordy']);
  });

  test('throws when the critic output contains no JSON object', () => {
    const gradeFile = seedGrade();

    expect(() => mergeCriticVerdict('no braces here', gradeFile)).toThrow(
      'critic output did not contain a JSON object',
    );
  });

  test('leaves extra grade expectations alone when critic returns fewer', () => {
    const gradeFile = seedGrade();
    const raw = JSON.stringify({
      expectations: [{ text: 'first', passed: true, evidence: 'ok' }],
    });

    mergeCriticVerdict(raw, gradeFile);
    const out = JSON.parse(readFileSync(gradeFile, 'utf8')) as GradeRecord;

    expect(out.expectations[0]?.passed).toBe(true);
    expect(out.expectations[1]?.passed).toBe(false);
    expect(out.expectations[1]?.note).toBe('deterministic miss');
  });
});
