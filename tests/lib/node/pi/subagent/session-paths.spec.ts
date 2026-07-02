/**
 * Tests for lib/node/pi/subagent/session-paths.ts.
 *
 * Pure module - fs is injected.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  childSessionDir,
  listStaleWorktrees,
  retainMs,
  STALE_WORKTREE_PREFIX,
  subagentSessionBase,
  subagentSessionRoot,
  subagentSessionSlug,
  sweepStaleSessions,
  sweepStaleSessionsFlat,
  type SweepFs,
} from '../../../../../lib/node/pi/subagent/session-paths.ts';

describe('subagentSessionRoot', () => {
  // vi.stubEnv scopes the mutation to this describe block and restores
  // after, so parallel specs reading the same var don't race.
  beforeEach(() => {
    vi.stubEnv('PI_SUBAGENT_SESSION_ROOT', '/tmp/pi-test-root');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('honours PI_SUBAGENT_SESSION_ROOT', () => {
    expect(subagentSessionRoot()).toBe('/tmp/pi-test-root');
  });
});

describe('childSessionDir / subagentSessionBase', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('defaults to the parent session dir: <parentSessionDir>/<parentSid>/subagents', () => {
    const dir = childSessionDir({
      parentSessionDir: '/agent/sessions/--mnt-d-proj--',
      parentCwd: '/mnt/d/proj',
      parentSessionId: 'parent-abc',
    });

    expect(dir).toBe('/agent/sessions/--mnt-d-proj--/parent-abc/subagents');
  });

  test('follows a relocated session dir (--session-dir): base moves, layout stays', () => {
    // getSessionDir() returns the verbatim --session-dir path; the child
    // tree nests directly under it regardless of the (renamed) cwd.
    const dir = childSessionDir({
      parentSessionDir: '/repo/.pi/sessions',
      parentCwd: '/renamed/elsewhere',
      parentSessionId: 'parent-abc',
    });

    expect(dir).toBe('/repo/.pi/sessions/parent-abc/subagents');
  });

  test('subagentSessionBase is the parent session dir when no env root is set', () => {
    expect(subagentSessionBase('/agent/sessions/--slug--', '/mnt/d/proj')).toBe('/agent/sessions/--slug--');
  });

  test('PI_SUBAGENT_SESSION_ROOT overrides the base, bucketed by the workspace slug', () => {
    vi.stubEnv('PI_SUBAGENT_SESSION_ROOT', '/ram/subs');
    expect(subagentSessionBase('/agent/sessions/--slug--', '/mnt/d/proj')).toBe('/ram/subs/--mnt-d-proj--');
    expect(
      childSessionDir({
        parentSessionDir: '/agent/sessions/--slug--',
        parentCwd: '/mnt/d/proj',
        parentSessionId: 'parent-abc',
      }),
    ).toBe('/ram/subs/--mnt-d-proj--/parent-abc/subagents');
  });
});

describe('subagentSessionSlug / PI_SUBAGENT_SESSION_SLUG override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('defaults to the parent cwd slug when unset', () => {
    expect(subagentSessionSlug('/mnt/d/proj')).toBe('--mnt-d-proj--');
  });

  test('honours PI_SUBAGENT_SESSION_SLUG regardless of parent cwd', () => {
    vi.stubEnv('PI_SUBAGENT_SESSION_SLUG', 'rp');
    expect(subagentSessionSlug('/mnt/d/proj')).toBe('rp');
    expect(subagentSessionSlug('/renamed/elsewhere')).toBe('rp');
  });

  test('blank override falls back to the cwd slug', () => {
    vi.stubEnv('PI_SUBAGENT_SESSION_SLUG', '   ');
    expect(subagentSessionSlug('/mnt/d/proj')).toBe('--mnt-d-proj--');
  });

  test('childSessionDir uses the pinned slug (env-root branch) so the tree survives a rename', () => {
    vi.stubEnv('PI_SUBAGENT_SESSION_ROOT', '/ram/subs');
    vi.stubEnv('PI_SUBAGENT_SESSION_SLUG', 'rp');
    const dir = childSessionDir({
      parentSessionDir: '/agent/sessions/--renamed--',
      parentCwd: '/renamed/elsewhere',
      parentSessionId: 'parent-abc',
    });

    expect(dir).toBe('/ram/subs/rp/parent-abc/subagents');
  });
});

describe('retainMs', () => {
  test('positive days → ms', () => {
    expect(retainMs(1)).toBe(86_400_000);
  });

  test('zero / negative / non-finite → 0', () => {
    expect(retainMs(0)).toBe(0);
    expect(retainMs(-5)).toBe(0);
    expect(retainMs(NaN)).toBe(0);
  });
});

function makeSweepFs(tree: Record<string, { name: string; mtimeMs: number; kind: 'file' | 'dir' }[]>): SweepFs {
  const removed = new Set<string>();
  return {
    readdir: (path) => {
      if (removed.has(path)) return null;
      const entries = tree[path];
      return entries ? entries.map((e) => e.name) : null;
    },
    stat: (path) => {
      if (removed.has(path)) return null;
      const parent = path.slice(0, path.lastIndexOf('/'));
      const name = path.slice(path.lastIndexOf('/') + 1);
      // directory self-lookup
      if (tree[path]) return { mtimeMs: 0, isFile: false, isDirectory: true };
      const entries = tree[parent];
      const hit = entries?.find((e) => e.name === name);
      if (!hit) return null;
      return {
        mtimeMs: hit.mtimeMs,
        isFile: hit.kind === 'file',
        isDirectory: hit.kind === 'dir',
      };
    },
    remove: (path) => {
      removed.add(path);
      return true;
    },
  };
}

describe('sweepStaleSessions', () => {
  test('removes .jsonl files older than retainDays', () => {
    const now = Date.now();
    const stale = now - 40 * 24 * 60 * 60 * 1000;
    const fresh = now - 1 * 24 * 60 * 60 * 1000;
    const tree: Record<string, { name: string; mtimeMs: number; kind: 'file' | 'dir' }[]> = {
      '/root': [{ name: '--mnt-d-proj--', mtimeMs: now, kind: 'dir' }],
      '/root/--mnt-d-proj--': [{ name: 'parent-abc', mtimeMs: now, kind: 'dir' }],
      '/root/--mnt-d-proj--/parent-abc': [{ name: 'subagents', mtimeMs: now, kind: 'dir' }],
      '/root/--mnt-d-proj--/parent-abc/subagents': [
        { name: 'old.jsonl', mtimeMs: stale, kind: 'file' },
        { name: 'new.jsonl', mtimeMs: fresh, kind: 'file' },
        { name: 'README.txt', mtimeMs: stale, kind: 'file' },
      ],
    };
    const result = sweepStaleSessions('/root', 30, makeSweepFs(tree));

    expect(result.scanned).toBe(2); // ignored README.txt
    expect(result.removed).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test('zero retainDays is a no-op (cache disabled)', () => {
    const result = sweepStaleSessions('/root', 0, makeSweepFs({}));

    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
  });

  test('missing root is silent', () => {
    const result = sweepStaleSessions('/nonexistent', 30, makeSweepFs({}));

    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
  });
});

describe('sweepStaleSessionsFlat', () => {
  test('removes stale .jsonl under <base>/<sid>/subagents (depth-1)', () => {
    const now = Date.now();
    const stale = now - 40 * 24 * 60 * 60 * 1000;
    const fresh = now - 1 * 24 * 60 * 60 * 1000;
    const tree: Record<string, { name: string; mtimeMs: number; kind: 'file' | 'dir' }[]> = {
      // base contains pi's own main transcript (a file) + a <sid> dir.
      '/repo/.pi/sessions': [
        { name: '2026-01-01_main.jsonl', mtimeMs: stale, kind: 'file' },
        { name: 'parent-abc', mtimeMs: now, kind: 'dir' },
      ],
      '/repo/.pi/sessions/parent-abc': [{ name: 'subagents', mtimeMs: now, kind: 'dir' }],
      '/repo/.pi/sessions/parent-abc/subagents': [
        { name: 'old.jsonl', mtimeMs: stale, kind: 'file' },
        { name: 'new.jsonl', mtimeMs: fresh, kind: 'file' },
      ],
    };
    const result = sweepStaleSessionsFlat('/repo/.pi/sessions', 30, makeSweepFs(tree));

    // Only the stale child transcript is counted/removed; the main
    // transcript sitting directly in base is a file, never descended into.
    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test('zero retainDays is a no-op', () => {
    expect(sweepStaleSessionsFlat('/repo/.pi/sessions', 0, makeSweepFs({})).removed).toBe(0);
  });

  test('missing base is silent', () => {
    expect(sweepStaleSessionsFlat('/nope', 30, makeSweepFs({})).scanned).toBe(0);
  });
});

describe('listStaleWorktrees', () => {
  test('returns only directories matching the pi-subagent-* prefix', () => {
    const tree: Record<string, { name: string; mtimeMs: number; kind: 'file' | 'dir' }[]> = {
      '/repo/.git/worktrees': [
        { name: `${STALE_WORKTREE_PREFIX}abc`, mtimeMs: 0, kind: 'dir' },
        { name: 'feature-x', mtimeMs: 0, kind: 'dir' },
        { name: `${STALE_WORKTREE_PREFIX}file`, mtimeMs: 0, kind: 'file' },
      ],
    };
    const out = listStaleWorktrees('/repo', makeSweepFs(tree));

    expect(out).toEqual(['/repo/.git/worktrees/pi-subagent-abc']);
  });

  test('missing worktrees dir returns empty list', () => {
    expect(listStaleWorktrees('/nothing', makeSweepFs({}))).toEqual([]);
  });
});
