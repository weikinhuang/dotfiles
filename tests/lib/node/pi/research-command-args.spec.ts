/**
 * Tests for lib/node/pi/research-command-args.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  formatOverridesSummary,
  parseMaxTurns,
  parseModelSpec,
  parseParallel,
  parseResearchCommandArgs,
  parseWallClockSec,
  type ResearchCommandArgs,
  type ResumeStage,
  validateToolOverrides,
} from '../../../../lib/node/pi/research-command-args.ts';

/** Narrow + extract the `error` string; throws when the result was not an error. */
function expectModelError(r: ReturnType<typeof parseModelSpec>): string {
  if (!('error' in r)) throw new Error('expected parseModelSpec to return an error');
  return r.error;
}

function expectMaxTurnsError(r: ReturnType<typeof parseMaxTurns>): string {
  if (typeof r === 'number') throw new Error('expected parseMaxTurns to return an error');
  return r.error;
}

function expectParallelError(r: ReturnType<typeof parseParallel>): string {
  if (typeof r === 'number') throw new Error('expected parseParallel to return an error');
  return r.error;
}

function expectWallClockError(r: ReturnType<typeof parseWallClockSec>): string {
  if (typeof r === 'number') throw new Error('expected parseWallClockSec to return an error');
  return r.error;
}

function expectCmdError(r: ResearchCommandArgs): string {
  if (r.kind !== 'error') throw new Error(`expected parseResearchCommandArgs 'error', got '${r.kind}'`);
  return r.error;
}

function expectCmdResume(r: ResearchCommandArgs): Extract<ResearchCommandArgs, { kind: 'resume' }> {
  if (r.kind !== 'resume') throw new Error(`expected parseResearchCommandArgs 'resume', got '${r.kind}'`);
  return r;
}

function expectCmdQuestion(r: ResearchCommandArgs): Extract<ResearchCommandArgs, { kind: 'question' }> {
  if (r.kind !== 'question') throw new Error(`expected parseResearchCommandArgs 'question', got '${r.kind}'`);
  return r;
}

function expectValidatedOk(
  r: ReturnType<typeof validateToolOverrides>,
): Extract<ReturnType<typeof validateToolOverrides>, { ok: true }> {
  if (!r.ok) throw new Error(`expected validateToolOverrides ok, got error: ${r.error}`);
  return r;
}

function expectValidatedErr(
  r: ReturnType<typeof validateToolOverrides>,
): Extract<ReturnType<typeof validateToolOverrides>, { ok: false }> {
  if (r.ok) throw new Error(`expected validateToolOverrides error, got ok`);
  return r;
}

describe('parseModelSpec', () => {
  test('accepts provider/id', () => {
    expect(parseModelSpec('openai/gpt-5')).toEqual({ provider: 'openai', modelId: 'gpt-5' });
    expect(parseModelSpec('anthropic/claude-3-5-sonnet-latest')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-3-5-sonnet-latest',
    });
  });

  test('rejects missing slash', () => {
    expect(expectModelError(parseModelSpec('openai'))).toMatch(/expected "provider\/id"/);
  });

  test('rejects leading / trailing slash', () => {
    expect(parseModelSpec('/gpt-5')).toHaveProperty('error');
    expect(parseModelSpec('openai/')).toHaveProperty('error');
  });

  test('rejects empty string', () => {
    expect(expectModelError(parseModelSpec(''))).toMatch(/non-empty/);
  });
});

describe('parseMaxTurns', () => {
  test('accepts positive integers', () => {
    expect(parseMaxTurns('--fanout-max-turns', '1')).toBe(1);
    expect(parseMaxTurns('--fanout-max-turns', '40')).toBe(40);
    expect(parseMaxTurns('--critic-max-turns', '1000')).toBe(1000);
  });

  test('rejects zero, negative, decimals, non-numeric', () => {
    expect(parseMaxTurns('--fanout-max-turns', '0')).toHaveProperty('error');
    expect(parseMaxTurns('--fanout-max-turns', '-1')).toHaveProperty('error');
    expect(parseMaxTurns('--fanout-max-turns', '3.14')).toHaveProperty('error');
    expect(parseMaxTurns('--fanout-max-turns', 'abc')).toHaveProperty('error');
    expect(parseMaxTurns('--fanout-max-turns', '')).toHaveProperty('error');
  });

  test('rejects values above the 1000 cap', () => {
    expect(expectMaxTurnsError(parseMaxTurns('--fanout-max-turns', '9999'))).toMatch(/absurd/);
  });
});

