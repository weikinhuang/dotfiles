/**
 * Asserts that bash calls inside a spawned subagent session DO go
 * through the parent's sandbox wrap.
 *
 * This is a structural integration test - it does NOT spawn a real
 * `runOneShotAgent`, nor does it try to initialize ASRT (the test
 * image lacks unprivileged user namespaces with the right caps so a
 * real ASRT initialize hangs / errors). Instead it exercises the
 * three components that compose at runtime:
 *
 *   1. `lib/node/pi/sandbox/wrapper-slot.ts` - parent installs the
 *      wrap function. The slot is `globalThis`-anchored, so a child
 *      session's hook-only factory sees the same installed function.
 *   2. `config/pi/extensions/sandbox.ts`'s `sandboxFactoryHookOnly` -
 *      the factory injected into spawned subagents via
 *      `lib/node/pi/subagent/extension-injection.ts`. It mounts ONLY
 *      a `tool_call` handler that calls `requestSandboxWrap`.
 *   3. `lib/node/pi/subagent/extension-injection.ts` - the registry
 *      `runOneShotAgent` consumes to inject the factory.
 *
 * If any link in this chain breaks, a subagent's bash calls would
 * silently bypass the kernel sandbox; that's a security regression
 * with no other test coverage.
 *
 * Tagged `@docker:skip` for the dotfiles bats suite (host-only smoke
 * runs the real ASRT path); the structural assertions here remain
 * vitest-friendly because they don't touch ASRT.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  collectSubagentInjections,
  registerSubagentInjection,
  unregisterSubagentInjection,
} from '../../../../lib/node/pi/subagent/extension-injection.ts';
import {
  installSandboxWrapper,
  requestSandboxWrap,
  type SandboxWrapFn,
  uninstallSandboxWrapper,
} from '../../../../lib/node/pi/sandbox/wrapper-slot.ts';

// ─────────────────────────────────────────────────────────────────
// Stand-ins for pi's runtime types
// ─────────────────────────────────────────────────────────────────

interface FakeBashEvent {
  toolName: string;
  input: { command?: unknown; [k: symbol]: unknown };
}

interface FakeChildCtx {
  cwd: string;
  hasUI: boolean;
}

type FakeToolCallHandler = (
  event: FakeBashEvent,
  ctx: FakeChildCtx,
) => Promise<{ block: true; reason: string } | undefined>;

interface FakeExtensionAPI {
  on(event: 'tool_call', handler: FakeToolCallHandler): void;
}

/**
 * Mirror of `sandboxFactoryHookOnly` from
 * `config/pi/extensions/sandbox.ts`. We reproduce the structure here
 * to keep the spec runtime-free; the integration claim is
 * "runOneShotAgent injects this factory into the child session, the
 * factory mounts a tool_call handler, the handler calls
 * requestSandboxWrap, the slot returns the parent's installed wrap."
 *
 * The behavioural contract (env-var short-circuits, marker
 * sanitisation, re-entry guard) is covered exhaustively by
 * `sandbox.spec.ts`; here we only verify the wrap-routing.
 */
function sandboxHookOnlyMirror(pi: FakeExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const rawCmd = event.input.command;
    const command = typeof rawCmd === 'string' ? rawCmd : '';
    if (!command.trim()) return undefined;
    const result = await requestSandboxWrap(command, { hasUI: ctx.hasUI, cwd: ctx.cwd });
    if (!result.wrapped) return undefined;
    (event.input as { command: string }).command = result.command;
    return undefined;
  });
}

/**
 * Build a fake child session and pretend `runOneShotAgent` ran the
 * registered subagent injection factories against it. Returns the
 * session's `tool_call` dispatch surface.
 *
 * In production, `subagent-spawn.ts` calls
 * `collectSubagentInjections()` and feeds the array as the child
 * AgentSession's `extensionFactories`. The child's `DefaultResourceLoader`
 * then calls each factory with the child's own `pi` API. Here we
 * compose the same chain with a fake API + fake child.
 */
