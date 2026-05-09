// Tests for lib/node/ai-skill-eval/run-files.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  listRunFiles,
  listRunFilesAt,
  listRunMetaFiles,
  resultDir,
  resultDirAt,
} from '../../../../lib/node/ai-skill-eval/run-files.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ai-skill-eval-run-files-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function setupResultDir(dir: string, runIndexes: number[], metaIndexes: number[] = []): void {
  mkdirSync(dir, { recursive: true });
  for (const n of runIndexes) writeFileSync(join(dir, `run-${n}.txt`), 'TRIGGER: yes\n');
  for (const n of metaIndexes) writeFileSync(join(dir, `run-${n}.txt.meta.json`), '{}');
}

describe('resultDir / resultDirAt', () => {
  test('resultDir builds the canonical per-eval results path', () => {
    expect(resultDir('/ws/skill/iteration-1', 'with_skill', 'eval-a').replace(/\\/g, '/')).toBe(
      '/ws/skill/iteration-1/with_skill/results/eval-a',
    );
  });

  test('resultDirAt composes workspace + skill + iteration with the per-eval results path', () => {
    expect(resultDirAt(workspace, 'skill-x', 2, 'without_skill', 'eval-b').replace(/\\/g, '/')).toBe(
      `${workspace.replace(/\\/g, '/')}/skill-x/iteration-2/without_skill/results/eval-b`,
    );
  });
});

describe('listRunFiles', () => {
  test('returns [] when the result dir does not exist (no throw)', () => {
    expect(listRunFiles(join(workspace, 'missing'), 'with_skill', 'eval-a')).toEqual([]);
  });

  test('enumerates run-*.txt in numeric (not lexicographic) order', () => {
    const iterDir = join(workspace, 'iter');
    setupResultDir(join(iterDir, 'with_skill/results/eval-a'), [2, 10, 1]);

    const out = listRunFiles(iterDir, 'with_skill', 'eval-a');

    expect(out.map((p) => p.split(/[\\/]/).pop())).toEqual(['run-1.txt', 'run-2.txt', 'run-10.txt']);
  });

  test('ignores unrelated files in the same directory', () => {
    const iterDir = join(workspace, 'iter');
    const dir = join(iterDir, 'with_skill/results/eval-a');
    setupResultDir(dir, [1]);
    writeFileSync(join(dir, 'run-1.txt.meta.json'), '{}');
    writeFileSync(join(dir, 'run-1.txt.error'), 'nope');
    writeFileSync(join(dir, 'not-a-run.txt'), 'x');

    expect(listRunFiles(iterDir, 'with_skill', 'eval-a')).toHaveLength(1);
  });

  test('listRunFilesAt routes through the workspace/skill/iteration composition', () => {
    const iterDir = join(workspace, 'my-skill/iteration-3');
    setupResultDir(join(iterDir, 'with_skill/results/eval-a'), [1, 2]);

    expect(listRunFilesAt(workspace, 'my-skill', 3, 'with_skill', 'eval-a')).toHaveLength(2);
  });
});

describe('listRunMetaFiles', () => {
  test('enumerates run-*.txt.meta.json in numeric order, returns [] on missing dir', () => {
    expect(listRunMetaFiles(join(workspace, 'missing'))).toEqual([]);

    const dir = join(workspace, 'eval-a');
    setupResultDir(dir, [], [3, 1, 2]);

    const out = listRunMetaFiles(dir);

    expect(out.map((p) => p.split(/[\\/]/).pop())).toEqual([
      'run-1.txt.meta.json',
      'run-2.txt.meta.json',
      'run-3.txt.meta.json',
    ]);
  });

  test('ignores sibling run-*.txt files (they belong to listRunFiles)', () => {
    const dir = join(workspace, 'eval-a');
    setupResultDir(dir, [1, 2], [1]);

    expect(listRunMetaFiles(dir)).toHaveLength(1);
  });
});