describe('parseResearchCommandArgs subcommand dispatch', () => {
  test('empty / whitespace → help', () => {
    expect(parseResearchCommandArgs('')).toEqual({ kind: 'help' });
    expect(parseResearchCommandArgs('   ')).toEqual({ kind: 'help' });
    expect(parseResearchCommandArgs(undefined)).toEqual({ kind: 'help' });
  });

  test('--help / -h → help', () => {
    expect(parseResearchCommandArgs('--help')).toEqual({ kind: 'help' });
    expect(parseResearchCommandArgs('-h')).toEqual({ kind: 'help' });
    expect(parseResearchCommandArgs('--help extra garbage')).toEqual({
      kind: 'help',
      trailing: 'extra garbage',
    });
  });

  test('--list dispatches, trailing tokens preserved for diagnostics', () => {
    expect(parseResearchCommandArgs('--list')).toEqual({ kind: 'list' });
    expect(parseResearchCommandArgs('--list ignored')).toEqual({ kind: 'list', trailing: 'ignored' });
  });

  test('--selftest dispatches, trailing tokens preserved', () => {
    expect(parseResearchCommandArgs('--selftest')).toEqual({ kind: 'selftest' });
    expect(parseResearchCommandArgs('--selftest ignored words')).toEqual({
      kind: 'selftest',
      trailing: 'ignored words',
    });
  });
});

