// Tests for lib/node/ai-skill-eval/workspace.ts.
//
// All helpers touch the filesystem; we build per-test fixture dirs under
// tmpdir() and tear them down in `afterEach` so the specs can run in
// parallel without clashes.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  cleanLegacyFlat,
  ITERATION_PREFIX,
  iterationPath,
  LATEST_LINK,
  latestIteration,
  listIterations,
  nextIteration,
  parseIterationName,
  writeLatestSymlink,
} from '../../../../lib/node/ai-skill-eval/workspace.ts';

interface Fixture {
  root: string;
  workspace: string;
  skill: string;
  skillDir: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ai-skill-eval-workspace-'));
  const workspace = join(root, '.ai-skill-eval');
  const skill = 'sample';
  const skillDir = join(workspace, skill);
  mkdirSync(skillDir, { recursive: true });
  return { root, workspace, skill, skillDir };
}

describe('parseIterationName', () => {
  test('accepts exactly `iteration-N` with N >= 1', () => {
    expect(parseIterationName('iteration-1')).toBe(1);
    expect(parseIterationName('iteration-42')).toBe(42);
  });

  test('rejects N == 0, negative numbers, and non-numeric suffixes', () => {
    expect(parseIterationName('iteration-0')).toBeNull();
    expect(parseIterationName('iteration--1')).toBeNull();
    expect(parseIterationName('iteration-abc')).toBeNull();
  });

  test('rejects unrelated basenames', () => {
    expect(parseIterationName('latest')).toBeNull();
    expect(parseIterationName('with_skill')).toBeNull();
    expect(parseIterationName('ITERATION-1')).toBeNull(); // case-sensitive
  });
});

describe('iterationPath', () => {
  test('joins workspace + skill + iteration-N', () => {
    expect(iterationPath('/tmp/ws', 'sample', 3)).toBe('/tmp/ws/sample/iteration-3');
  });
});

describe('listIterations + latestIteration + nextIteration', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  test('empty skill workspace: list is empty, latest is null, next is 1', () => {
    expect(listIterations(fx.workspace, fx.skill)).toEqual([]);
    expect(latestIteration(fx.workspace, fx.skill)).toBeNull();
    expect(nextIteration(fx.workspace, fx.skill)).toBe(1);
  });

  test('missing skill workspace (skill dir does not exist yet): list is empty, next is 1', () => {
    rmSync(fx.skillDir, { recursive: true, force: true });

    expect(listIterations(fx.workspace, fx.skill)).toEqual([]);
    expect(nextIteration(fx.workspace, fx.skill)).toBe(1);
  });

  test('with existing iteration dirs: list sorted ascending, latest is max, next is max+1', () => {
    mkdirSync(join(fx.skillDir, 'iteration-1'));
    mkdirSync(join(fx.skillDir, 'iteration-3'));
    mkdirSync(join(fx.skillDir, 'iteration-2'));

    expect(listIterations(fx.workspace, fx.skill)).toEqual([1, 2, 3]);
    expect(latestIteration(fx.workspace, fx.skill)).toBe(3);
    expect(nextIteration(fx.workspace, fx.skill)).toBe(4);
  });

  test('ignores sibling entries that are not iteration-N directories', () => {
    mkdirSync(join(fx.skillDir, 'iteration-1'));
    mkdirSync(join(fx.skillDir, 'with_skill')); // legacy
    writeFileSync(join(fx.skillDir, 'benchmark.json'), '{}');
    writeFileSync(join(fx.skillDir, 'iteration-2.txt'), ''); // regular file

    expect(listIterations(fx.workspace, fx.skill)).toEqual([1]);
    expect(latestIteration(fx.workspace, fx.skill)).toBe(1);
  });
});

describe('cleanLegacyFlat', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  test('removes every legacy flat entry but leaves iteration-N intact', () => {
    // Pre-R3.3 R2/R3.2 layout
    mkdirSync(join(fx.skillDir, 'with_skill', 'grades'), { recursive: true });
    writeFileSync(join(fx.skillDir, 'with_skill', 'grades', 'e1.json'), '{}');
    mkdirSync(join(fx.skillDir, 'without_skill'), { recursive: true });
    writeFileSync(join(fx.skillDir, 'benchmark.json'), '{}');
    writeFileSync(join(fx.skillDir, 'benchmark.md'), '# ');
    // Pre-R2 flat trio
    mkdirSync(join(fx.skillDir, 'results'), { recursive: true });
    mkdirSync(join(fx.skillDir, 'prompts'), { recursive: true });
    mkdirSync(join(fx.skillDir, 'grades'), { recursive: true });
    // And a real iteration-1 that must survive
    mkdirSync(join(fx.skillDir, 'iteration-1'));
    writeFileSync(join(fx.skillDir, 'iteration-1', 'marker'), 'keep');

    cleanLegacyFlat(fx.workspace, fx.skill);

    for (const legacy of [
      'with_skill',
      'without_skill',
      'prompts',
      'results',
      'grades',
      'benchmark.json',
      'benchmark.md',
    ]) {
      expect(existsSync(join(fx.skillDir, legacy))).toBe(false);
    }

    expect(existsSync(join(fx.skillDir, 'iteration-1', 'marker'))).toBe(true);
  });

  test('no-op when there are no legacy entries', () => {
    mkdirSync(join(fx.skillDir, 'iteration-1'));

    cleanLegacyFlat(fx.workspace, fx.skill);

    expect(existsSync(join(fx.skillDir, 'iteration-1'))).toBe(true);
  });

  test('silently no-ops when the skill workspace does not exist', () => {
    rmSync(fx.skillDir, { recursive: true, force: true });

    expect(() => cleanLegacyFlat(fx.workspace, fx.skill)).not.toThrow();
  });
});

describe('writeLatestSymlink', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  test('writes a `latest -> iteration-N` symlink pointing at a relative target', () => {
    mkdirSync(join(fx.skillDir, 'iteration-2'));

    writeLatestSymlink(fx.workspace, fx.skill, 2);

    const linkPath = join(fx.skillDir, LATEST_LINK);

    // Linux/Docker always supports symlinks; Windows without elevation
    // silently no-ops and lstat() of the path throws. We run the spec under
    // vitest on Linux (docker + WSL2), so the assertion is unconditional.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(`${ITERATION_PREFIX}2`);
  });

  test('overwrites an existing `latest` link when the iteration advances', () => {
    mkdirSync(join(fx.skillDir, 'iteration-1'));
    mkdirSync(join(fx.skillDir, 'iteration-2'));

    writeLatestSymlink(fx.workspace, fx.skill, 1);
    writeLatestSymlink(fx.workspace, fx.skill, 2);

    const linkPath = join(fx.skillDir, LATEST_LINK);

    expect(readlinkSync(linkPath)).toBe(`${ITERATION_PREFIX}2`);
  });

  test('no-ops when the skill workspace does not exist', () => {
    rmSync(fx.skillDir, { recursive: true, force: true });

    expect(() => writeLatestSymlink(fx.workspace, fx.skill, 1)).not.toThrow();
    expect(existsSync(join(fx.skillDir, LATEST_LINK))).toBe(false);
  });
});
