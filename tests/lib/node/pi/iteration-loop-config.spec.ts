/**
 * Tests for lib/node/pi/iteration-loop-config.ts.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  BUILT_IN_CLAIM_REGEXES,
  compileBuiltInClaimRegexes,
  loadIterationLoopConfig,
  matchesClaimRegex,
} from '../../../../lib/node/pi/iteration-loop-config.ts';

function makeSandbox(): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'iteration-loop-config-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  return { home, cwd };
}

describe('loadIterationLoopConfig', () => {
  const sandboxes: { home: string; cwd: string }[] = [];

  afterEach(() => sandboxes.splice(0));

  test('returns defaults when no config files exist', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    const { config, warnings } = loadIterationLoopConfig(cwd, home);

    expect(warnings).toEqual([]);
    expect(config.strictNudgeAfterNEdits).toBe(2);
    expect(config.maxIterDefault).toBe(null);
    expect(config.costCapDefaultUsd).toBe(null);
    expect(config.archiveOnClose).toBe(true);
    // Built-ins compiled in.
    expect(config.claimRegexes.length).toBe(BUILT_IN_CLAIM_REGEXES.length);
  });

  test('global config loads scalar knobs', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    writeFileSync(
      join(home, '.pi', 'agent', 'iteration-loop.json'),
      JSON.stringify({
        strict_nudge_after_n_edits: 4,
        max_iter_default: 8,
        cost_cap_default_usd: 0.25,
        archive_on_close: false,
      }),
    );
    const { config, warnings } = loadIterationLoopConfig(cwd, home);

    expect(warnings).toEqual([]);
    expect(config.strictNudgeAfterNEdits).toBe(4);
    expect(config.maxIterDefault).toBe(8);
    expect(config.costCapDefaultUsd).toBeCloseTo(0.25);
    expect(config.archiveOnClose).toBe(false);
  });

  test('project config overrides global scalars', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    writeFileSync(join(home, '.pi', 'agent', 'iteration-loop.json'), JSON.stringify({ strict_nudge_after_n_edits: 4 }));
    writeFileSync(join(cwd, '.pi', 'iteration-loop.json'), JSON.stringify({ strict_nudge_after_n_edits: 1 }));
    const { config } = loadIterationLoopConfig(cwd, home);

    expect(config.strictNudgeAfterNEdits).toBe(1);
  });

  test('claim_regexes replaces built-ins', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    writeFileSync(join(cwd, '.pi', 'iteration-loop.json'), JSON.stringify({ claim_regexes: ['\\bready to ship\\b'] }));
    const { config, warnings } = loadIterationLoopConfig(cwd, home);

    expect(warnings).toEqual([]);
    expect(config.claimRegexes.length).toBe(1);
    expect(config.claimRegexes[0].test('this is ready to ship now')).toBe(true);
    expect(config.claimRegexes[0].test('it looks right')).toBe(false);
  });

  test('claim_regexes_extra appends to built-ins', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    writeFileSync(
      join(cwd, '.pi', 'iteration-loop.json'),
      JSON.stringify({ claim_regexes_extra: ['\\bmission complete\\b'] }),
    );
    const { config } = loadIterationLoopConfig(cwd, home);

    expect(config.claimRegexes.length).toBe(BUILT_IN_CLAIM_REGEXES.length + 1);

    const matched = config.claimRegexes.some((r) => r.test('mission complete — moving on'));

    expect(matched).toBe(true);
  });

  test('bad regex produces warning but keeps loading', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    writeFileSync(
      join(cwd, '.pi', 'iteration-loop.json'),
      JSON.stringify({ claim_regexes_extra: ['[unterminated', '\\bok\\b'] }),
    );
    const { config, warnings } = loadIterationLoopConfig(cwd, home);

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].error).toMatch(/invalid regex/);
    // The valid one compiled.
    expect(config.claimRegexes.some((r) => r.test('ok'))).toBe(true);
  });

  test('malformed JSON warns but returns defaults', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    writeFileSync(join(cwd, '.pi', 'iteration-loop.json'), '{ broken json');
    const { config, warnings } = loadIterationLoopConfig(cwd, home);

    expect(warnings.length).toBe(1);
    // Defaults preserved.
    expect(config.strictNudgeAfterNEdits).toBe(2);
  });

  test('rejects bad scalar types with warnings, keeps defaults', () => {
    const { home, cwd } = makeSandbox();
    sandboxes.push({ home, cwd });
    writeFileSync(
      join(cwd, '.pi', 'iteration-loop.json'),
      JSON.stringify({
        strict_nudge_after_n_edits: 0,
        max_iter_default: -1,
        cost_cap_default_usd: 'cheap',
        archive_on_close: 'yes',
      }),
    );
    const { config, warnings } = loadIterationLoopConfig(cwd, home);

    expect(warnings.length).toBe(4);
    expect(config.strictNudgeAfterNEdits).toBe(2);
    expect(config.maxIterDefault).toBe(null);
    expect(config.costCapDefaultUsd).toBe(null);
    expect(config.archiveOnClose).toBe(true);
  });
});

describe('matchesClaimRegex', () => {
  const regexes = compileBuiltInClaimRegexes();

  test('matches built-in artifact-correctness phrases', () => {
    expect(matchesClaimRegex(regexes, 'the svg is done now')).not.toBeNull();
    expect(matchesClaimRegex(regexes, 'it looks right, shipping it')).not.toBeNull();
    expect(matchesClaimRegex(regexes, 'this matches the spec')).not.toBeNull();
    expect(matchesClaimRegex(regexes, 'rendered correctly per the rubric')).not.toBeNull();
  });

  test('rejects ambiguous / unrelated text', () => {
    expect(matchesClaimRegex(regexes, 'let me check the file')).toBeNull();
    expect(matchesClaimRegex(regexes, 'tests pass')).toBeNull();
    expect(matchesClaimRegex([], 'the artifact is done')).toBeNull();
  });
});