describe('parseResearchCommandArgs question mode', () => {
  test('plain question with no flags', () => {
    expect(parseResearchCommandArgs('what changed in React 19')).toEqual({
      kind: 'question',
      question: 'what changed in React 19',
      overrides: {},
    });
  });

  test('collapses internal whitespace', () => {
    expect(parseResearchCommandArgs('what   changed\tin  React 19')).toEqual({
      kind: 'question',
      question: 'what changed in React 19',
      overrides: {},
    });
  });

  test('--model flag (space form)', () => {
    expect(parseResearchCommandArgs('--model openai/gpt-5 what changed in React 19')).toEqual({
      kind: 'question',
      question: 'what changed in React 19',
      overrides: { model: 'openai/gpt-5' },
    });
  });

  test('--model flag (= form)', () => {
    expect(parseResearchCommandArgs('--model=openai/gpt-5 what changed in React 19')).toEqual({
      kind: 'question',
      question: 'what changed in React 19',
      overrides: { model: 'openai/gpt-5' },
    });
  });

  test('--fanout-max-turns + --critic-max-turns', () => {
    expect(parseResearchCommandArgs('--fanout-max-turns 40 --critic-max-turns 10 what changed in React 19')).toEqual({
      kind: 'question',
      question: 'what changed in React 19',
      overrides: { fanoutMaxTurns: 40, criticMaxTurns: 10 },
    });
  });

  test('per-agent model flags parse independently of --model', () => {
    expect(
      parseResearchCommandArgs(
        '--plan-crit-model openai/gpt-4.1 --fanout-model llama-cpp/qwen3 --critic-model anthropic/opus the question',
      ),
    ).toEqual({
      kind: 'question',
      question: 'the question',
      overrides: {
        planCritModel: 'openai/gpt-4.1',
        fanoutModel: 'llama-cpp/qwen3',
        criticModel: 'anthropic/opus',
      },
    });
  });

  test('--model coexists with per-agent model overrides', () => {
    expect(
      parseResearchCommandArgs('--model llama-cpp/qwen3 --critic-model anthropic/us.anthropic.claude-opus-4-7 topic'),
    ).toEqual({
      kind: 'question',
      question: 'topic',
      overrides: {
        model: 'llama-cpp/qwen3',
        criticModel: 'anthropic/us.anthropic.claude-opus-4-7',
      },
    });
  });

  test('duplicate per-agent model flag errors out', () => {
    expect(expectCmdError(parseResearchCommandArgs('--fanout-model openai/a --fanout-model openai/b q'))).toMatch(
      /--fanout-model may only be specified once/,
    );
  });

  test('invalid per-agent model spec errors out', () => {
    expect(parseResearchCommandArgs('--critic-model not-valid q').kind).toBe('error');
    expect(parseResearchCommandArgs('--plan-crit-model / q').kind).toBe('error');
  });

  test('all three flags, = form mixed with space form', () => {
    expect(
      parseResearchCommandArgs('--model=anthropic/claude-haiku --fanout-max-turns=40 --critic-max-turns 8 a question'),
    ).toEqual({
      kind: 'question',
      question: 'a question',
      overrides: { model: 'anthropic/claude-haiku', fanoutMaxTurns: 40, criticMaxTurns: 8 },
    });
  });

  test('flags after the first question token are preserved verbatim', () => {
    // A question containing `--` must not be eaten by the flag parser.
    expect(parseResearchCommandArgs('compare react -- react native')).toEqual({
      kind: 'question',
      question: 'compare react -- react native',
      overrides: {},
    });
    expect(parseResearchCommandArgs('--model openai/gpt-5 compare react -- react native')).toEqual({
      kind: 'question',
      question: 'compare react -- react native',
      overrides: { model: 'openai/gpt-5' },
    });
  });

  test('unknown flag errors out', () => {
    expect(expectCmdError(parseResearchCommandArgs('--frobnicate yes what is X'))).toMatch(/unknown flag --frobnicate/);
  });

  test('missing value errors out', () => {
    expect(expectCmdError(parseResearchCommandArgs('--model'))).toMatch(/--model requires a value/);
  });

  test('invalid model spec errors out', () => {
    const r = parseResearchCommandArgs('--model not-a-spec what is X');

    expect(r.kind).toBe('error');
  });

  test('invalid max-turns errors out', () => {
    expect(parseResearchCommandArgs('--fanout-max-turns abc q').kind).toBe('error');
    expect(parseResearchCommandArgs('--critic-max-turns 0 q').kind).toBe('error');
  });

  test('duplicate flag errors out', () => {
    expect(expectCmdError(parseResearchCommandArgs('--model openai/a --model openai/b q'))).toMatch(
      /--model may only be specified once/,
    );
  });

  test('flags without a question after them error out', () => {
    expect(expectCmdError(parseResearchCommandArgs('--model openai/gpt-5'))).toMatch(/no research question provided/);
  });
});

