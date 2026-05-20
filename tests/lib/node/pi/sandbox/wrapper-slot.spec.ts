/**
 * Tests for lib/node/pi/sandbox/wrapper-slot.ts.
 *
 * Mirrors the bash-gate test shape since the contracts mirror.
 */

import { afterEach, describe, expect, test } from 'vitest';

import {
  installSandboxWrapper,
  isSandboxWrapperInstalled,
  requestSandboxWrap,
  uninstallSandboxWrapper,
} from '../../../../../lib/node/pi/sandbox/wrapper-slot.ts';

afterEach(() => {
  uninstallSandboxWrapper();
});

const ctx = { hasUI: true, cwd: '/repo' };

describe('wrapper-slot', () => {
  test('no wrapper installed → identity wrap, wrapped: false', async () => {
    const result = await requestSandboxWrap('git status', ctx);
    expect(result).toEqual({ command: 'git status', wrapped: false });
    expect(isSandboxWrapperInstalled()).toBe(false);
  });

  test('installSandboxWrapper rewrites the command', async () => {
    installSandboxWrapper((cmd) => Promise.resolve({ command: `srt -- ${cmd}`, wrapped: true }));
    const result = await requestSandboxWrap('git status', ctx);
    expect(result).toEqual({ command: 'srt -- git status', wrapped: true });
    expect(isSandboxWrapperInstalled()).toBe(true);
  });

  test('uninstallSandboxWrapper restores identity behaviour', async () => {
    installSandboxWrapper(() => Promise.resolve({ command: 'WRAPPED', wrapped: true }));
    uninstallSandboxWrapper();
    expect(isSandboxWrapperInstalled()).toBe(false);
    const result = await requestSandboxWrap('echo hi', ctx);
    expect(result.wrapped).toBe(false);
    expect(result.command).toBe('echo hi');
  });

  test('double-install: last writer wins', async () => {
    installSandboxWrapper(() => Promise.resolve({ command: 'A', wrapped: true }));
    installSandboxWrapper(() => Promise.resolve({ command: 'B', wrapped: true }));
    const result = await requestSandboxWrap('cmd', ctx);
    expect(result.command).toBe('B');
  });

  test('wrapper receives the original ctx', async () => {
    let seenCtx: typeof ctx | undefined;
    installSandboxWrapper((cmd, c) => {
      seenCtx = c;
      return Promise.resolve({ command: cmd, wrapped: true });
    });
    await requestSandboxWrap('cmd', ctx);
    expect(seenCtx).toEqual(ctx);
  });

  test('singleton symbol stable across modules', () => {
    // Mirror of the bash-gate spec: import the same module twice and
    // verify both copies see the slot. Vitest dedupes but we still
    // assert that `Symbol.for(...)` is the singleton anchor.
    const slotKey = Symbol.for('@dotfiles/pi/sandbox/wrapper');
    expect(typeof slotKey).toBe('symbol');
    installSandboxWrapper(() => Promise.resolve({ command: 'X', wrapped: true }));
    const g = globalThis as unknown as Record<symbol, unknown>;
    expect(g[slotKey]).toBeDefined();
  });
});
