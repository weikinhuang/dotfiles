// Tests for lib/node/ai-skill-eval/grader.ts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { gradeDeterministic, keywordsFor, parseReply } from '../../../../lib/node/ai-skill-eval/grader.ts';
import { type GradeRecord } from '../../../../lib/node/ai-skill-eval/types.ts';

describe('parseReply', () => {
  test('extracts the three labeled fields', () => {
    const text = [
      'TRIGGER: yes',
      'REASON: because the scenario names a phase file.',
      'NEXT_STEP: open dotenv/aliases.sh and add the alias.',
    ].join('\n');

    expect(parseReply(text)).toEqual({
      trigger: 'yes',
      reason: 'because the scenario names a phase file.',
      next_step: 'open dotenv/aliases.sh and add the alias.',
    });
  });

  test('appends unlabeled continuation lines to the current field', () => {
    const text = [
      'TRIGGER: yes',
      'REASON: first line',
      'continuation of reason',
      'NEXT_STEP: step one',
      'step two',
    ].join('\n');

    expect(parseReply(text)).toEqual({
      trigger: 'yes',
      reason: 'first line continuation of reason',
      next_step: 'step one step two',
    });
  });

  test('returns empty fields when labels are missing', () => {
    expect(parseReply('just prose with no labels')).toEqual({
      trigger: '',
      reason: '',
      next_step: '',
    });
  });
});

describe('keywordsFor', () => {
  test('picks up backtick-quoted terms', () => {
    expect(keywordsFor('Use `./dev/lint.sh` and `shellcheck`')).toEqual(
      expect.arrayContaining(['./dev/lint.sh', 'shellcheck']),
    );
  });

  test('picks up path-like tokens', () => {
    expect(keywordsFor('Place the file under dotenv/aliases.sh')).toEqual(
      expect.arrayContaining(['dotenv/aliases.sh']),
    );
  });

  test('picks up filenames with known extensions', () => {
    const kws = keywordsFor('Add coverage in tests/config.bats');

    expect(kws).toEqual(expect.arrayContaining(['tests/config.bats']));
  });

  test('picks up curated command names case-insensitively', () => {
    const kws = keywordsFor('Run SHELLCHECK and vitest before landing');

    expect(kws).toEqual(expect.arrayContaining(['shellcheck', 'vitest']));
  });

  test('deduplicates and caps at four keywords', () => {
    const kws = keywordsFor('`a` `b` `c` `d` `e` `f`');

    expect(kws).toHaveLength(4);
  });

  test('returns an empty array when no keywords match', () => {
    expect(keywordsFor('Generic prose without landmarks')).toEqual([]);
  });
});

describe('gradeDeterministic', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ai-skill-eval-grader-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeResult = (body: string): string => {
    const file = join(tmp, 'result.txt');
    writeFileSync(file, body);
    return file;
  };

  const runGrade = (resultBody: string, expectations: string[], shouldTrigger = true): GradeRecord => {
    const resultFile = writeResult(resultBody);
    const gradeFile = join(tmp, 'grades', 'g.json');
    mkdirSync(join(tmp, 'grades'), { recursive: true });
    return gradeDeterministic({
      skill: 'sample',
      evalId: 'positive-1',
      shouldTrigger,
      expectations,
      resultFile,
      gradeFile,
    });
  };

  test('marks trigger_pass true when yes matches should_trigger', () => {
    const grade = runGrade('TRIGGER: yes\nREASON: because x\nNEXT_STEP: do y', ['Do `y` in `./dev/lint.sh`'], true);

    expect(grade.trigger_pass).toBe(true);
  });

  test('marks trigger_pass false when model disagrees with should_trigger', () => {
    const grade = runGrade('TRIGGER: no\nREASON: unrelated\nNEXT_STEP: ignore', ['expectation'], true);

    expect(grade.trigger_pass).toBe(false);
  });

  test('no-specific-keywords expectation fails with explanatory note', () => {
    const grade = runGrade('TRIGGER: yes\nREASON: because\nNEXT_STEP: step', ['Generic expectation with no landmarks']);

    expect(grade.expectations[0]?.passed).toBe(false);
    expect(grade.expectations[0]?.note).toBe('no-specific-keywords');
  });

  test('expectation passes when enough keywords appear in reason+next_step', () => {
    const grade = runGrade(
      'TRIGGER: yes\nREASON: invoke ./dev/lint.sh first\nNEXT_STEP: run shellcheck and shfmt before commit',
      ['Run `shellcheck` and `shfmt` via `./dev/lint.sh`'],
    );

    expect(grade.expectations[0]?.passed).toBe(true);
    expect(grade.expectations[0]?.note).toMatch(/matched \d+\/\d+ keywords/);
  });

  test('expectation fails when too few keywords match', () => {
    const grade = runGrade('TRIGGER: yes\nREASON: talk about nothing\nNEXT_STEP: stare at screen', [
      'Run `shellcheck` and `shfmt` via `./dev/lint.sh`',
    ]);

    expect(grade.expectations[0]?.passed).toBe(false);
  });

  test('writes a parseable JSON grade file to disk', () => {
    const resultFile = writeResult('TRIGGER: yes\nREASON: r\nNEXT_STEP: s');
    const gradeFile = join(tmp, 'out', 'g.json');
    gradeDeterministic({
      skill: 'sample',
      evalId: 'positive-1',
      shouldTrigger: true,
      expectations: ['one'],
      resultFile,
      gradeFile,
    });
    const parsed = JSON.parse(readFileSync(gradeFile, 'utf8')) as GradeRecord;

    expect(parsed.skill).toBe('sample');
    expect(parsed.eval_id).toBe('positive-1');
    expect(parsed.grader).toBe('deterministic');
  });

  test('trigger parsing is lower-cased and yes-prefixed', () => {
    expect(runGrade('TRIGGER: YES!\nREASON: r\nNEXT_STEP: s', ['x'], true).trigger_pass).toBe(true);
    expect(runGrade('TRIGGER: No.\nREASON: r\nNEXT_STEP: s', ['x'], false).trigger_pass).toBe(true);
  });
});
