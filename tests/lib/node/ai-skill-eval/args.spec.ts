// Tests for lib/node/ai-skill-eval/args.ts.
//
// The argparse module was extracted from cli.ts; these specs pin the
// flag-shape contract (validation, mutual exclusion, defaults) so
// refactoring the dispatch surface in cli.ts can't drift it silently.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_WORKSPACE, parseArgs, PROG, UsageError, VERSION } from '../../../../lib/node/ai-skill-eval/args.ts';

// process.exit on --help / --version / empty argv would kill the vitest
// runner; stub it out so the tests can observe the intent.
class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('parseArgs — defaults', () => {
  test('list: defaults workspace, runs, threshold, timeout, workers', () => {
    const opts = parseArgs(['list']);

    expect(opts.subcommand).toBe('list');
    expect(opts.workspace).toBe(DEFAULT_WORKSPACE);
    expect(opts.runsPerQuery).toBeNull();
    expect(opts.triggerThreshold).toBe(0.5);
    expect(opts.numWorkers).toBe(1);
    expect(opts.timeoutMs).toBe(30_000);
    expect(opts.holdout).toBe(0.4);
    expect(opts.maxIterations).toBe(5);
    expect(opts.baseline).toBe(false);
    expect(opts.write).toBe(false);
  });

  test('empty argv prints HELP_TEXT and exits 0', () => {
    expect(() => parseArgs([])).toThrow(ExitCalled);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  test('--version prints "ai-skill-eval <VERSION>" and exits 0', () => {
    expect(() => parseArgs(['--version'])).toThrow(ExitCalled);
    expect(stdoutSpy).toHaveBeenCalledWith(`${PROG} ${VERSION}\n`);
  });

  test('--help after a subcommand also exits 0', () => {
    expect(() => parseArgs(['run', '--help'])).toThrow(ExitCalled);
  });
});

describe('parseArgs — flag shapes', () => {
  test('--timeout converts seconds → ms', () => {
    expect(parseArgs(['list', '--timeout', '15']).timeoutMs).toBe(15_000);
    expect(parseArgs(['list', '--timeout=60']).timeoutMs).toBe(60_000);
    expect(parseArgs(['list', '--timeout', '0']).timeoutMs).toBe(0);
  });

  test('--num-workers positive integer only', () => {
    expect(parseArgs(['list', '--num-workers', '4']).numWorkers).toBe(4);
    expect(() => parseArgs(['list', '--num-workers', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['list', '--num-workers', 'x'])).toThrow(UsageError);
  });

  test('--trigger-threshold only accepts [0, 1]', () => {
    expect(parseArgs(['list', '--trigger-threshold', '0.7']).triggerThreshold).toBe(0.7);
    expect(() => parseArgs(['list', '--trigger-threshold', '-0.1'])).toThrow(UsageError);
    expect(() => parseArgs(['list', '--trigger-threshold', '1.5'])).toThrow(UsageError);
  });

  test('--holdout only accepts [0, 1)', () => {
    expect(parseArgs(['list', '--holdout', '0']).holdout).toBe(0);
    expect(parseArgs(['list', '--holdout', '0.3']).holdout).toBe(0.3);
    expect(() => parseArgs(['list', '--holdout', '1'])).toThrow(UsageError);
    expect(() => parseArgs(['list', '--holdout', '-0.1'])).toThrow(UsageError);
  });

  test('--iterations requires exactly two distinct positive integers', () => {
    expect(parseArgs(['compare', '--iterations', '1,2']).iterationsPair).toEqual([1, 2]);
    expect(() => parseArgs(['compare', '--iterations', '1'])).toThrow(UsageError);
    expect(() => parseArgs(['compare', '--iterations', '1,1'])).toThrow(UsageError);
    expect(() => parseArgs(['compare', '--iterations', '0,2'])).toThrow(UsageError);
  });

  test('--driver rejects unknown values', () => {
    expect(() => parseArgs(['list', '--driver', 'gemini'])).toThrow();
  });

  test('repeatable flags (--skill-root, --only) accumulate', () => {
    const opts = parseArgs(['list', '--skill-root', 'a', '--skill-root=b', '--only', 'x', '--only=y']);

    expect(opts.skillRoots).toEqual(['a', 'b']);
    expect(opts.skillFilters).toEqual(['x', 'y']);
  });

  test('positional args route to `positional` for non-rerun subcommands', () => {
    expect(parseArgs(['run', 'skill-a', 'skill-b']).positional).toEqual(['skill-a', 'skill-b']);
  });

  test('positional args route to `rerunTargets` for rerun', () => {
    const opts = parseArgs(['rerun', 'skill-a:positive-1', 'skill-b:negative-2']);

    expect(opts.rerunTargets).toEqual(['skill-a:positive-1', 'skill-b:negative-2']);
    expect(opts.positional).toEqual([]);
  });
});

describe('parseArgs — subcommand / flag mutual exclusion', () => {
  test('--compare-to is only valid on `report`', () => {
    expect(parseArgs(['report', '--compare-to', '2']).compareTo).toBe(2);
    expect(() => parseArgs(['run', '--compare-to', '2'])).toThrow(UsageError);
  });

  test('--iterations is only valid on `compare` / `analyze`', () => {
    expect(parseArgs(['compare', '--iterations', '1,2']).subcommand).toBe('compare');
    expect(parseArgs(['analyze', '--iterations', '1,2']).subcommand).toBe('analyze');
    expect(() => parseArgs(['run', '--iterations', '1,2'])).toThrow(UsageError);
  });

  test('--write is only valid on `optimize`', () => {
    expect(parseArgs(['optimize', 'my-skill', '--write']).write).toBe(true);
    expect(() => parseArgs(['run', '--write'])).toThrow(UsageError);
  });

  test('--eval-set is only valid on `optimize`', () => {
    expect(parseArgs(['optimize', 'my-skill', '--eval-set', '/tmp/x.json']).evalSet).toBe('/tmp/x.json');
    expect(() => parseArgs(['run', '--eval-set', '/tmp/x.json'])).toThrow(UsageError);
  });

  test('unknown subcommand throws UsageError', () => {
    expect(() => parseArgs(['nope'])).toThrow(UsageError);
  });

  test('unknown global flag throws UsageError', () => {
    expect(() => parseArgs(['list', '--does-not-exist'])).toThrow(UsageError);
  });
});

describe('parseArgs — AI_SKILL_EVAL_WORKSPACE fallback', () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.AI_SKILL_EVAL_WORKSPACE;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.AI_SKILL_EVAL_WORKSPACE;
    else process.env.AI_SKILL_EVAL_WORKSPACE = prev;
  });

  test('picks up AI_SKILL_EVAL_WORKSPACE when --workspace is unset', () => {
    process.env.AI_SKILL_EVAL_WORKSPACE = '/tmp/via-env';

    expect(parseArgs(['list']).workspace).toBe('/tmp/via-env');
  });

  test('--workspace wins over AI_SKILL_EVAL_WORKSPACE', () => {
    process.env.AI_SKILL_EVAL_WORKSPACE = '/tmp/via-env';

    expect(parseArgs(['list', '--workspace', '/tmp/via-flag']).workspace).toBe('/tmp/via-flag');
  });
});
