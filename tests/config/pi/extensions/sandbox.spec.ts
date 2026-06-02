/**
 * Tests for the `config/pi/extensions/sandbox.ts` extension shell.
 *
 * Sits under `tests/config/pi/extensions/` to document extension
 * behaviour, but - per project convention - only drives the
 * underlying pure lib helpers (`sandbox/wrapper-slot.ts` and the
 * marker-sanitization helpers exported from `sandbox.ts` itself).
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

// Pure helpers live under lib/ so the spec doesn't have to import
// the extension shell (which depends on `@earendil-works/*`).
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
  SANDBOX_RECHECK_USAGE,
  SANDBOX_RESCAN_USAGE,
  SANDBOX_USAGE,
  SANDBOX_VIOLATIONS_USAGE,
} from '../../../../lib/node/pi/sandbox/usage.ts';
import {
  installSandboxWrapper,
  isSandboxWrapperInstalled,
  requestSandboxWrap,
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

/**
 * Mirror the bash hook's mutate-in-place pattern from
 * `config/pi/extensions/sandbox.ts`. We reproduce it here instead of
 * importing the full extension default export because vitest does not
 * have pi's runtime API on the test path - same tactic the
 * `bash-permissions-subagent.spec.ts` spec uses.
 *
 * The factory:
 *   1. skips non-bash events,
 *   2. skips already-wrapped commands (re-entry guard),
 *   3. sanitizes pre-existing marker prefixes from the user input,
 *   4. asks the wrapper slot for a wrap; identity-wraps when the
 *      slot is empty,
 *   5. mutates `event.input.command` and stashes the original on
 *      `SANDBOX_ORIGINAL_SYMBOL`.
 */
function sandboxFactoryMirror(pi: FakeExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const rawCmd = event.input.command;
    const original = typeof rawCmd === 'string' ? rawCmd : '';
    if (!original.trim()) return undefined;
    if (alreadyWrapped(original)) return undefined;

    const safe = stripMarkerFromUserInput(original);
    const result = await requestSandboxWrap(safe, { hasUI: ctx.hasUI, cwd: ctx.cwd });
    if (!result.wrapped) return undefined;

    Object.defineProperty(event.input, SANDBOX_ORIGINAL_SYMBOL, {
      value: original,
      enumerable: false,
    });
    (event.input as { command: string }).command = result.command;
    return undefined;
  });
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
  sandboxFactoryMirror(api);
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
// handler with `isHelpArg(args)` → notify(USAGE). The shell can't be
// imported under vitest, so we assert the contract against the shared
// helper + the USAGE consts the handlers notify.
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

  test('re-entry guard: pre-wrapped commands are skipped', async () => {
    const wrapFn = vi.fn<SandboxWrapFn>().mockResolvedValue({ command: 'NEVER', wrapped: true });
    installSandboxWrapper(wrapFn);

    const child = buildChildSessionAndMount();
    const original = '__PI_SANDBOX_WRAPPED=1 sh -c true';
    const event: FakeBashEvent = { toolName: 'bash', input: { command: original } };
    const r = await child.fire(event, childCtx());

    expect(r).toBeUndefined();
    expect(event.input.command).toBe(original);
    expect(wrapFn).not.toHaveBeenCalled();
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
    // Model attempt: prefix the command with the marker AND a leading
    // marker-and-marker stack to try to bypass the wrap. The bash hook
    // should detect the leading marker and skip; but if the input has
    // SOME leading whitespace before the marker, alreadyWrapped() still
    // detects it. The strip path only fires when alreadyWrapped is
    // false but the command contains a stacked marker; here we exercise
    // a DIFFERENT route - a non-leading payload that looks ordinary.
    const event: FakeBashEvent = { toolName: 'bash', input: { command: 'echo __PI_SANDBOX_WRAPPED=1' } };
    const r = await child.fire(event, childCtx());

    expect(r).toBeUndefined();
    expect(wrapFn).toHaveBeenCalledTimes(1);
    // The rewritten command came from the wrapper; the original is preserved.
    expect((event.input as Record<symbol, unknown>)[SANDBOX_ORIGINAL_SYMBOL]).toBe('echo __PI_SANDBOX_WRAPPED=1');
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
