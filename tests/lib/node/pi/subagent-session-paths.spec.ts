/**
 * Tests for lib/node/pi/subagent-session-paths.ts.
 *
 * Pure module — fs is injected.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  childSessionDir,
  listStaleWorktrees,
  retainMs,
  STALE_WORKTREE_PREFIX,
  subagentSessionRoot,
  sweepStaleSessions,
  type SweepFs,
} from '../../../../lib/node/pi/subagent-session-paths.ts';

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

describe('childSessionDir', () => {
  test('mirrors Claude Code layout: <root>/<cwd-slug>/<parentSid>/subagents', () => {
    const dir = childSessionDir({
      parentCwd: '/mnt/d/proj',
      parentSessionId: 'parent-abc',
      root: '/root',
    });

    expect(dir).toBe('/root/--mnt-d-proj--/parent-abc/subagents');
  });

  test('does NOT use the legacy <cwd-slug>/subagents/<parentSid> ordering', () => {
    const dir = childSessionDir({
      parentCwd: '/mnt/d/proj',
      parentSessionId: 'parent-abc',
      root: '/root',
    });

    expect(dir).not.toBe('/root/--mnt-d-proj--/subagents/parent-abc');
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