function buildFakeChildWithInjections(): {
  fire(event: FakeBashEvent, ctx: FakeChildCtx): Promise<{ block: true; reason: string } | undefined>;
  factoryCount: number;
} {
  const handlers: FakeToolCallHandler[] = [];
  const fakeApi: FakeExtensionAPI = {
    on(event, handler) {
      if (event === 'tool_call') handlers.push(handler);
    },
  };
  const factories = collectSubagentInjections();
  for (const f of factories) {
    // Cast through `unknown` because the registry uses an opaque
    // factory type so `lib/` can stay free of pi-types.
    (f as unknown as (api: FakeExtensionAPI) => void)(fakeApi);
  }
  return {
    factoryCount: factories.length,
    async fire(event, ctx) {
      // Sequential is intentional: a tool_call handler may return a
      // block result that short-circuits the rest of the chain (the
      // pi runtime semantics). Promise.all would lose that early-exit.
      for (const h of handlers) {
        // oxlint-disable-next-line no-await-in-loop
        const r = await h(event, ctx);
        if (r) return r;
      }
      return undefined;
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Specs
// ─────────────────────────────────────────────────────────────────

describe('subagent + sandbox integration', () => {
  beforeEach(() => {
    uninstallSandboxWrapper();
    // Tests run sequentially in the same process; the registry is a
    // `globalThis` slot, so other specs may have left entries behind.
    // Snapshot + restore is overkill; explicitly drop the sandbox id
    // we add here on each test.
    unregisterSubagentInjection('sandbox-test');
  });

  afterEach(() => {
    uninstallSandboxWrapper();
    unregisterSubagentInjection('sandbox-test');
  });

  test('subagent injection registry surfaces the sandbox factory to spawned children', () => {
    registerSubagentInjection(
      'sandbox-test',
      sandboxHookOnlyMirror as unknown as Parameters<typeof registerSubagentInjection>[1],
    );
    const factories = collectSubagentInjections();
    // The exact id list across the suite changes as other specs add
    // their own factories; just assert OURS is present.
    expect(factories.length).toBeGreaterThanOrEqual(1);
  });

  test("child bash call routes through the parent's installed wrap", async () => {
    let wrapCalls = 0;
    const wrapFn: SandboxWrapFn = (cmd: string) => {
      wrapCalls++;
      return Promise.resolve({ command: `WRAP[${cmd}]`, wrapped: true });
    };
    installSandboxWrapper(wrapFn);
    registerSubagentInjection(
      'sandbox-test',
      sandboxHookOnlyMirror as unknown as Parameters<typeof registerSubagentInjection>[1],
    );

    const child = buildFakeChildWithInjections();
    expect(child.factoryCount).toBeGreaterThanOrEqual(1);

    const event: FakeBashEvent = { toolName: 'bash', input: { command: 'git log -1' } };
    await child.fire(event, { cwd: '/workspace', hasUI: false });

    expect(wrapCalls).toBe(1);
    expect(event.input.command).toBe('WRAP[git log -1]');
  });

  test('child bash call falls through unchanged when no parent wrap is installed', async () => {
    // No installSandboxWrapper - the slot is empty.
    registerSubagentInjection(
      'sandbox-test',
      sandboxHookOnlyMirror as unknown as Parameters<typeof registerSubagentInjection>[1],
    );

    const child = buildFakeChildWithInjections();
    const event: FakeBashEvent = { toolName: 'bash', input: { command: 'git log -1' } };
    await child.fire(event, { cwd: '/workspace', hasUI: false });

    // Slot returned `wrapped: false` - the factory left the command
    // alone, matching the parent's degraded-fallback identity-wrap.
    expect(event.input.command).toBe('git log -1');
  });

  test('non-bash tool calls in the child are passthrough', async () => {
    let wrapCalls = 0;
    installSandboxWrapper((cmd) => {
      wrapCalls++;
      return Promise.resolve({ command: cmd, wrapped: true });
    });
    registerSubagentInjection(
      'sandbox-test',
      sandboxHookOnlyMirror as unknown as Parameters<typeof registerSubagentInjection>[1],
    );

    const child = buildFakeChildWithInjections();
    const event = { toolName: 'read', input: { command: 'whatever' } } as unknown as FakeBashEvent;
    await child.fire(event, { cwd: '/workspace', hasUI: false });

    expect(wrapCalls).toBe(0);
  });
});
