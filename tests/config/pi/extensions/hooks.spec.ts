/**
 * Tests for `config/pi/extensions/hooks.ts` - the user hook system.
 *
 * Sits under `tests/config/pi/extensions/` to document the extension
 * contract, but - per project convention - only drives the underlying
 * pure lib helpers (`hooks/config.ts`, `hooks/matcher.ts`,
 * `hooks/runner.ts`). The extension's `tool_call` handler is mirrored
 * inline (same tactic as `bash-permissions-subagent.spec.ts` /
 * `filesystem.spec.ts` / `sandbox.spec.ts`) so the spec runs without a
 * pi runtime - which is not installed on the test path.
 *
 * Plan: phase 2 of `plans/pi-cc-parity.md`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type Hook, loadHooks } from '../../../../lib/node/pi/hooks/config.ts';
import { matchesMatcher } from '../../../../lib/node/pi/hooks/matcher.ts';
import {
  type HookSpawnFn,
  type HookSpawnOptions,
  type HookSpawnResult,
  runHook,
} from '../../../../lib/node/pi/hooks/runner.ts';

// ──────────────────────────────────────────────────────────────────────
// Stand-ins for pi's runtime types
// ──────────────────────────────────────────────────────────────────────

interface FakeToolCallEvent {
  toolName: string;
  input?: unknown;
}

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
}

type FakeToolCallResult = { block: true; reason: string } | undefined;

type FakeToolCallHandler = (event: FakeToolCallEvent, ctx: FakeCtx) => Promise<FakeToolCallResult>;

interface FakeExtensionAPI {
  on(event: 'tool_call', handler: FakeToolCallHandler): void;
}

/**
 * Mirror of the `tool_call` (= PreToolUse) wiring in
 * `config/pi/extensions/hooks.ts`. Kept in the spec so the test can
 * run without the extension shell (which imports `@earendil-works/…`
 * types unavailable in the test path). If the real factory grows new
 * branches inside the PreToolUse loop, mirror them here.
 *
 * Decision semantics per the plan's "Hook response" section:
 *   - block    → tool error with `reason`, short-circuit.
 *   - allow    → skip remaining hooks for this event.
 *   - continue → run the next hook; tool proceeds if all return continue.
 */
function preToolUseFactoryMirror(pi: FakeExtensionAPI, spawnFn: HookSpawnFn, home: string): void {
  pi.on('tool_call', async (event, ctx) => {
    const candidates = loadHooks({ cwd: ctx.cwd, home }).PreToolUse.filter((h) =>
      matchesMatcher(h.matcher, event.toolName),
    );
    if (candidates.length === 0) return undefined;

    const controller = new AbortController();
    try {
      for (const hook of candidates) {
        const payload = {
          event: 'PreToolUse',
          tool: event.toolName,
          input: event.input,
          cwd: ctx.cwd,
          session_id: 'test-session',
        };
        // oxlint-disable-next-line no-await-in-loop -- hooks fire sequentially so the first `block` can short-circuit the remainder
        const result = await runHook({ hook, payload, signal: controller.signal, cwd: ctx.cwd, spawnFn });
        if (result.decision === 'block') {
          return { block: true, reason: result.reason ?? `Blocked by PreToolUse hook ${hook.command}` };
        }
        if (result.decision === 'allow') return undefined;
        // continue → next hook
      }
      return undefined;
    } finally {
      controller.abort();
    }
  });
}

function buildSession(
  spawnFn: HookSpawnFn,
  home: string,
): {
  fire(event: FakeToolCallEvent, ctx: FakeCtx): Promise<FakeToolCallResult>;
} {
  let installed: FakeToolCallHandler | undefined;
  const api: FakeExtensionAPI = {
    on(event, handler) {
      if (event === 'tool_call') installed = handler;
    },
  };
  preToolUseFactoryMirror(api, spawnFn, home);
  return {
    async fire(event, ctx) {
      if (!installed) throw new Error('factory did not register a tool_call handler');
      return installed(event, ctx);
    },
  };
}

function makeSpawn(perCommand: Record<string, Partial<HookSpawnResult>>): HookSpawnFn {
  const fn = (opts: HookSpawnOptions): Promise<HookSpawnResult> => {
    const base: HookSpawnResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    const override = perCommand[opts.command] ?? {};
    return Promise.resolve({ ...base, ...override });
  };
  return vi.fn(fn);
}

// ──────────────────────────────────────────────────────────────────────
// Specs
// ──────────────────────────────────────────────────────────────────────

describe('hooks extension - PreToolUse wiring', () => {
  let tmpCwd: string;
  let homeBackup: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'pi-hooks-cwd-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'pi-hooks-home-'));
    // Redirect user-layer reads at an empty temp dir so a real
    // ~/.pi/hooks.json on the host machine can't contaminate the test.
    homeBackup = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (homeBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup;
  });

  function writeProjectHooks(hooks: { PreToolUse: Partial<Hook>[] }): void {
    const dir = join(tmpCwd, '.pi');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }, null, 2), 'utf8');
  }

  test('PreToolUse hook returning `block` short-circuits with the right reason', async () => {
    writeProjectHooks({
      PreToolUse: [{ matcher: 'bash', command: '/h/block.sh' }],
    });
    const spawn = makeSpawn({
      '/h/block.sh': {
        stdout: JSON.stringify({ decision: 'block', reason: 'no bash for you' }),
      },
    });
    const session = buildSession(spawn, fakeHome);

    const r = await session.fire({ toolName: 'bash', input: { command: 'ls' } }, { cwd: tmpCwd, hasUI: false });

    expect(r).toEqual({ block: true, reason: 'no bash for you' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('PreToolUse `continue` falls through (tool proceeds, undefined result)', async () => {
    writeProjectHooks({
      PreToolUse: [{ matcher: 'bash', command: '/h/log.sh' }],
    });
    const spawn = makeSpawn({
      // Empty stdout → continue per `parseHookStdout`.
      '/h/log.sh': { stdout: '' },
    });
    const session = buildSession(spawn, fakeHome);

    const r = await session.fire({ toolName: 'bash', input: { command: 'ls' } }, { cwd: tmpCwd, hasUI: false });

    expect(r).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('matcher mismatch skips the hook entirely (no spawn)', async () => {
    writeProjectHooks({
      PreToolUse: [{ matcher: 'edit', command: '/h/edit-only.sh' }],
    });
    const spawn = makeSpawn({});
    const session = buildSession(spawn, fakeHome);

    const r = await session.fire({ toolName: 'bash', input: { command: 'ls' } }, { cwd: tmpCwd, hasUI: false });

    expect(r).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('multiple hooks: first `block` short-circuits remaining hooks', async () => {
    writeProjectHooks({
      PreToolUse: [
        { matcher: '*', command: '/h/blocker.sh' },
        { matcher: '*', command: '/h/should-not-run.sh' },
      ],
    });
    const spawn = makeSpawn({
      '/h/blocker.sh': {
        stdout: JSON.stringify({ decision: 'block', reason: 'nope' }),
      },
      '/h/should-not-run.sh': { stdout: 'irrelevant' },
    });
    const session = buildSession(spawn, fakeHome);

    const r = await session.fire({ toolName: 'bash', input: {} }, { cwd: tmpCwd, hasUI: false });

    expect(r).toEqual({ block: true, reason: 'nope' });
    // Verify the second hook was never invoked.
    const spawnFn = spawn as unknown as { mock: { calls: { 0: { command: string } }[] } };
    const commands = spawnFn.mock.calls.map((c) => c[0].command);
    expect(commands).toEqual(['/h/blocker.sh']);
  });
});
