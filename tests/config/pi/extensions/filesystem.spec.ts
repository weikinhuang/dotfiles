/**
 * Tests for `config/pi/extensions/filesystem.ts` - the in-process
 * gate for `read` / `write` / `edit` tool calls.
 *
 * This spec lives under `tests/config/pi/extensions/` to document the
 * extension contract, but only drives the underlying pure lib helpers
 * (`filesystem-policy/{schema,classify,load}.ts`). The hook-only
 * factory + the no-UI fallback path are mirrored inline so the spec
 * runs without a pi runtime - same pattern as `sandbox.spec.ts`.
 *
 * Coverage:
 *
 *   - Default policy (DEFAULT_POLICY) gates the right paths.
 *   - The unified schema (deny-then-allow-back for read; allow-only
 *     for write) propagates through to classify*.
 *   - Persona writeRoots vouch: a write inside a persona writeRoot
 *     skips the gate; a read inside it does NOT.
 *   - Loader composition: user + project + persona overlay produce
 *     the expected merged policy.
 *   - Subagent hook-only factory contract: child no-UI fallback
 *     blocks unknown protected paths under default deny.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import { classifyRead, classifyWrite, expandTilde } from '../../../../lib/node/pi/filesystem-policy/classify.ts';
import { loadFilesystemPolicy } from '../../../../lib/node/pi/filesystem-policy/load.ts';
import { type FilesystemPolicy } from '../../../../lib/node/pi/filesystem-policy/schema.ts';
import { FILESYSTEM_USAGE } from '../../../../lib/node/pi/filesystem/usage.ts';
import { clearActivePersona, setActivePersona } from '../../../../lib/node/pi/persona/active.ts';

// ─────────────────────────────────────────────────────────────────
// Default policy + classify smoke (regression for the rename)
// ─────────────────────────────────────────────────────────────────

const CWD = '/repo';

// Using `loadFilesystemPolicy([], { ... })` exercises the loader the
// extension itself runs - DEFAULT_POLICY is the lowest layer.
function defaults(): FilesystemPolicy {
  return loadFilesystemPolicy([]).policy;
}

describe('filesystem command help convention (§4.4)', () => {
  test('/filesystem --help notifies FILESYSTEM_USAGE', () => {
    const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
    // Mirrors the shell's `if (isHelpArg(args)) notify(FILESYSTEM_USAGE, 'info')`.
    if (isHelpArg('--help')) notify(FILESYSTEM_USAGE, 'info');

    expect(notify).toHaveBeenCalledTimes(1);
    const [msg, level] = notify.mock.calls[0];
    expect(level).toBe('info');
    expect(msg).toBe(FILESYSTEM_USAGE);
    expect(FILESYSTEM_USAGE.length).toBeGreaterThan(0);
    expect(FILESYSTEM_USAGE).toContain('/filesystem');
  });
});

describe('filesystem default policy', () => {
  test('read.deny gates .env basenames', () => {
    const p = defaults();
    expect(classifyRead('src/.env', CWD, p)?.reason).toBe('deny-basename');
    expect(classifyRead('src/.env.local', CWD, p)?.reason).toBe('deny-basename');
    expect(classifyRead('src/.envrc', CWD, p)?.reason).toBe('deny-basename');
  });

  test('read.deny gates secret-bearing path prefixes', () => {
    const p = defaults();
    const home = expandTilde('~');
    expect(classifyRead(`${home}/.ssh/id_rsa`, CWD, p)?.reason).toBe('deny-path-prefix');
    expect(classifyRead(`${home}/.aws/credentials`, CWD, p)?.reason).toBe('deny-path-prefix');
    expect(classifyRead(`${home}/.gnupg/keyring`, CWD, p)?.reason).toBe('deny-path-prefix');
  });

  test('read does NOT block routine reads (README, src files)', () => {
    const p = defaults();
    expect(classifyRead('./README.md', CWD, p)).toBeNull();
    expect(classifyRead('./src/index.ts', CWD, p)).toBeNull();
    // Plan section 4.2: read-sensitive write entries do NOT auto-merge
    // into the read deny set.
    expect(classifyRead('./node_modules/foo/index.js', CWD, p)).toBeNull();
  });

  test('write.allow.paths covers cwd + /tmp; outside is gated', () => {
    const p = defaults();
    expect(classifyWrite('./src/x.ts', CWD, p)).toBeNull();
    expect(classifyWrite('/tmp/scratch', CWD, p)).toBeNull();
    expect(classifyWrite('/etc/hosts', CWD, p)?.reason).toBe('outside-allowed-write');
  });

  test('write.deny carves holes inside the allowed area', () => {
    const p = defaults();
    expect(classifyWrite('./.env', CWD, p)?.reason).toBe('deny-basename');
    expect(classifyWrite('./.git/config', CWD, p)?.reason).toBe('deny-segment');
    expect(classifyWrite('./.git/hooks/pre-commit', CWD, p)?.reason).toBe('deny-segment');
    // node_modules is NOT carved out by the shipped defaults anymore;
    // workspaces are write-allowed end-to-end.
    expect(classifyWrite('./node_modules/foo', CWD, p)).toBeNull();
  });

  test('read.deny union also applies to writes (anything sensitive-to-read is sensitive-to-write)', () => {
    const p = defaults();
    const home = expandTilde('~');
    // ~/.ssh is read-deny; default write.allow does NOT cover it; the
    // outer outside-allowed-write check fires first.
    expect(classifyWrite(`${home}/.ssh/id_rsa`, CWD, p)?.reason).toBe('outside-allowed-write');
  });
});

// ─────────────────────────────────────────────────────────────────
// Loader composition (user + project + persona overlay)
// ─────────────────────────────────────────────────────────────────

describe('filesystem layered loader', () => {
  beforeEach(() => {
    clearActivePersona();
  });
  afterEach(() => {
    clearActivePersona();
  });

  test('user + project layers add to the deny set without clobbering defaults', () => {
    const { policy, warnings } = loadFilesystemPolicy([
      {
        source: 'user',
        raw: JSON.stringify({
          read: { deny: { basenames: ['secrets.yml'] } },
        }),
      },
      {
        source: 'project',
        raw: JSON.stringify({
          write: { deny: { segments: ['.terraform'] } },
        }),
      },
    ]);
    expect(warnings).toEqual([]);
    // Default still applies.
    expect(classifyRead('src/.env', CWD, policy)?.reason).toBe('deny-basename');
    // User layer added secrets.yml.
    expect(classifyRead('config/secrets.yml', CWD, policy)?.reason).toBe('deny-basename');
    // Project layer added .terraform segment.
    expect(classifyWrite('infra/.terraform/state', CWD, policy)?.reason).toBe('deny-segment');
  });

  test('persona overlay merges resolved writeRoots into write.allow.paths', () => {
    const { policy } = loadFilesystemPolicy([], {
      personaOverlay: { source: 'persona:notes', paths: ['/notes'] },
    });
    // /notes was added to write.allow.paths so a write inside is fine.
    expect(classifyWrite('/notes/today.md', CWD, policy)).toBeNull();
    // Outside is still gated.
    expect(classifyWrite('/etc/hosts', CWD, policy)?.reason).toBe('outside-allowed-write');
  });

  test('malformed JSONC layer surfaces a warning and the layer is dropped', () => {
    const { policy, warnings } = loadFilesystemPolicy([{ source: 'user', raw: '{ this is not json' }]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].source).toBe('user');
    // Defaults are still applied.
    expect(classifyRead('src/.env', CWD, policy)?.reason).toBe('deny-basename');
  });

  test('read.allow allows-back inside a read.deny prefix', () => {
    const { policy } = loadFilesystemPolicy([
      {
        source: 'user',
        raw: JSON.stringify({
          read: {
            allow: { paths: ['~/.config/gh/hosts.yml'] },
          },
        }),
      },
    ]);
    const home = expandTilde('~');
    // ~/.config/gh is in DEFAULT read.deny.paths; the allow-back path
    // carves a hole for hosts.yml.
    expect(classifyRead(`${home}/.config/gh/hosts.yml`, CWD, policy)).toBeNull();
    // Other files inside ~/.config/gh remain denied.
    expect(classifyRead(`${home}/.config/gh/config`, CWD, policy)?.reason).toBe('deny-path-prefix');
  });
});

// ─────────────────────────────────────────────────────────────────
// Persona writeRoots vouch (parent-side gate)
// ─────────────────────────────────────────────────────────────────
//
// Mirror of `filesystem.ts`'s `tool_call` handler so the spec can run
// without a pi runtime. The structural fake matches the bash-permissions
// sibling spec.
// ─────────────────────────────────────────────────────────────────

import { resolve } from 'node:path';
import { getActivePersona } from '../../../../lib/node/pi/persona/active.ts';
import { isInsideWriteRoots } from '../../../../lib/node/pi/persona/match.ts';

interface FakeFsEvent {
  toolName: string;
  input?: { path?: unknown };
}

interface FakeChildCtx {
  cwd: string;
  hasUI: boolean;
}

type FakeToolCallResult = { block: true; reason: string } | undefined;

function filesystemHandlerMirror(opts: {
  policy: FilesystemPolicy;
  defaultFallback: 'allow' | 'deny';
  sessionAllow?: Set<string>;
}): (event: FakeFsEvent, ctx: FakeChildCtx) => Promise<FakeToolCallResult> {
  const { policy, defaultFallback } = opts;
  const sessionAllow = opts.sessionAllow ?? new Set<string>();

  function decide(event: FakeFsEvent, ctx: FakeChildCtx): FakeToolCallResult {
    const isRead = event.toolName === 'read';
    const isWrite = event.toolName === 'write' || event.toolName === 'edit';
    if (!isRead && !isWrite) return undefined;
    const inputPath = (typeof event.input?.path === 'string' ? event.input.path : '').trim();
    if (!inputPath) return undefined;

    const absolute = resolve(ctx.cwd, expandTilde(inputPath));
    if (sessionAllow.has(absolute)) return undefined;

    if (isWrite) {
      const active = getActivePersona();
      if (active && isInsideWriteRoots(absolute, active.resolvedWriteRoots)) return undefined;
    }

    const match = isRead ? classifyRead(inputPath, ctx.cwd, policy) : classifyWrite(inputPath, ctx.cwd, policy);
    if (!match) return undefined;

    if (!ctx.hasUI) {
      if (defaultFallback === 'allow') return undefined;
      return {
        block: true,
        reason: `No UI available for approval. Filesystem-protected path "${inputPath}" (${match.detail}).`,
      };
    }
    return undefined;
  }

  return (event, ctx) => Promise.resolve(decide(event, ctx));
}

describe('filesystem persona-vouch (writes only)', () => {
  beforeEach(() => {
    clearActivePersona();
  });
  afterEach(() => {
    clearActivePersona();
  });

  test('write inside an active persona writeRoot bypasses the gate', async () => {
    setActivePersona({
      name: 'notes',
      resolvedWriteRoots: ['/notes'],
      bashAllow: [],
      bashDeny: [],
    });
    // Persona overlay merges /notes into write.allow.paths.
    const { policy } = loadFilesystemPolicy([], {
      personaOverlay: { source: 'persona:notes', paths: ['/notes'] },
    });
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'deny' });
    const r = await handler({ toolName: 'write', input: { path: '/notes/today.md' } }, { cwd: CWD, hasUI: false });
    expect(r).toBeUndefined();
  });

  test('read inside a persona writeRoot is NOT vouched (read rules still apply)', async () => {
    setActivePersona({
      name: 'notes',
      resolvedWriteRoots: ['/notes'],
      bashAllow: [],
      bashDeny: [],
    });
    // Add a custom read.deny rule covering /notes so we can verify the
    // non-vouch.
    const { policy } = loadFilesystemPolicy([
      {
        source: 'user',
        raw: JSON.stringify({ read: { deny: { paths: ['/notes/private'] } } }),
      },
    ]);
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'deny' });
    const r = await handler(
      { toolName: 'read', input: { path: '/notes/private/diary.md' } },
      { cwd: CWD, hasUI: false },
    );
    expect(r?.block).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Hook-only factory for spawned subagents (no-UI fallback)
// ─────────────────────────────────────────────────────────────────

describe('filesystem hook-only factory + child no-UI fallback', () => {
  test('child read of .env blocks under default-deny fallback', async () => {
    const { policy } = loadFilesystemPolicy([]);
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'deny' });
    const r = await handler({ toolName: 'read', input: { path: '.env' } }, { cwd: CWD, hasUI: false });
    expect(r?.block).toBe(true);
    expect(r?.reason).toMatch(/No UI available for approval/);
  });

  test('child write outside cwd + /tmp blocks (allow-only model)', async () => {
    const { policy } = loadFilesystemPolicy([]);
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'deny' });
    const r = await handler({ toolName: 'write', input: { path: '/etc/hosts' } }, { cwd: CWD, hasUI: false });
    expect(r?.block).toBe(true);
    expect(r?.reason).toMatch(/Outside allowed write roots/);
  });

  test('child write inside cwd is allowed', async () => {
    const { policy } = loadFilesystemPolicy([]);
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'deny' });
    const r = await handler({ toolName: 'write', input: { path: './src/x.ts' } }, { cwd: CWD, hasUI: false });
    expect(r).toBeUndefined();
  });

  test('PI_FILESYSTEM_DEFAULT=allow lets unknown protected paths through (defaultFallback=allow)', async () => {
    const { policy } = loadFilesystemPolicy([]);
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'allow' });
    const r = await handler({ toolName: 'read', input: { path: '.env' } }, { cwd: CWD, hasUI: false });
    expect(r).toBeUndefined();
  });

  test('non-read/write/edit tool calls are passthrough', async () => {
    const { policy } = loadFilesystemPolicy([]);
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'deny' });
    expect(await handler({ toolName: 'bash', input: { path: '.env' } }, { cwd: CWD, hasUI: false })).toBeUndefined();
  });

  test('empty / whitespace path is passthrough', async () => {
    const { policy } = loadFilesystemPolicy([]);
    const handler = filesystemHandlerMirror({ policy, defaultFallback: 'deny' });
    expect(await handler({ toolName: 'read', input: { path: '' } }, { cwd: CWD, hasUI: false })).toBeUndefined();
    expect(await handler({ toolName: 'read', input: { path: '   ' } }, { cwd: CWD, hasUI: false })).toBeUndefined();
    expect(await handler({ toolName: 'read', input: {} }, { cwd: CWD, hasUI: false })).toBeUndefined();
  });
});