describe('validateToolOverrides', () => {
  test('empty input → no overrides', () => {
    expect(validateToolOverrides({})).toEqual({ ok: true, overrides: {} });
  });

  test('model validated via parseModelSpec', () => {
    expect(validateToolOverrides({ model: 'openai/gpt-5' })).toEqual({
      ok: true,
      overrides: { model: 'openai/gpt-5' },
    });
    expect(validateToolOverrides({ model: 'bogus' })).toMatchObject({ ok: false });
    expect(validateToolOverrides({ model: 42 })).toMatchObject({ ok: false });
  });

  test('per-agent model overrides validated independently', () => {
    expect(
      validateToolOverrides({
        planCritModel: 'openai/gpt-5',
        fanoutModel: 'llama-cpp/qwen3',
        criticModel: 'anthropic/us.anthropic.claude-opus-4-7',
      }),
    ).toEqual({
      ok: true,
      overrides: {
        planCritModel: 'openai/gpt-5',
        fanoutModel: 'llama-cpp/qwen3',
        criticModel: 'anthropic/us.anthropic.claude-opus-4-7',
      },
    });
  });

  test('invalid per-agent model value rejected', () => {
    expect(validateToolOverrides({ fanoutModel: 'no-slash' })).toMatchObject({ ok: false });
    expect(validateToolOverrides({ criticModel: 42 })).toMatchObject({ ok: false });
  });

  test('numeric overrides accept number and numeric string', () => {
    expect(validateToolOverrides({ fanoutMaxTurns: 40 })).toEqual({
      ok: true,
      overrides: { fanoutMaxTurns: 40 },
    });
    expect(validateToolOverrides({ fanoutMaxTurns: '40' })).toEqual({
      ok: true,
      overrides: { fanoutMaxTurns: 40 },
    });
    expect(validateToolOverrides({ criticMaxTurns: 8 })).toEqual({
      ok: true,
      overrides: { criticMaxTurns: 8 },
    });
  });

  test('floats truncated, out-of-range rejected', () => {
    expect(validateToolOverrides({ fanoutMaxTurns: 3.9 })).toEqual({
      ok: true,
      overrides: { fanoutMaxTurns: 3 },
    });
    expect(validateToolOverrides({ fanoutMaxTurns: -1 })).toMatchObject({ ok: false });
    expect(validateToolOverrides({ fanoutMaxTurns: 99999 })).toMatchObject({ ok: false });
  });

  test('non-numeric / non-string rejected for numeric fields', () => {
    expect(validateToolOverrides({ criticMaxTurns: 'abc' })).toMatchObject({ ok: false });
    expect(validateToolOverrides({ fanoutMaxTurns: null })).toMatchObject({ ok: false });
  });
});

describe('formatOverridesSummary', () => {
  test('returns empty string when nothing is set', () => {
    expect(formatOverridesSummary({})).toBe('');
  });

  test('includes every set field and omits the rest', () => {
    expect(formatOverridesSummary({ model: 'openai/gpt-5' })).toBe(' [model=openai/gpt-5]');
    expect(formatOverridesSummary({ fanoutMaxTurns: 40 })).toBe(' [fanout-max-turns=40]');
    expect(formatOverridesSummary({ criticMaxTurns: 8 })).toBe(' [critic-max-turns=8]');
    expect(formatOverridesSummary({ model: 'openai/gpt-5', fanoutMaxTurns: 40, criticMaxTurns: 8 })).toBe(
      ' [model=openai/gpt-5 fanout-max-turns=40 critic-max-turns=8]',
    );
  });

  test('includes per-agent model overrides with their labelled form', () => {
    expect(formatOverridesSummary({ planCritModel: 'openai/a' })).toBe(' [plan-crit-model=openai/a]');
    expect(formatOverridesSummary({ fanoutModel: 'openai/b' })).toBe(' [fanout-model=openai/b]');
    expect(formatOverridesSummary({ criticModel: 'openai/c' })).toBe(' [critic-model=openai/c]');
    expect(
      formatOverridesSummary({
        model: 'openai/top',
        planCritModel: 'openai/a',
        fanoutModel: 'openai/b',
        criticModel: 'openai/c',
        fanoutMaxTurns: 5,
        criticMaxTurns: 6,
      }),
    ).toBe(
      ' [model=openai/top plan-crit-model=openai/a fanout-model=openai/b critic-model=openai/c fanout-max-turns=5 critic-max-turns=6]',
    );
  });
});

