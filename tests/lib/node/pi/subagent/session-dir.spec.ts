import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createPersistedSubagentSessionManager,
  resolveSubagentSessionDir,
  type ParentSessionManagerLike,
} from '../../../../../lib/node/pi/subagent/session-dir.ts';

function fakeParent(opts: {
  id?: string | undefined;
  dir?: string | undefined;
  throwOn?: 'id' | 'dir';
}): ParentSessionManagerLike {
  return {
    getSessionId(): string | undefined {
      if (opts.throwOn === 'id') throw new Error('boom-id');
      return opts.id;
    },
    getSessionDir(): string | undefined {
      if (opts.throwOn === 'dir') throw new Error('boom-dir');
      return opts.dir;
    },
  };
}

describe('resolveSubagentSessionDir', () => {
  test('returns <parentSessionDir>/<parentSessionId>/subagents (Claude Code layout)', () => {
    const dir = resolveSubagentSessionDir({
      parentSessionManager: fakeParent({
        id: 'a96eceb594d0613b0',
        dir: '/Users/x/.pi/agent/sessions/-Users-x--repo',
      }),
      extensionLabel: 'deep-research',
    });

    expect(dir).toBe('/Users/x/.pi/agent/sessions/-Users-x--repo/a96eceb594d0613b0/subagents');
  });

  test('does NOT use the legacy <parentSessionDir>/subagents/<parentSessionId> ordering', () => {
    // Regression guard for the pre-Claude-mirror layout.
    const dir = resolveSubagentSessionDir({
      parentSessionManager: fakeParent({ id: 'sid', dir: '/p' }),
      extensionLabel: 'deep-research',
    });

    expect(dir).not.toBe('/p/subagents/sid');
    expect(dir).toBe('/p/sid/subagents');
  });

  test('throws with extensionLabel when getSessionId throws', () => {
    expect(() =>
      resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ throwOn: 'id', dir: '/p' }),
        extensionLabel: 'iteration-loop',
      }),
    ).toThrow(/^iteration-loop: cannot persist subagent session.*boom-id/);
  });

  test('throws with extensionLabel when getSessionDir throws', () => {
    expect(() =>
      resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: 'sid', throwOn: 'dir' }),
        extensionLabel: 'deep-research',
      }),
    ).toThrow(/^deep-research: cannot persist subagent session.*boom-dir/);
  });

  test('throws when parent session has no id (e.g. pi --no-session)', () => {
    expect(() =>
      resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: undefined, dir: '/p' }),
        extensionLabel: 'deep-research',
      }),
    ).toThrow(/no id\/dir.*--no-session/);
  });

  test('throws when parent session has no dir', () => {
    expect(() =>
      resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: 'sid', dir: undefined }),
        extensionLabel: 'deep-research',
      }),
    ).toThrow(/no id\/dir/);
  });

  test('throws when parent session has empty id (treats "" as missing)', () => {
    expect(() =>
      resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: '', dir: '/p' }),
        extensionLabel: 'deep-research',
      }),
    ).toThrow(/no id\/dir/);
  });

  describe('honours PI_SUBAGENT_SESSION_ROOT / _SLUG (delegates to childSessionDir)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test('PI_SUBAGENT_SESSION_ROOT redirects the base, bucketed by workspace slug', () => {
      // Regression: session-dir previously hardcoded join(parentDir, id,
      // 'subagents') and ignored the env root that session-paths honours,
      // so one-shot children (critic, deep-research) wrote to a DIFFERENT
      // tree than the subagent extension.
      vi.stubEnv('PI_SUBAGENT_SESSION_ROOT', '/ram/subs');
      const dir = resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: 'sid', dir: '/agent/sessions/--slug--' }),
        extensionLabel: 'deep-research',
        parentCwd: '/mnt/d/proj',
      });

      expect(dir).toBe('/ram/subs/--mnt-d-proj--/sid/subagents');
    });

    test('PI_SUBAGENT_SESSION_SLUG pins the slug regardless of cwd', () => {
      vi.stubEnv('PI_SUBAGENT_SESSION_ROOT', '/ram/subs');
      vi.stubEnv('PI_SUBAGENT_SESSION_SLUG', 'rp');
      const dir = resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: 'sid', dir: '/agent/sessions/--renamed--' }),
        extensionLabel: 'deep-research',
        parentCwd: '/renamed/elsewhere',
      });

      expect(dir).toBe('/ram/subs/rp/sid/subagents');
    });

    test('no env root: base stays the parent session dir (default layout unchanged)', () => {
      const dir = resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: 'sid', dir: '/p' }),
        extensionLabel: 'deep-research',
        parentCwd: '/mnt/d/proj',
      });

      expect(dir).toBe('/p/sid/subagents');
    });
  });

  test('error message instructs the user to restart pi without --no-session', () => {
    const fn = (): string =>
      resolveSubagentSessionDir({
        parentSessionManager: fakeParent({ id: undefined, dir: undefined }),
        extensionLabel: 'deep-research',
      });

    expect(fn).toThrow(/Restart pi without --no-session/);
    expect(fn).toThrow(/audit/);
  });
});

describe('createPersistedSubagentSessionManager', () => {
  test('wraps the resolved child transcript dir with SessionManager.create', () => {
    const sessionManager = createPersistedSubagentSessionManager({
      cwd: '/repo',
      parentSessionManager: fakeParent({ id: 'sid', dir: '/sessions/project' }),
      extensionLabel: 'waveform-indicator',
      SessionManager: {
        create(cwd: string, sessionDir: string): { cwd: string; sessionDir: string } {
          return { cwd, sessionDir };
        },
      },
    });

    expect(sessionManager).toEqual({
      cwd: '/repo',
      sessionDir: '/sessions/project/sid/subagents',
    });
  });
});
