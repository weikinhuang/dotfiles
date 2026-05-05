/**
 * Tests for lib/node/pi/research-command-args.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  formatOverridesSummary,
  parseMaxTurns,
  parseModelSpec,
  parseResearchCommandArgs,
  type ResearchCommandArgs,
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

function expectCmdError(r: ResearchCommandArgs): string {
  if (r.kind !== 'error') throw new Error(`expected parseResearchCommandArgs 'error', got '${r.kind}'`);
  return r.error;
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
});
