/**
 * Tests for lib/node/opencode/statusline-git.ts.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  createKeyedRefresher,
  formatGitDecoration,
  GIT_STATE_SEPARATOR as SEP,
  parseGitPromptOutput,
  readGitSnapshot,
  type RefresherTimers,
} from '../../../../lib/node/opencode/statusline-git.ts';

const GIT_PROMPT = resolve(import.meta.dirname, '../../../../external/git-prompt.sh');

describe('parseGitPromptOutput', () => {
  test('splits branch, flags, and state at the separator', () => {
    expect(parseGitPromptOutput(`main${SEP}*+$%=`)).toEqual({ branch: 'main', flags: '*+$%=', state: '' });
    expect(parseGitPromptOutput(`feat/x${SEP}*<>|REBASE 1/2`)).toEqual({
      branch: 'feat/x',
      flags: '*<>',
      state: '|REBASE 1/2',
    });
  });

  test('clean tree: no separator, state may still trail', () => {
    expect(parseGitPromptOutput('main')).toEqual({ branch: 'main', flags: '', state: '' });
    expect(parseGitPromptOutput('main|MERGING\n')).toEqual({ branch: 'main', flags: '', state: '|MERGING' });
    expect(parseGitPromptOutput('(abc1234...)|SPARSE|AM/REBASE')).toEqual({
      branch: '(abc1234...)',
      flags: '',
      state: '|SPARSE|AM/REBASE',
    });
  });

  test('empty output is null', () => {
    expect(parseGitPromptOutput('')).toBeNull();
    expect(parseGitPromptOutput(' \n')).toBeNull();
  });
});

describe('formatGitDecoration', () => {
  test('flags only by default, branch on request', () => {
    const d = { branch: 'main', flags: '*%', state: '|MERGING' };
    expect(formatGitDecoration(d)).toBe('(*%|MERGING)');
    expect(formatGitDecoration(d, true)).toBe('(main *%|MERGING)');
    expect(formatGitDecoration({ branch: 'main', flags: '', state: '' })).toBe('');
    expect(formatGitDecoration({ branch: 'main', flags: '', state: '' }, true)).toBe('(main)');
    expect(formatGitDecoration(null, true)).toBe('');
  });
});

describe('readGitSnapshot (real git + external/git-prompt.sh)', () => {
  let repo = '';
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      stdio: 'ignore',
    });
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'oc-statusline-git-')));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('dirty, staged, and untracked flags', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git('add', 'b.txt');
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    const snap = await readGitSnapshot(repo, GIT_PROMPT);
    expect(snap).toEqual({ decoration: { branch: 'main', flags: '*+%', state: '' }, worktree: null });
  });

  test('clean tree has no flags; linked worktree name resolves', async () => {
    const wt = join(repo, '..', `${repo.split('/').pop() ?? 'x'}-wt`);
    git('worktree', 'add', '-q', '-b', 'side', wt, 'main');
    try {
      const snap = await readGitSnapshot(wt, GIT_PROMPT);
      expect(snap.decoration).toEqual({ branch: 'side', flags: '', state: '' });
      expect(snap.worktree).toBe(wt.split('/').pop());
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test('no script: decoration null, worktree still read', async () => {
    mkdirSync(join(repo, 'sub'));
    expect(await readGitSnapshot(join(repo, 'sub'), null)).toEqual({ decoration: null, worktree: null });
  });
});

describe('createKeyedRefresher', () => {
  function fakeTimers(): RefresherTimers & { flush(): void } {
    let pending: (() => void) | undefined;
    return {
      setTimeout: (fn) => {
        pending = fn;
        return 1;
      },
      clearTimeout: () => {
        pending = undefined;
      },
      flush: () => {
        const fn = pending;
        pending = undefined;
        fn?.();
      },
    };
  }

  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  test('track fetches once; requestAll debounces; mid-flight requests rerun once', async () => {
    const timers = fakeTimers();
    const calls: string[] = [];
    const values: string[] = [];
    const resolvers: (() => void)[] = [];
    const refresher = createKeyedRefresher<string>({
      fetch: (key) => {
        calls.push(key);
        return new Promise((r) => resolvers.push(() => r(`${key}#${calls.length}`)));
      },
      onValue: (key, value) => values.push(value),
      debounceMs: 10,
      timers,
    });

    refresher.track('/a');
    refresher.track('/a');
    expect(calls).toEqual(['/a']);

    // Two requests while the first fetch is in flight: coalesced into one rerun.
    refresher.requestAll();
    refresher.requestAll();
    timers.flush();
    timers.flush();
    expect(calls).toEqual(['/a']);
    resolvers.shift()?.();
    await tick();
    expect(values).toEqual(['/a#1']);
    expect(calls).toEqual(['/a', '/a']);
    resolvers.shift()?.();
    await tick();
    expect(values).toEqual(['/a#1', '/a#2']);

    refresher.dispose();
    refresher.requestAll();
    timers.flush();
    expect(calls).toHaveLength(2);
  });

  test('fetch errors keep the refresher alive', async () => {
    let fail = true;
    const values: number[] = [];
    const timers = fakeTimers();
    const refresher = createKeyedRefresher<number>({
      fetch: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(1)),
      onValue: (_key, v) => values.push(v),
      debounceMs: 0,
      timers,
    });
    refresher.track('/b');
    await tick();
    fail = false;
    refresher.requestAll();
    timers.flush();
    await tick();
    expect(values).toEqual([1]);
  });
});
