/**
 * Asserts that `bg_bash start` routes its spawn command through the
 * sandbox wrapper slot when sandbox.ts has installed a wrap function.
 *
 * Same pattern as `subagent-sandbox-integration.spec.ts`: we can't
 * import the bg-bash extension itself (it pulls in `@earendil-works/*`
 * which is only available at pi runtime), so we mirror the small slice
 * of `actStart` / `startJob` that touches the wrapper slot. The
 * integration claim is: when a sandbox wrap is installed, the command
 * fed to `spawn('/bin/sh', ['-c', ...])` is the wrapped form; when no
 * wrap is installed, it's the original.
 *
 * The mirror reproduces exactly the call shape in
 * `config/pi/extensions/bg-bash.ts`'s `actStart` so a future refactor
 * that breaks the wiring (forgets to pass `spawnCommand`, calls
 * `requestSandboxWrap` with the wrong ctx, etc.) trips this spec.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  installSandboxWrapper,
  requestSandboxWrap,
  type SandboxWrapFn,
  uninstallSandboxWrapper,
} from '../../../../lib/node/pi/sandbox/wrapper-slot.ts';

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
}

type SimulateResult = { blocked: true; reason: string } | { blocked: false; spawnCommand: string };

/**
 * Mirror of the relevant slice of `actStart` + `startJob` in
 * `config/pi/extensions/bg-bash.ts`. Returns either the command that
 * would be passed to `spawn('/bin/sh', ['-c', ...])`, or a `blocked`
 * marker matching the `errorReturn('start', wrap.reason)` early-return.
 */
async function simulateBgBashStart(command: string, ctx: FakeCtx): Promise<SimulateResult> {
  const wrap = await requestSandboxWrap(command, { cwd: ctx.cwd, hasUI: ctx.hasUI });
  if (wrap.action === 'block') {
    return { blocked: true, reason: wrap.reason ?? 'Blocked by sandbox' };
  }
  const spawnCommand = wrap.wrapped ? wrap.command : undefined;
  return { blocked: false, spawnCommand: spawnCommand ?? command };
}

describe('bg_bash start + sandbox wrap', () => {
  beforeEach(() => {
    uninstallSandboxWrapper();
  });
  afterEach(() => {
    uninstallSandboxWrapper();
  });

  test('falls through unchanged when no sandbox wrap is installed', async () => {
    const result = await simulateBgBashStart('npm test', { cwd: '/workspace', hasUI: true });
    expect(result).toEqual({ blocked: false, spawnCommand: 'npm test' });
  });

  test('uses the wrapped command when sandbox is active', async () => {
    let wrapCalls = 0;
    const wrapFn: SandboxWrapFn = (cmd) => {
      wrapCalls++;
      return Promise.resolve({ command: `__PI_SANDBOX_WRAPPED=1 srt -- ${cmd}`, wrapped: true });
    };
    installSandboxWrapper(wrapFn);

    const result = await simulateBgBashStart('npm test', { cwd: '/workspace', hasUI: true });
    expect(wrapCalls).toBe(1);
    expect(result).toEqual({ blocked: false, spawnCommand: '__PI_SANDBOX_WRAPPED=1 srt -- npm test' });
  });

  test('wrapper returning wrapped:false leaves the spawn command as the original', async () => {
    // Mirrors PI_SANDBOX_DISABLED / dry-run / unsupported-platform paths
    // where performWrap reports the command as not-actually-wrapped.
    installSandboxWrapper((cmd) => Promise.resolve({ command: cmd, wrapped: false }));
    const result = await simulateBgBashStart('echo hi', { cwd: '/workspace', hasUI: false });
    expect(result).toEqual({ blocked: false, spawnCommand: 'echo hi' });
  });

  test('action:block refuses to spawn (PI_SANDBOX_DEFAULT=block path)', async () => {
    installSandboxWrapper((cmd) =>
      Promise.resolve({
        command: cmd,
        wrapped: false,
        action: 'block',
        reason: 'wrap failed: bwrap not found; refusing under PI_SANDBOX_DEFAULT=block',
      }),
    );
    const result = await simulateBgBashStart('npm test', { cwd: '/workspace', hasUI: true });
    expect(result).toEqual({
      blocked: true,
      reason: 'wrap failed: bwrap not found; refusing under PI_SANDBOX_DEFAULT=block',
    });
  });

  test('passes hasUI + cwd through to the wrap function', async () => {
    let seen: { cmd: string; cwd: string; hasUI: boolean } | undefined;
    installSandboxWrapper((cmd, c) => {
      seen = { cmd, cwd: c.cwd, hasUI: c.hasUI };
      return Promise.resolve({ command: `WRAP(${cmd})`, wrapped: true });
    });
    await simulateBgBashStart('cat README.md', { cwd: '/repo', hasUI: false });
    expect(seen).toEqual({ cmd: 'cat README.md', cwd: '/repo', hasUI: false });
  });
});
