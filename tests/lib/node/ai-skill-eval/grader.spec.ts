// Tests for lib/node/ai-skill-eval/grader.ts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  gradeDeterministic,
  isTrigger,
  keywordsFor,
  parseReply,
  pickMajorityRunIndex,
  roundTriggerRate,
} from '../../../../lib/node/ai-skill-eval/grader.ts';
import { type GradeRecord, type ParsedReply } from '../../../../lib/node/ai-skill-eval/types.ts';

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

describe('isTrigger', () => {
  test('true when the trigger field starts with "yes" (any case)', () => {
    expect(isTrigger({ trigger: 'yes', reason: '', next_step: '' })).toBe(true);
    expect(isTrigger({ trigger: 'YES!', reason: '', next_step: '' })).toBe(true);
    expect(isTrigger({ trigger: 'Yes, because…', reason: '', next_step: '' })).toBe(true);
  });

  test('false for no, empty, or anything-else trigger values', () => {
    expect(isTrigger({ trigger: 'no', reason: '', next_step: '' })).toBe(false);
    expect(isTrigger({ trigger: '', reason: '', next_step: '' })).toBe(false);
    expect(isTrigger({ trigger: 'maybe', reason: '', next_step: '' })).toBe(false);
  });
});

describe('roundTriggerRate', () => {
  test('rounds 2/3 to 0.67', () => {
    expect(roundTriggerRate(2 / 3)).toBe(0.67);
  });

  test('leaves exact values alone', () => {
    expect(roundTriggerRate(0.5)).toBe(0.5);
    expect(roundTriggerRate(1)).toBe(1);
    expect(roundTriggerRate(0)).toBe(0);
  });
});