describe('parseResearchCommandArgs resume mode', () => {
  test('--resume with no flags → auto-detect mode (empty resume + empty overrides)', () => {
    const r = parseResearchCommandArgs('--resume');

    expect(r).toEqual({ kind: 'resume', resume: {}, overrides: {} });
  });

  test('--run-root <path> records the value verbatim', () => {
    const r = expectCmdResume(parseResearchCommandArgs('--resume --run-root ./research/foo'));

    expect(r.resume.runRoot).toBe('./research/foo');
  });

  test('--run-root=<path> form works', () => {
    const r = expectCmdResume(parseResearchCommandArgs('--resume --run-root=./research/foo'));

    expect(r.resume.runRoot).toBe('./research/foo');
  });

  test('--from=<stage> accepts every ResumeStage value', () => {
    const stages: readonly ResumeStage[] = ['plan-crit', 'fanout', 'synth', 'review'];
    for (const s of stages) {
      const r = expectCmdResume(parseResearchCommandArgs(`--resume --from=${s}`));

      expect(r.resume.from).toBe(s);
    }
  });

  test('--from=<unknown> is rejected with the list of valid values', () => {
    const err = expectCmdError(parseResearchCommandArgs('--resume --from=bogus'));

    expect(err).toMatch(/^--from value "bogus" must be one of:/);
    expect(err).toContain('plan-crit');
    expect(err).toContain('review');
  });

  test('--review-max-iter integer value is captured on overrides.reviewMaxIter', () => {
    const r = expectCmdResume(parseResearchCommandArgs('--resume --review-max-iter 8'));

    expect(r.overrides.reviewMaxIter).toBe(8);
  });

  test('--review-max-iter rejects non-integers', () => {
    const err = expectCmdError(parseResearchCommandArgs('--resume --review-max-iter abc'));

    expect(err).toMatch(/--review-max-iter must be a positive integer/);
  });

  test('mixes resume-only flags with shared override flags', () => {
    const r = expectCmdResume(
      parseResearchCommandArgs(
        '--resume --run-root=./research/x --from=review --review-max-iter=8 --critic-model openai/x',
      ),
    );

    expect(r.resume).toEqual({ runRoot: './research/x', from: 'review' });
    expect(r.overrides).toEqual({ reviewMaxIter: 8, criticModel: 'openai/x' });
  });

  test('duplicate --run-root is rejected', () => {
    const err = expectCmdError(parseResearchCommandArgs('--resume --run-root a --run-root b'));

    expect(err).toMatch(/--run-root may only be specified once/);
  });

  test('duplicate --from is rejected', () => {
    const err = expectCmdError(parseResearchCommandArgs('--resume --from=review --from=fanout'));

    expect(err).toMatch(/--from may only be specified once/);
  });

  test('non-flag tokens after --resume are rejected (resume takes flags only)', () => {
    const err = expectCmdError(parseResearchCommandArgs('--resume some question text'));

    expect(err).toMatch(/--resume takes flags only; unexpected token "some"/);
  });

  test('flag missing value is rejected', () => {
    expect(expectCmdError(parseResearchCommandArgs('--resume --run-root'))).toMatch(/--run-root requires a value/);
    expect(expectCmdError(parseResearchCommandArgs('--resume --from'))).toMatch(/--from requires a value/);
  });
});

describe('parseResearchCommandArgs resume mode: --sq', () => {
  test('comma-separated ids captured on resume.subQuestionIds (= form)', () => {
    const r = expectCmdResume(parseResearchCommandArgs('--resume --from=fanout --sq=sq-1,sq-3'));

    expect(r.resume.from).toBe('fanout');
    expect(r.resume.subQuestionIds).toEqual(['sq-1', 'sq-3']);
  });

  test('single id (space form) works', () => {
    const r = expectCmdResume(parseResearchCommandArgs('--resume --sq sq-2'));

    expect(r.resume.subQuestionIds).toEqual(['sq-2']);
  });

  test('preserves caller-supplied order (no sort)', () => {
    const r = expectCmdResume(parseResearchCommandArgs('--resume --sq=sq-3,sq-1,sq-2'));

    expect(r.resume.subQuestionIds).toEqual(['sq-3', 'sq-1', 'sq-2']);
  });

  test('empty token in the comma list is rejected', () => {
    expect(expectCmdError(parseResearchCommandArgs('--resume --sq=sq-1,,sq-3'))).toMatch(
      /--sq value "sq-1,,sq-3" has an empty id/,
    );
    expect(expectCmdError(parseResearchCommandArgs('--resume --sq=sq-1,'))).toMatch(
      /--sq value "sq-1," has an empty id/,
    );
  });

  test('duplicate --sq is rejected', () => {
    expect(expectCmdError(parseResearchCommandArgs('--resume --sq=sq-1 --sq=sq-2'))).toMatch(
      /--sq may only be specified once/,
    );
  });

  test('missing value is rejected', () => {
    expect(expectCmdError(parseResearchCommandArgs('--resume --sq'))).toMatch(/--sq requires a value/);
  });

  test('--sq is rejected in question mode', () => {
    expect(expectCmdError(parseResearchCommandArgs('--sq sq-1 some question'))).toMatch(
      /--sq is only valid with --resume/,
    );
  });

  test('composes with --run-root + --from + shared overrides', () => {
    const r = expectCmdResume(
      parseResearchCommandArgs('--resume --run-root=./research/x --from=fanout --sq=sq-1,sq-4 --fanout-model openai/a'),
    );

    expect(r.resume).toEqual({ runRoot: './research/x', from: 'fanout', subQuestionIds: ['sq-1', 'sq-4'] });
    expect(r.overrides).toEqual({ fanoutModel: 'openai/a' });
  });
});

