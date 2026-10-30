/**
 * Tests for the `config/pi/extensions/sandbox.ts` extension shell.
 *
 * Exercises the real hook-only factory plus the marker, wrapper-slot,
 * command-help, and completion helpers. The default factory's runtime
 * pipeline is exercised separately in sandbox-runtime.spec.ts.
 *
 * Coverage:
 *
 *   - Re-entry guard (`alreadyWrapped`).
 *   - Pre-existing marker sanitisation (`stripMarkerFromUserInput`).
 *   - The bash hook + hook-only factory contract: input is mutated in
 *     place when the wrapper slot returns `wrapped: true`; the original
 *     command is preserved on the symbol-keyed property; bash-permissions'
 *     allow-rule path can recover the original string.
 *   - `PI_SANDBOX_DISABLED=1` short-circuits before mutating.
 *   - The wrapper slot is `globalThis`-anchored so a parent's installed
 *     wrap reaches subagent (child) sessions.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { sandboxFactoryHookOnly } from '../../../../config/pi/extensions/sandbox.ts';

// Pure helpers complement the real hook-only factory above.
import { completePositional, completeSubverbs } from '../../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import {
  alreadyWrapped,
  buildIdentityWrap,
  SANDBOX_ORIGINAL_SYMBOL,
  stripMarkerFromUserInput,
} from '../../../../lib/node/pi/sandbox/markers.ts';
import {
  SANDBOX_ALLOW_USAGE,
  SANDBOX_ALLOW_WRITE_USAGE,
  SANDBOX_DENY_USAGE,
  SANDBOX_DISABLE_USAGE,
  SANDBOX_ENABLE_USAGE,
  SANDBOX_NETWORK_USAGE,
  SANDBOX_RESET_USAGE,
  SANDBOX_EXPLAIN_USAGE,
  SANDBOX_TEST_USAGE,
  SANDBOX_RECHECK_USAGE,
  SANDBOX_RESCAN_USAGE,
  SANDBOX_USAGE,
  SANDBOX_VIOLATIONS_USAGE,
} from '../../../../lib/node/pi/sandbox/usage.ts';
import {
  installSandboxWrapper,
  isSandboxWrapperInstalled,
  type SandboxWrapFn,
  uninstallSandboxWrapper,
} from '../../../../lib/node/pi/sandbox/wrapper-slot.ts';

// ─────────────────────────────────────────────────────────────────
// Stand-ins for pi's runtime types
// ─────────────────────────────────────────────────────────────────

interface FakeBashEvent {
  toolName: string;
  input: { command?: unknown };
}

interface FakeChildCtx {
  cwd: string;
  hasUI: boolean;
}

type FakeToolCallResult = { block: true; reason: string } | undefined;

type FakeToolCallHandler = (event: FakeBashEvent, ctx: FakeChildCtx) => Promise<FakeToolCallResult>;

interface FakeExtensionAPI {
  on(event: 'tool_call', handler: FakeToolCallHandler): void;
}

function buildChildSessionAndMount(): {
  fire(event: FakeBashEvent, ctx: FakeChildCtx): Promise<FakeToolCallResult>;
} {
  let installed: FakeToolCallHandler | undefined;
  const api: FakeExtensionAPI = {
    on(event, handler) {
      if (event === 'tool_call') installed = handler;
    },
  };
  sandboxFactoryHookOnly(api as unknown as Parameters<typeof sandboxFactoryHookOnly>[0]);
  return {
    async fire(event, ctx) {
      if (!installed) throw new Error('factory did not register a tool_call handler');
      return installed(event, ctx);
    },
  };
}

const childCtx = (overrides: Partial<FakeChildCtx> = {}): FakeChildCtx => ({
  cwd: '/workspace',
  hasUI: false,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────
// Help convention (§4.4) - each `/sandbox*` command guards its
// handler with `isHelpArg(args)` → notify(USAGE). These assertions cover
// the shared help contract; sandbox-runtime.spec.ts mounts the shell.
// ─────────────────────────────────────────────────────────────────

describe('sandbox command help convention', () => {
  const cases: { command: string; usage: string }[] = [
    { command: '/sandbox', usage: SANDBOX_USAGE },
    { command: '/sandbox-allow', usage: SANDBOX_ALLOW_USAGE },
    { command: '/sandbox-deny', usage: SANDBOX_DENY_USAGE },
    { command: '/sandbox-allow-write', usage: SANDBOX_ALLOW_WRITE_USAGE },
    { command: '/sandbox-violations', usage: SANDBOX_VIOLATIONS_USAGE },
    { command: '/sandbox-rescan', usage: SANDBOX_RESCAN_USAGE },
    { command: '/sandbox-recheck', usage: SANDBOX_RECHECK_USAGE },
    { command: '/sandbox-disable', usage: SANDBOX_DISABLE_USAGE },
    { command: '/sandbox-enable', usage: SANDBOX_ENABLE_USAGE },
    { command: '/sandbox-network', usage: SANDBOX_NETWORK_USAGE },
    { command: '/sandbox-reset', usage: SANDBOX_RESET_USAGE },
    { command: '/sandbox-explain', usage: SANDBOX_EXPLAIN_USAGE },
    { command: '/sandbox-test', usage: SANDBOX_TEST_USAGE },
  ];

  for (const { command, usage } of cases) {
    test(`${command} --help notifies a non-empty USAGE mentioning the command`, () => {
      const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
      if (isHelpArg('--help')) notify(usage, 'info');

      expect(notify).toHaveBeenCalledTimes(1);
      const [msg, level] = notify.mock.calls[0];
      expect(level).toBe('info');
      expect(msg).toBe(usage);
      expect(usage.length).toBeGreaterThan(0);
      expect(usage).toContain(command);
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// Pure-helper specs
// ─────────────────────────────────────────────────────────────────

describe('alreadyWrapped', () => {
  test('detects the marker at the start of the command', () => {
    expect(alreadyWrapped('__PI_SANDBOX_WRAPPED=1 sh -c true')).toBe(true);
  });
  test('detects the marker after leading whitespace', () => {
    expect(alreadyWrapped('   __PI_SANDBOX_WRAPPED=1 sh -c true')).toBe(true);
  });
  test('does not match a marker mid-command', () => {
    expect(alreadyWrapped('echo __PI_SANDBOX_WRAPPED=1')).toBe(false);
  });
  test('does not match plain commands', () => {
    expect(alreadyWrapped('git log -1')).toBe(false);
    expect(alreadyWrapped('')).toBe(false);
  });
});

describe('stripMarkerFromUserInput', () => {
  test('strips a single leading marker', () => {
    expect(stripMarkerFromUserInput('__PI_SANDBOX_WRAPPED=1 git log')).toBe('git log');
  });
  test('strips stacked markers (model retries with two prefixes)', () => {
    expect(stripMarkerFromUserInput('__PI_SANDBOX_WRAPPED=1 __PI_SANDBOX_WRAPPED=1 git log')).toBe('git log');
  });
  test('strips leading whitespace + marker', () => {
    expect(stripMarkerFromUserInput('  __PI_SANDBOX_WRAPPED=1 git log')).toBe('git log');
  });
  test('passes through commands with no marker', () => {
    expect(stripMarkerFromUserInput('git log')).toBe('git log');
  });
  test('does not strip marker tokens that appear mid-command', () => {
    expect(stripMarkerFromUserInput('echo __PI_SANDBOX_WRAPPED=1')).toBe('echo __PI_SANDBOX_WRAPPED=1');
  });
});

describe('buildIdentityWrap', () => {
  test('produces a marker-prefixed sh -c invocation', () => {
    expect(buildIdentityWrap('git log')).toBe("__PI_SANDBOX_WRAPPED=1 sh -c 'git log'");
  });
  test('shell-quotes embedded single quotes', () => {
    expect(buildIdentityWrap(`echo 'hi'`)).toBe("__PI_SANDBOX_WRAPPED=1 sh -c 'echo '\\''hi'\\'''");
  });
  test('the identity-wrap output is itself recognised by alreadyWrapped', () => {
    expect(alreadyWrapped(buildIdentityWrap('git log'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Wrapper-slot integration: parent + child share the slot
// ─────────────────────────────────────────────────────────────────

describe('sandbox tool_call mutate-in-place', () => {
  beforeEach(() => {
    uninstallSandboxWrapper();
  });
  afterEach(() => {
    uninstallSandboxWrapper();
  });

  test('with no wrapper installed, bash command passes through unchanged', async () => {
    expect(isSandboxWrapperInstalled()).toBe(false);
    const child = buildChildSessionAndMount();
    const event: FakeBashEvent = { toolName: 'bash', input: { command: 'git log' } };
    const r = await child.fire(event, childCtx());
    expect(r).toBeUndefined();
    expect(event.input.command).toBe('git log');
    expect((event.input as Record<symbol, unknown>)[SANDBOX_ORIGINAL_SYMBOL]).toBeUndefined();
  });

  test('child bash call is rewritten when parent installs a wrap', async () => {
    const wrapFn: SandboxWrapFn = vi.fn((cmd: string) =>
      Promise.resolve({
        command: `${'__PI_SANDBOX_WRAPPED=1'} sh -c ${JSON.stringify(cmd)}`,
        wrapped: true,
      }),
    );
    installSandboxWrapper(wrapFn);

    const child = buildChildSessionAndMount();
    const event: FakeBashEvent = { toolName: 'bash', input: { command: 'git log -1' } };
    const r = await child.fire(event, childCtx());

    expect(r).toBeUndefined();
    expect(event.input.command).toBe(`__PI_SANDBOX_WRAPPED=1 sh -c "git log -1"`);
    // The original command must be preserved on the symbol-keyed property
    // so transcript renderers / bash-permissions allow-rule saves can
    // recover it.
    expect((event.input as Record<symbol, unknown>)[SANDBOX_ORIGINAL_SYMBOL]).toBe('git log -1');
    expect(wrapFn).toHaveBeenCalledTimes(1);
  });

  test('re-entry guard skips only an event the real hook already wrapped', async () => {
    const wrapFn = vi.fn<SandboxWrapFn>().mockResolvedValue({ command: 'WRAPPED', wrapped: true });
    installSandboxWrapper(wrapFn);
    const child = buildChildSessionAndMount();
    const event: FakeBashEvent = { toolName: 'bash', input: { command: 'echo safe' } };
    await child.fire(event, childCtx());
    await child.fire(event, childCtx());
    expect(event.input.command).toBe('WRAPPED');
    expect(wrapFn).toHaveBeenCalledTimes(1);
  });

  test('marker sanitization: pre-existing marker in user input is stripped before wrapping', async () => {
    const wrapFn = vi.fn<SandboxWrapFn>((cmd: string) =>
      Promise.resolve({
        command: `WRAP(${cmd})`,
        wrapped: true,
      }),
    );
    installSandboxWrapper(wrapFn);

    const child = buildChildSessionAndMount();
    const original = '__PI_SANDBOX_WRAPPED=1 __PI_SANDBOX_WRAPPED=1 echo safe';
    const event: FakeBashEvent = { toolName: 'bash', input: { command: original } };
    const r = await child.fire(event, childCtx());

    expect(r).toBeUndefined();
    expect(wrapFn).toHaveBeenCalledTimes(1);
    // The rewritten command came from the wrapper; the original is preserved.
    expect((event.input as Record<symbol, unknown>)[SANDBOX_ORIGINAL_SYMBOL]).toBe(original);
    expect(wrapFn.mock.calls[0][0]).toBe('echo safe');
  });

  test('non-bash tool calls are passthrough (factory only intercepts bash)', async () => {
    const wrapFn = vi.fn<SandboxWrapFn>().mockResolvedValue({ command: 'NEVER', wrapped: true });
    installSandboxWrapper(wrapFn);

    const child = buildChildSessionAndMount();
    const event = { toolName: 'read', input: { command: '???' } } as unknown as FakeBashEvent;
    const r = await child.fire(event, childCtx());
    expect(r).toBeUndefined();
    expect(wrapFn).not.toHaveBeenCalled();
  });

  test('empty / whitespace bash command is passthrough (no wrap attempt)', async () => {
    const wrapFn = vi.fn<SandboxWrapFn>().mockResolvedValue({ command: 'NEVER', wrapped: true });
    installSandboxWrapper(wrapFn);

    const child = buildChildSessionAndMount();
    expect(await child.fire({ toolName: 'bash', input: { command: '' } }, childCtx())).toBeUndefined();
    expect(await child.fire({ toolName: 'bash', input: { command: '   ' } }, childCtx())).toBeUndefined();
    expect(await child.fire({ toolName: 'bash', input: {} }, childCtx())).toBeUndefined();
    expect(wrapFn).not.toHaveBeenCalled();
  });

  test('wrapper returning wrapped:false leaves the command unchanged', async () => {
    const wrapFn: SandboxWrapFn = vi.fn((cmd: string) => Promise.resolve({ command: cmd, wrapped: false }));
    installSandboxWrapper(wrapFn);

    const child = buildChildSessionAndMount();
    const event: FakeBashEvent = { toolName: 'bash', input: { command: 'git log' } };
    await child.fire(event, childCtx());
    expect(event.input.command).toBe('git log');
    // wrapped:false means the symbol stash is NOT installed - the
    // unmutated command IS the original.
    expect((event.input as Record<symbol, unknown>)[SANDBOX_ORIGINAL_SYMBOL]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// Argument completion (§4.1). The shell builds these specs over the
// shared `completeSubverbs` / `completePositional` helpers; this block
// mirrors the exact specs the shell passes so the two stay in lockstep.
// ─────────────────────────────────────────────────────────────────

describe('sandbox command completion', () => {
  test('/sandbox-violations level-1 lists the --net / --fs filters', () => {
    const out = completeSubverbs('', {
      '--net': { description: 'Show only network violations' },
      '--fs': { description: 'Show only filesystem violations' },
    });
    expect(out?.map((c) => c.value)).toEqual(['--net', '--fs']);
  });

  test('/sandbox-allow completes recently-blocked domains (positional, no verb prefix)', () => {
    // Mirrors `recentBlockedDomains()` feeding completePositional: the
    // host field is `host:port`, stripped to a bare domain.
    const blocked = ['example.com', 'api.github.com'];
    const out = completePositional('exa', () => blocked.map((label) => ({ label })));
    expect(out).toEqual([{ value: 'example.com', label: 'example.com', description: undefined }]);
  });
});