describe('pickMajorityRunIndex', () => {
  const mk = (trigger: string): ParsedReply => ({ trigger, reason: '', next_step: '' });

  test('picks the first yes when yes is the majority', () => {
    expect(pickMajorityRunIndex([mk('no'), mk('yes'), mk('yes')])).toBe(1);
  });

  test('picks the first no when no is the majority', () => {
    expect(pickMajorityRunIndex([mk('yes'), mk('no'), mk('no')])).toBe(1);
  });

  test('returns 0 on a tie', () => {
    expect(pickMajorityRunIndex([mk('yes'), mk('no')])).toBe(0);
    expect(pickMajorityRunIndex([mk('no'), mk('yes')])).toBe(0);
  });

  test('returns 0 when no runs are provided', () => {
    expect(pickMajorityRunIndex([])).toBe(0);
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

  const writeRun = (i: number, body: string): string => {
    const file = join(tmp, `run-${i}.txt`);
    writeFileSync(file, body);
    return file;
  };

  const runGrade = (
    resultBodies: readonly string[],
    expectations: string[],
    shouldTrigger = true,
    triggerThreshold = 0.5,
  ): GradeRecord => {
    const resultFiles = resultBodies.map((body, i) => writeRun(i + 1, body));
    const gradeFile = join(tmp, 'grades', 'g.json');
    mkdirSync(join(tmp, 'grades'), { recursive: true });
    return gradeDeterministic({
      skill: 'sample',
      evalId: 'positive-1',
      shouldTrigger,
      expectations,
      resultFiles,
      gradeFile,
      triggerThreshold,
    });
  };

  test('aggregates 2 yes + 1 no into trigger_rate 0.67 and trigger_pass=true at threshold 0.5', () => {
    const grade = runGrade(
      [
        'TRIGGER: yes\nREASON: because x\nNEXT_STEP: do y',
        'TRIGGER: yes\nREASON: also yes\nNEXT_STEP: do y',
        'TRIGGER: no\nREASON: one run disagrees\nNEXT_STEP: skip',
      ],
      ['Do `y` in `./dev/lint.sh`'],
      true,
      0.5,
    );

    expect(grade.runs).toBe(3);
    expect(grade.triggers).toBe(2);
    expect(grade.trigger_rate).toBe(0.67);
    expect(grade.trigger_pass).toBe(true);
    expect(grade.per_run).toHaveLength(3);
    expect(grade.per_run[2]?.trigger).toBe('no');
  });

  test('trigger_pass=false when should_trigger=true but trigger_rate below threshold', () => {
    const grade = runGrade(
      [
        'TRIGGER: no\nREASON: r\nNEXT_STEP: s',
        'TRIGGER: no\nREASON: r\nNEXT_STEP: s',
        'TRIGGER: yes\nREASON: r\nNEXT_STEP: s',
      ],
      ['x'],
      true,
      0.5,
    );

    expect(grade.trigger_rate).toBe(0.33);
    expect(grade.trigger_pass).toBe(false);
  });

  test('should_trigger=false passes only when trigger_rate is strictly below threshold', () => {
    const below = runGrade(
      ['TRIGGER: no\nREASON: r\nNEXT_STEP: s', 'TRIGGER: no\nREASON: r\nNEXT_STEP: s'],
      ['x'],
      false,
      0.5,
    );

    expect(below.trigger_rate).toBe(0);
    expect(below.trigger_pass).toBe(true);

    const tied = runGrade(
      ['TRIGGER: yes\nREASON: r\nNEXT_STEP: s', 'TRIGGER: no\nREASON: r\nNEXT_STEP: s'],
      ['x'],
      false,
      0.5,
    );

    expect(tied.trigger_rate).toBe(0.5);
    expect(tied.trigger_pass).toBe(false);
  });

  test('expectations are scored against the majority-trigger run', () => {
    const grade = runGrade(
      [
        'TRIGGER: no\nREASON: unrelated prose\nNEXT_STEP: unrelated',
        'TRIGGER: yes\nREASON: invoke ./dev/lint.sh first\nNEXT_STEP: run shellcheck and shfmt before commit',
        'TRIGGER: yes\nREASON: ./dev/lint.sh again\nNEXT_STEP: run shellcheck and shfmt',
      ],
      ['Run `shellcheck` and `shfmt` via `./dev/lint.sh`'],
      true,
    );

    expect(grade.expectations[0]?.passed).toBe(true);
    expect(grade.expectations[0]?.note).toMatch(/matched \d+\/\d+ keywords/);
  });

  test('no-specific-keywords expectation fails with explanatory note', () => {
    const grade = runGrade(
      ['TRIGGER: yes\nREASON: because\nNEXT_STEP: step'],
      ['Generic expectation with no landmarks'],
    );

    expect(grade.expectations[0]?.passed).toBe(false);
    expect(grade.expectations[0]?.note).toBe('no-specific-keywords');
  });

  test('writes the aggregated JSON grade file to disk', () => {
    const resultFiles = [
      writeRun(1, 'TRIGGER: yes\nREASON: r\nNEXT_STEP: s'),
      writeRun(2, 'TRIGGER: yes\nREASON: r\nNEXT_STEP: s'),
    ];
    const gradeFile = join(tmp, 'out', 'g.json');
    gradeDeterministic({
      skill: 'sample',
      evalId: 'positive-1',
      shouldTrigger: true,
      expectations: ['one'],
      resultFiles,
      gradeFile,
    });
    const parsed = JSON.parse(readFileSync(gradeFile, 'utf8')) as GradeRecord;

    expect(parsed.skill).toBe('sample');
    expect(parsed.eval_id).toBe('positive-1');
    expect(parsed.runs).toBe(2);
    expect(parsed.triggers).toBe(2);
    expect(parsed.trigger_rate).toBe(1);
    expect(parsed.grader).toBe('deterministic');
    expect(parsed.per_run).toHaveLength(2);
  });

  test('throws when given zero result files', () => {
    expect(() =>
      gradeDeterministic({
        skill: 'sample',
        evalId: 'positive-1',
        shouldTrigger: true,
        expectations: ['x'],
        resultFiles: [],
        gradeFile: join(tmp, 'g.json'),
      }),
    ).toThrow(/no result files/);
  });
});