describe('parseResearchCommandArgs question mode: --review-max-iter', () => {
  test('--review-max-iter is accepted outside resume mode', () => {
    const r = expectCmdQuestion(parseResearchCommandArgs('--review-max-iter 6 some question'));

    expect(r.question).toBe('some question');
    expect(r.overrides.reviewMaxIter).toBe(6);
  });

  test('--run-root is rejected in question mode', () => {
    const err = expectCmdError(parseResearchCommandArgs('--run-root ./x some question'));

    expect(err).toMatch(/--run-root is only valid with --resume/);
  });

  test('--from is rejected in question mode', () => {
    const err = expectCmdError(parseResearchCommandArgs('--from review some question'));

    expect(err).toMatch(/--from is only valid with --resume/);
  });
});

describe('validateToolOverrides: reviewMaxIter', () => {
  test('valid integer is normalized and mirrored on overrides.reviewMaxIter', () => {
    const r = expectValidatedOk(validateToolOverrides({ reviewMaxIter: 8 }));

    expect(r.reviewMaxIter).toBe(8);
    expect(r.overrides.reviewMaxIter).toBe(8);
  });

  test('non-integer is rejected', () => {
    const r = expectValidatedErr(validateToolOverrides({ reviewMaxIter: 'abc' }));

    expect(r.error).toMatch(/`reviewMaxIter` must be a positive integer/);
  });

  test('absent reviewMaxIter omits the field entirely', () => {
    const r = expectValidatedOk(validateToolOverrides({}));

    expect('reviewMaxIter' in r ? r.reviewMaxIter : undefined).toBeUndefined();
    expect(r.overrides.reviewMaxIter).toBeUndefined();
  });
});

describe('formatOverridesSummary: resume + reviewMaxIter', () => {
  test('resume.runRoot + resume.from appear in the summary', () => {
    expect(formatOverridesSummary({}, { runRoot: './r/x', from: 'review' })).toBe(' [run-root=./r/x from=review]');
  });

  test('overrides.reviewMaxIter appears in the summary', () => {
    expect(formatOverridesSummary({ reviewMaxIter: 8 })).toBe(' [review-max-iter=8]');
  });

  test('resume + overrides compose in a stable order', () => {
    expect(
      formatOverridesSummary({ model: 'openai/top', reviewMaxIter: 8 }, { runRoot: './r/x', from: 'review' }),
    ).toBe(' [run-root=./r/x from=review model=openai/top review-max-iter=8]');
  });

  test('resume.subQuestionIds appear as sq=<id,id> in the summary', () => {
    expect(formatOverridesSummary({}, { from: 'fanout', subQuestionIds: ['sq-1', 'sq-3'] })).toBe(
      ' [from=fanout sq=sq-1,sq-3]',
    );
  });

  test('empty subQuestionIds array is omitted from the summary', () => {
    expect(formatOverridesSummary({}, { from: 'fanout', subQuestionIds: [] })).toBe(' [from=fanout]');
  });
});

