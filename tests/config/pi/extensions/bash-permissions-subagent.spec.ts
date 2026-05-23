/**
 * Tests that the parent's bash gate fires on a child (subagent)
 * `tool_call` event, by exercising the integration contract used by
 * `bashPermissionsFactoryHookOnly` in
 * `config/pi/extensions/bash-permissions.ts`.
 *
 * The factory itself is a thin adapter:
 *
 *   pi.on('tool_call', (event, ctx) => {
 *     if (event.toolName !== 'bash') return undefined;
 *     return await requestBashApproval(command, ctx)
 *       → block when denied, allow otherwise.
 *   });
 *
 * Phase 2 of the sandbox-runtime extension installs that adapter into
 * every spawned subagent via `subagent-extension-injection.ts`. The
 * adapter runs against the parent's installed gate (the gate function
 * lives in the bash-gate slot, populated by `bash-permissions.ts` on
 * extension load), so a child's bash call inherits the parent's
 * session rules / hardcoded denylist / persona vouch / `bash-auto`
 * state.
 *
 * This spec sits under `tests/config/pi/extensions/` to document the
 * extension behaviour, but - per the project convention - only drives
 * the underlying pure lib helpers (`bash-gate.ts`). The hook-only
 * factory is mirrored inline so the spec runs without a pi runtime.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type BashGateContext,
  type BashGateDecision,
  type BashGateFn,
  installBashGate,
  isBashGateInstalled,
  requestBashApproval,
  uninstallBashGate,
} from '../../../../lib/node/pi/bash/gate.ts';

// ──────────────────────────────────────────────────────────────────────
// Stand-ins for pi's runtime types
// ──────────────────────────────────────────────────────────────────────

interface FakeToolCallEvent {
  toolName: string;
  input?: { command?: unknown };
}

type FakeToolCallHandler = (
  event: FakeToolCallEvent,
  ctx: BashGateContext,
) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined;

interface FakeExtensionAPI {
  on(event: 'tool_call', handler: FakeToolCallHandler): void;
}

/** Mirror of `bashPermissionsFactoryHookOnly` in
 *  `config/pi/extensions/bash-permissions.ts`. Kept in the spec so the
 *  test can run without the extension shell (which imports pi types
 *  the lib-side test environment does not have). The behaviour MUST
 *  match the real factory; if the factory grows new branches, mirror
 *  them here. */
function bashPermissionsFactoryHookOnly(pi: FakeExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const rawCmd = (event.input as { command?: unknown } | undefined)?.command;
    const command = (typeof rawCmd === 'string' ? rawCmd : '').trim();
    if (!command) return undefined;
    const decision = await requestBashApproval(command, ctx);
    if (decision.allowed) return undefined;
    return { block: true, reason: decision.reason };
  });
}

interface FakeChildSession {
  fire(event: FakeToolCallEvent, ctx: BashGateContext): Promise<{ block: true; reason: string } | undefined>;
}

/** Build a minimal "child session" that records the handler the
 *  hook-only factory installs and lets the test fire `tool_call`
 *  events at it. Mirrors how a real subagent's `ExtensionAPI` would
 *  collect the factory's `pi.on('tool_call', …)` registration. */
function buildChildSessionAndMount(): FakeChildSession {
  let installed: FakeToolCallHandler | undefined;
  const api: FakeExtensionAPI = {
    on(event, handler) {
      if (event === 'tool_call') installed = handler;
    },
  };
  bashPermissionsFactoryHookOnly(api);
  return {
    async fire(event, ctx) {
      if (!installed) throw new Error('hook-only factory did not register a tool_call handler');
      const r = await installed(event, ctx);
      return r ?? undefined;
    },
  };
}

function makeChildCtx(overrides: Partial<BashGateContext> = {}): BashGateContext {
  return {
    hasUI: false,
    cwd: '/tmp/child',
    ui: {
      select: vi.fn<BashGateContext['ui']['select']>(),
      input: vi.fn<BashGateContext['ui']['input']>(),
      notify: vi.fn<BashGateContext['ui']['notify']>(),
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Specs
// ──────────────────────────────────────────────────────────────────────

describe('bash-permissions hook-only factory + parent gate', () => {
  beforeEach(() => {
    uninstallBashGate();
  });
  afterEach(() => {
    uninstallBashGate();
  });

  test('child bash call hits the parent gate function', async () => {
    const calls: { command: string; cwd: string }[] = [];
    const parentGate: BashGateFn = (command, ctx) => {
      calls.push({ command, cwd: ctx.cwd });
      return Promise.resolve<BashGateDecision>({ allowed: true });
    };
    installBashGate(parentGate);
    expect(isBashGateInstalled()).toBe(true);

    const child = buildChildSessionAndMount();
    const r = await child.fire({ toolName: 'bash', input: { command: ' git status ' } }, makeChildCtx());

    // Trimmed before being passed to the gate (parity with the parent
    // extension's `tool_call` handler).
    expect(calls).toEqual([{ command: 'git status', cwd: '/tmp/child' }]);
    // Allowed path returns undefined to let the call proceed.
    expect(r).toBeUndefined();
  });

  test('child bash call is blocked when the parent gate denies', async () => {
    installBashGate(() =>
      Promise.resolve<BashGateDecision>({
        allowed: false,
        reason: 'No UI available for approval. Unknown command(s):\n  rm -rf /',
      }),
    );

    const child = buildChildSessionAndMount();
    const r = await child.fire({ toolName: 'bash', input: { command: 'rm -rf /' } }, makeChildCtx());

    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toMatch(/Unknown command\(s\)/);
  });

  test('non-bash tool calls are passthrough (factory only intercepts bash)', async () => {
    const gate = vi.fn<BashGateFn>().mockResolvedValue({ allowed: false, reason: 'should not fire' });
    installBashGate(gate);

    const child = buildChildSessionAndMount();
    const r = await child.fire({ toolName: 'read', input: { command: 'whatever' } }, makeChildCtx());

    expect(r).toBeUndefined();
    expect(gate).not.toHaveBeenCalled();
  });

  test('empty / whitespace bash command is passthrough (no spurious gate calls)', async () => {
    const gate = vi.fn<BashGateFn>().mockResolvedValue({ allowed: true });
    installBashGate(gate);

    const child = buildChildSessionAndMount();
    expect(await child.fire({ toolName: 'bash', input: { command: '' } }, makeChildCtx())).toBeUndefined();
    expect(await child.fire({ toolName: 'bash', input: { command: '   ' } }, makeChildCtx())).toBeUndefined();
    expect(await child.fire({ toolName: 'bash', input: {} }, makeChildCtx())).toBeUndefined();

    expect(gate).not.toHaveBeenCalled();
  });

  test('with no parent gate installed, child bash call is allowed (matches built-in fallback)', async () => {
    // Parent extension never loaded (or PI_BASH_PERMISSIONS_DISABLED=1)
    // → no gate slot. requestBashApproval falls back to {allowed: true}.
    expect(isBashGateInstalled()).toBe(false);

    const child = buildChildSessionAndMount();
    const r = await child.fire({ toolName: 'bash', input: { command: 'cat secret' } }, makeChildCtx());

    expect(r).toBeUndefined();
  });
});
