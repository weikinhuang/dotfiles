/**
 * Tests for lib/node/pi/hooks/config.ts.
 *
 * The user-layer path is fixed at `~/.pi/hooks.json` by the module,
 * so most disk-based tests inject the `userHooks` override and only
 * the project layer is exercised against actual files (in a temp
 * cwd). The malformed-file warning-dedup test goes through the real
 * `loadJsoncConfigOrFallback` path so the dedup behavior is real.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { type Hook, HOOK_EVENTS, loadHooks, parseHooksLayer } from '../../../../../lib/node/pi/hooks/config.ts';

function mkTempCwd(): string {
  return mkdtempSync(join(tmpdir(), 'pi-hooks-test-'));
}

function writeProjectHooks(cwd: string, body: string): string {
  const dir = join(cwd, '.pi');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'hooks.json');
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('parseHooksLayer', () => {
  test('tolerates // line comments and /* */ block comments', () => {
    const raw = `{
      // top-level comment
      "hooks": {
        /* block
           comment */
        "PreToolUse": [
          { "matcher": "bash", "command": "~/h.sh" /* trailing */ }
        ]
      }
    }`;
    const parsed = parseHooksLayer(raw, 'user');
    expect(parsed.PreToolUse).toHaveLength(1);
    expect(parsed.PreToolUse[0].command).toBe('~/h.sh');
    expect(parsed.PreToolUse[0].matcher).toBe('bash');
    expect(parsed.PreToolUse[0].scope).toBe('user');
  });

  test('fixture covering every event type', () => {
    const raw = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'bash', command: '/pre.sh' }],
        PostToolUse: [{ matcher: 'edit', command: '/post.sh', timeout: 1234 }],
        UserPromptSubmit: [{ command: '/prompt.sh' }],
        Stop: [{ command: '/stop.sh' }],
        SessionStart: [{ command: '/start.sh', sandboxed: true }],
      },
    });
    const parsed = parseHooksLayer(raw, 'project');
    for (const event of HOOK_EVENTS) {
      expect(parsed[event]).toHaveLength(1);
      expect(parsed[event][0].scope).toBe('project');
    }
    expect(parsed.PostToolUse[0].timeout).toBe(1234);
    expect(parsed.SessionStart[0].sandboxed).toBe(true);
  });

  test('malformed entries are silently dropped, well-formed ones survive', () => {
    const raw = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'bash' /* no command */ },
          { command: '' /* empty command */ },
          { command: '/ok.sh' },
          { command: '/bad-timeout.sh', timeout: 'soon' },
          { command: '/bad-timeout.sh', timeout: -1 },
          { command: '/bad-sandboxed.sh', sandboxed: 'yes' },
          { matcher: 42, command: '/x.sh' },
        ],
        UnknownEvent: [{ command: '/ignored.sh' }],
      },
    });
    const parsed = parseHooksLayer(raw, 'user');
    expect(parsed.PreToolUse.map((h) => h.command)).toEqual(['/ok.sh']);
  });

  test('empty / non-object top-level returns empty config', () => {
    expect(parseHooksLayer('', 'user').PreToolUse).toEqual([]);
    expect(parseHooksLayer('[1,2,3]', 'user').PreToolUse).toEqual([]);
    expect(parseHooksLayer('"a string"', 'user').PreToolUse).toEqual([]);
  });

  test('totally malformed JSONC returns empty config (no throw)', () => {
    expect(parseHooksLayer('{ not json', 'user').PreToolUse).toEqual([]);
  });
});

describe('loadHooks (three-layer merge)', () => {
  test('session, project, user merge in that order', () => {
    const cwd = mkTempCwd();
    const session: Hook = { command: '/session.sh', scope: 'session' };
    const project: Hook = { command: '/project.sh', scope: 'project' };
    const user: Hook = { command: '/user.sh', scope: 'user' };
    const merged = loadHooks({
      cwd,
      sessionHooks: { PreToolUse: [session] },
      projectHooks: { PreToolUse: [project] },
      userHooks: { PreToolUse: [user] },
    });
    expect(merged.PreToolUse.map((h) => h.command)).toEqual(['/session.sh', '/project.sh', '/user.sh']);
    expect(merged.PreToolUse.map((h) => h.scope)).toEqual(['session', 'project', 'user']);
  });

  test('session overrides force scope to "session" even if the input lied', () => {
    const cwd = mkTempCwd();
    const merged = loadHooks({
      cwd,
      sessionHooks: { PreToolUse: [{ command: '/x.sh', scope: 'user' }] },
      projectHooks: {},
      userHooks: {},
    });
    expect(merged.PreToolUse[0].scope).toBe('session');
  });

  test('reads project layer from disk', () => {
    const cwd = mkTempCwd();
    writeProjectHooks(
      cwd,
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'edit', command: '/disk-project.sh' }] } }),
    );
    const merged = loadHooks({ cwd, userHooks: {} });
    expect(merged.PostToolUse).toHaveLength(1);
    expect(merged.PostToolUse[0].command).toBe('/disk-project.sh');
    expect(merged.PostToolUse[0].scope).toBe('project');
  });

  test('missing project file is silent (no warning)', () => {
    const cwd = mkTempCwd();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const merged = loadHooks({ cwd, userHooks: {} });
      for (const event of HOOK_EVENTS) {
        expect(merged[event]).toEqual([]);
      }
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('loadHooks: malformed-file warning dedup', () => {
  test('one warn per unique path+error, even across multiple loads', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const cwd = mkTempCwd();
      writeProjectHooks(cwd, '{ not json ');

      loadHooks({ cwd, userHooks: {} });
      loadHooks({ cwd, userHooks: {} });
      loadHooks({ cwd, userHooks: {} });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('[hooks]');
      expect(message).toContain('hooks.json');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('two distinct malformed paths each warn once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const cwd1 = mkTempCwd();
      const cwd2 = mkTempCwd();
      writeProjectHooks(cwd1, '{ bad ');
      writeProjectHooks(cwd2, '{ also bad ');

      loadHooks({ cwd: cwd1, userHooks: {} });
      loadHooks({ cwd: cwd2, userHooks: {} });
      loadHooks({ cwd: cwd1, userHooks: {} });
      loadHooks({ cwd: cwd2, userHooks: {} });

      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