describe('parseParallel', () => {
  test('accepts positive integers up to 64', () => {
    expect(parseParallel('--fanout-parallel', '1')).toBe(1);
    expect(parseParallel('--fanout-parallel', '8')).toBe(8);
    expect(parseParallel('--fanout-parallel', '64')).toBe(64);
  });

  test('rejects zero, negative, decimals, non-numeric, empty', () => {
    expect(parseParallel('--fanout-parallel', '0')).toHaveProperty('error');
    expect(parseParallel('--fanout-parallel', '-1')).toHaveProperty('error');
    expect(parseParallel('--fanout-parallel', '3.14')).toHaveProperty('error');
    expect(parseParallel('--fanout-parallel', 'abc')).toHaveProperty('error');
    expect(parseParallel('--fanout-parallel', '')).toHaveProperty('error');
  });

  test('rejects values above the 64-worker cap', () => {
    expect(expectParallelError(parseParallel('--fanout-parallel', '65'))).toMatch(/exceeds the 64-worker cap/);
  });
});

describe('parseWallClockSec', () => {
  test('accepts bare integer as seconds', () => {
    expect(parseWallClockSec('--wall-clock', '1')).toBe(1);
    expect(parseWallClockSec('--wall-clock', '300')).toBe(300);
    expect(parseWallClockSec('--wall-clock', '86400')).toBe(86_400);
  });

  test('accepts s / m / h suffixes and normalises to seconds', () => {
    expect(parseWallClockSec('--wall-clock', '90s')).toBe(90);
    expect(parseWallClockSec('--wall-clock', '30m')).toBe(30 * 60);
    expect(parseWallClockSec('--wall-clock', '2h')).toBe(2 * 3600);
    expect(parseWallClockSec('--wall-clock', '24h')).toBe(86_400);
  });

  test('rejects zero, negative, decimals, mixed garbage, empty', () => {
    expect(parseWallClockSec('--wall-clock', '0')).toHaveProperty('error');
    expect(parseWallClockSec('--wall-clock', '-30')).toHaveProperty('error');
    expect(parseWallClockSec('--wall-clock', '1.5h')).toHaveProperty('error');
    expect(parseWallClockSec('--wall-clock', '2hr')).toHaveProperty('error');
    expect(parseWallClockSec('--wall-clock', 'abc')).toHaveProperty('error');
    expect(parseWallClockSec('--wall-clock', '')).toHaveProperty('error');
  });

  test('rejects values above the 24h clamp', () => {
    expect(expectWallClockError(parseWallClockSec('--wall-clock', '25h'))).toMatch(/24h cap/);
    expect(expectWallClockError(parseWallClockSec('--wall-clock', '86401'))).toMatch(/24h cap/);
  });
});

describe('parseResearchCommandArgs question mode: --fanout-parallel / --wall-clock', () => {
  test('--fanout-parallel is accepted and normalised', () => {
    const r = expectCmdQuestion(parseResearchCommandArgs('--fanout-parallel 1 some question'));

    expect(r.question).toBe('some question');
    expect(r.overrides.fanoutParallel).toBe(1);
  });

  test('--fanout-parallel accepts the `=` form', () => {
    const r = expectCmdQuestion(parseResearchCommandArgs('--fanout-parallel=4 some question'));

    expect(r.overrides.fanoutParallel).toBe(4);
  });

  test('--fanout-parallel is rejected when specified twice', () => {
    const err = expectCmdError(parseResearchCommandArgs('--fanout-parallel 1 --fanout-parallel 2 q'));

    expect(err).toMatch(/--fanout-parallel may only be specified once/);
  });

  test('--wall-clock accepts bare seconds', () => {
    const r = expectCmdQuestion(parseResearchCommandArgs('--wall-clock 7200 local-model run'));

    expect(r.overrides.wallClockSec).toBe(7200);
  });

  test('--wall-clock accepts h/m/s suffixes', () => {
    expect(expectCmdQuestion(parseResearchCommandArgs('--wall-clock 2h q')).overrides.wallClockSec).toBe(2 * 3600);
    expect(expectCmdQuestion(parseResearchCommandArgs('--wall-clock=30m q')).overrides.wallClockSec).toBe(30 * 60);
    expect(expectCmdQuestion(parseResearchCommandArgs('--wall-clock 45s q')).overrides.wallClockSec).toBe(45);
  });

  test('--wall-clock is rejected when specified twice', () => {
    const err = expectCmdError(parseResearchCommandArgs('--wall-clock 2h --wall-clock 3h q'));

    expect(err).toMatch(/--wall-clock may only be specified once/);
  });

  test('--wall-clock rejects malformed values', () => {
    const err = expectCmdError(parseResearchCommandArgs('--wall-clock 1.5h q'));

    expect(err).toMatch(/--wall-clock/);
  });

  test('--fanout-parallel + --wall-clock compose with other overrides', () => {
    const r = expectCmdQuestion(
      parseResearchCommandArgs('--fanout-parallel 1 --wall-clock 2h --model llama-cpp/qwen3 some q'),
    );

    expect(r.overrides).toEqual({
      model: 'llama-cpp/qwen3',
      fanoutParallel: 1,
      wallClockSec: 2 * 3600,
    });
    expect(r.question).toBe('some q');
  });
});

