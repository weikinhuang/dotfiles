/**
 * Specs for `git-tracked.ts` - the synchronous helper that asks
 * `git ls-files` which of a set of absolute candidate paths are
 * tracked in `cwd`'s index.
 *
 * The interesting properties:
 *
 *   - Returns the absolute-path subset for files that are tracked.
 *   - Skips candidates that escape `cwd`.
 *   - Returns an empty Set when `cwd` is not a git repo.
 *   - Returns an empty Set when `git` exits with anything other
 *     than the expected line-stream (no throwing).
 *   - Tolerates an empty input list as a no-op.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { gitTrackedSubset } from '../../../../../lib/node/pi/sandbox/git-tracked.ts';

let cwd: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tests',
      GIT_AUTHOR_EMAIL: 'tests@example.com',
      GIT_COMMITTER_NAME: 'tests',
      GIT_COMMITTER_EMAIL: 'tests@example.com',
    },
  });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sandbox-git-tracked-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('gitTrackedSubset', () => {
  test('returns absolute-path Set for tracked files only', () => {
    git('init', '-q');
    writeFileSync(join(cwd, '.bashrc'), '', 'utf8');
    writeFileSync(join(cwd, 'yarn.lock'), '', 'utf8');
    writeFileSync(join(cwd, '.gitconfig'), '', 'utf8');
    git('add', '.bashrc', 'yarn.lock');
    git('commit', '-q', '-m', 'init');

    const tracked = gitTrackedSubset(cwd, [
      join(cwd, '.bashrc'),
      join(cwd, 'yarn.lock'),
      join(cwd, '.gitconfig'),
      join(cwd, '.npmrc'), // doesn't exist on disk
    ]);

    expect(tracked.has(join(cwd, '.bashrc'))).toBe(true);
    expect(tracked.has(join(cwd, 'yarn.lock'))).toBe(true);
    expect(tracked.has(join(cwd, '.gitconfig'))).toBe(false);
    expect(tracked.has(join(cwd, '.npmrc'))).toBe(false);
  });

  test('treats a non-git cwd as "nothing tracked"', () => {
    writeFileSync(join(cwd, '.bashrc'), '', 'utf8');
    const tracked = gitTrackedSubset(cwd, [join(cwd, '.bashrc')]);
    expect(tracked.size).toBe(0);
  });

  test('drops candidates that escape cwd', () => {
    git('init', '-q');
    writeFileSync(join(cwd, '.bashrc'), '', 'utf8');
    git('add', '.bashrc');
    git('commit', '-q', '-m', 'init');

    const tracked = gitTrackedSubset(cwd, [join(cwd, '.bashrc'), '/etc/passwd', `${cwd}/../escape`]);

    expect(tracked.has(join(cwd, '.bashrc'))).toBe(true);
    expect(tracked.size).toBe(1);
  });

  test('returns empty Set for empty candidate list', () => {
    git('init', '-q');
    expect(gitTrackedSubset(cwd, []).size).toBe(0);
  });

  test('handles nested-dir stub paths via componentwise tracking', () => {
    git('init', '-q');
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude/commands.md'), 'placeholder\n', 'utf8');
    git('add', '.claude/commands.md');
    git('commit', '-q', '-m', 'init');

    // The directory itself is not "tracked" in git's model (only files
    // are), so we only check that listed files come back tracked.
    const tracked = gitTrackedSubset(cwd, [
      join(cwd, '.claude/commands.md'),
      join(cwd, '.claude/agents'), // directory, not tracked
    ]);

    expect(tracked.has(join(cwd, '.claude/commands.md'))).toBe(true);
    expect(tracked.has(join(cwd, '.claude/agents'))).toBe(false);
  });
});