describe('parseResearchCommandArgs resume mode: --fanout-parallel / --wall-clock', () => {
  test('both overrides are accepted alongside --resume', () => {
    const r = expectCmdResume(parseResearchCommandArgs('--resume --from fanout --fanout-parallel 1 --wall-clock 2h'));

    expect(r.resume.from).toBe('fanout');
    expect(r.overrides.fanoutParallel).toBe(1);
    expect(r.overrides.wallClockSec).toBe(2 * 3600);
  });
});

describe('validateToolOverrides: fanoutParallel', () => {
  test('valid integer is normalised', () => {
    const r = expectValidatedOk(validateToolOverrides({ fanoutParallel: 1 }));

    expect(r.overrides.fanoutParallel).toBe(1);
  });

  test('non-integer is rejected', () => {
    const r = expectValidatedErr(validateToolOverrides({ fanoutParallel: 'abc' }));

    expect(r.error).toMatch(/`fanoutParallel` must be a positive integer/);
  });

  test('value above cap is rejected', () => {
    const r = expectValidatedErr(validateToolOverrides({ fanoutParallel: 128 }));

    expect(r.error).toMatch(/64-worker cap/);
  });
});

describe('validateToolOverrides: wallClockSec', () => {
  test('integer seconds are normalised', () => {
    const r = expectValidatedOk(validateToolOverrides({ wallClockSec: 7200 }));

    expect(r.overrides.wallClockSec).toBe(7200);
  });

  test('non-integer is rejected', () => {
    const r = expectValidatedErr(validateToolOverrides({ wallClockSec: 'abc' }));

    expect(r.error).toMatch(/`wallClockSec` must be a positive integer/);
  });

  test('value above 24h clamp is rejected', () => {
    const r = expectValidatedErr(validateToolOverrides({ wallClockSec: 90_000 }));

    expect(r.error).toMatch(/24h cap/);
  });

  test('absent fields are omitted entirely', () => {
    const r = expectValidatedOk(validateToolOverrides({}));

    expect(r.overrides.fanoutParallel).toBeUndefined();
    expect(r.overrides.wallClockSec).toBeUndefined();
  });
});

describe('formatOverridesSummary: fanoutParallel + wallClockSec', () => {
  test('fanoutParallel appears in the summary', () => {
    expect(formatOverridesSummary({ fanoutParallel: 1 })).toBe(' [fanout-parallel=1]');
  });

  test('wallClockSec appears in the summary with an s suffix', () => {
    expect(formatOverridesSummary({ wallClockSec: 7200 })).toBe(' [wall-clock=7200s]');
  });

  test('both compose with other overrides in a stable order', () => {
    expect(
      formatOverridesSummary({
        model: 'llama-cpp/qwen3',
        fanoutParallel: 1,
        wallClockSec: 7200,
      }),
    ).toBe(' [model=llama-cpp/qwen3 fanout-parallel=1 wall-clock=7200s]');
  });
});
