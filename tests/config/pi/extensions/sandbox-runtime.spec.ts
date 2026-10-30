/** Exercise the real sandbox factories, not a copied hook implementation. */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { AsrtSandboxManager } from '../../../../lib/node/pi/sandbox/asrt-manager.ts';
import type * as SandboxPlatformModule from '../../../../lib/node/pi/sandbox/platform.ts';
import type { SandboxWrapResult } from '../../../../lib/node/pi/sandbox/wrapper-slot.ts';
import type { SandboxSelfTestOptions } from '../../../../lib/node/pi/sandbox/self-test.ts';

const selfTestMock = vi.hoisted(() =>
  vi.fn<(options: SandboxSelfTestOptions) => Promise<{ ok: boolean; lines: string[] }>>(),
);
vi.mock('../../../../lib/node/pi/sandbox/self-test.ts', () => ({ runSandboxSelfTest: selfTestMock }));

vi.mock('../../../../lib/node/pi/sandbox/platform.ts', async (importOriginal) => {
  const original = await importOriginal<typeof SandboxPlatformModule>();
  return {
    ...original,
    detectSandboxPlatform: () => ({
      kind: 'darwin',
      description: 'test macOS',
      missingDeps: [],
      hints: [],
      isRoot: false,
      isInsideDocker: false,
      apparmorBlocksUserNs: false,
      wslVersion: 0,
    }),
  };
});

type BashCall = Extract<ToolCallEvent, { toolName: 'bash' }>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface RuntimeConfig {
  filesystem: { allowWrite: unknown[] };
  network: { allowedDomains?: string[] };
}

let root: string;
let cwdA: string;
let cwdB: string;
let ctx: ExtensionContext;
let handlers: Map<string, Handler>;
interface RegisteredCommand {
  handler: (args: string, context: ExtensionContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null;
}
let commands: Map<string, RegisteredCommand>;
let manager: AsrtSandboxManager;
let initializeMock = vi.fn<AsrtSandboxManager['initialize']>();
let resetMock = vi.fn<AsrtSandboxManager['reset']>();
let cleanupMock = vi.fn();
let updateMock = vi.fn<AsrtSandboxManager['updateConfig']>();
let wrapMock = vi.fn<AsrtSandboxManager['wrapWithSandbox']>();
let notifyMock = vi.fn();
let selectMock = vi.fn();
let applied: RuntimeConfig;
let wrapped: { command: string; config: RuntimeConfig }[];
let requestWrap: (command: string, context: { cwd: string; hasUI: boolean }) => Promise<SandboxWrapResult>;
let releaseWrap: (handle: SandboxWrapResult) => void;

function api(): ExtensionAPI {
  return {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
}

async function invoke(name: string, args = ''): Promise<void> {
  const command = commands.get(name);
  if (!command) throw new Error(`Missing command: ${name}`);
  await command.handler(args, ctx);
}

function event(command: string): BashCall {
  return { type: 'tool_call', toolName: 'bash', toolCallId: command, input: { command } };
}

async function fire(command: string, cwd: string = cwdA): Promise<BashCall> {
  const call = event(command);
  const result = await handlers.get('tool_call')?.(call, { ...ctx, cwd });
  expect(result).toBeUndefined();
  return call;
}

beforeEach(async () => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'pi-sandbox-runtime-'));
  cwdA = join(root, 'a');
  cwdB = join(root, 'b');
  mkdirSync(join(cwdA, '.pi'), { recursive: true });
  mkdirSync(join(cwdB, '.pi'), { recursive: true });
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'));
  vi.stubEnv('CLAUDE_CODE_TMPDIR', join(root, 'tmp'));
  for (const name of [
    'PI_SANDBOX_DISABLED',
    'PI_SANDBOX_DRY_RUN',
    'PI_SANDBOX_NETWORK_UNRESTRICTED',
    'PI_SANDBOX_EXTRA_ALLOW_DOMAIN',
    'PI_SANDBOX_ALLOW_LOCALHOST',
  ]) {
    vi.stubEnv(name, '');
  }
  handlers = new Map();
  commands = new Map();
  wrapped = [];
  notifyMock = vi.fn();
  selectMock = vi.fn();
  cleanupMock = vi.fn();
  selfTestMock
    .mockReset()
    .mockResolvedValue({ ok: true, lines: ['Synthetic fixtures passed; network not actively probed.'] });
  resetMock = vi.fn(() => Promise.resolve());
  initializeMock = vi.fn((config: unknown) => {
    applied = config as RuntimeConfig;
    return Promise.resolve();
  });
  ctx = {
    cwd: cwdA,
    hasUI: false,
    ui: { notify: notifyMock, select: selectMock, input: vi.fn() },
  } as unknown as ExtensionContext;
  updateMock = vi.fn((config: unknown) => {
    applied = config as RuntimeConfig;
  });
  wrapMock = vi.fn((command: string) => {
    wrapped.push({ command, config: structuredClone(applied) });
    return Promise.resolve(`WRAP(${command})`);
  });
  manager = {
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => true,
    initialize: initializeMock,
    updateConfig: updateMock,
    wrapWithSandbox: wrapMock,
    reset: resetMock,
    getSandboxViolationStore: () => ({ getViolations: () => [] }),
    annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
    cleanupAfterCommand: cleanupMock,
  };
  const asrt = await import('../../../../lib/node/pi/sandbox/asrt-manager.ts');
  asrt.setAsrtModuleForTesting({ SandboxManager: manager });
  const factory = await import('../../../../config/pi/extensions/sandbox.ts');
  factory.default(api());
  const slot = await import('../../../../lib/node/pi/sandbox/wrapper-slot.ts');
  requestWrap = slot.requestSandboxWrap;
  releaseWrap = slot.releaseSandboxWrap;
  // Startup sets the parent context without requiring a first foreground bash.
  await handlers.get('session_start')?.({}, ctx);
});

afterEach(async () => {
  await handlers.get('session_shutdown')?.({}, ctx);
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('real sandbox hook pipeline', () => {
  test('concurrent foreground and slot wraps keep their own cwd config', async () => {
    const [foreground, background] = await Promise.all([
      fire('foreground-A'),
      requestWrap('background-B', { cwd: cwdB, hasUI: false }),
    ]);
    expect(foreground.input.command).toBe('WRAP(foreground-A)');
    expect(background.wrapped).toBe(true);
    expect(wrapped.find((entry) => entry.command === 'foreground-A')?.config.filesystem.allowWrite).toContain(cwdA);
    expect(wrapped.find((entry) => entry.command === 'foreground-A')?.config.filesystem.allowWrite).not.toContain(cwdB);
    expect(wrapped.find((entry) => entry.command === 'background-B')?.config.filesystem.allowWrite).toContain(cwdB);
    expect(initializeMock).toHaveBeenCalledTimes(1);
    releaseWrap(background);
  });

  test("does not replace another cwd's live proxy policy; retries after release", async () => {
    const active = await requestWrap('active-A', { cwd: cwdA, hasUI: false });
    writeFileSync(join(cwdB, '.pi', 'sandbox.json'), JSON.stringify({ network: { unrestricted: true } }));
    const blocked = await requestWrap('different-network-B', { cwd: cwdB, hasUI: false });
    expect(blocked.action).toBe('block');
    expect(blocked.reason).toContain('different network policy');
    expect(applied.network.allowedDomains).toEqual([]);
    expect(wrapped).toHaveLength(1);
    releaseWrap(active);
    const retry = await requestWrap('retry-B', { cwd: cwdB, hasUI: false });
    expect(retry.wrapped).toBe(true);
    expect(applied.network.allowedDomains).toBeUndefined();
    releaseWrap(retry);
  });

  test('same-cwd trusted slash commands can persist and reload policy', async () => {
    const active = await requestWrap('active-A', { cwd: cwdA, hasUI: false });
    await commands.get('sandbox-allow')?.handler('example.com', ctx);
    expect(applied.network.allowedDomains).toContain('example.com');
    releaseWrap(active);
  });

  test('model-supplied marker never bypasses the real hook', async () => {
    const call = await fire('__PI_SANDBOX_WRAPPED=1 echo safe');
    expect(call.input.command).toBe('WRAP(echo safe)');
    expect(wrapped).toHaveLength(1);
  });

  test('subagent factory honors block results and releases successful wraps once', async () => {
    const parentHandlers = handlers;
    handlers = new Map();
    const { sandboxFactoryHookOnly } = await import('../../../../config/pi/extensions/sandbox.ts');
    sandboxFactoryHookOnly(api());
    const childHandlers = handlers;
    handlers = parentHandlers;
    const call = event('child');
    expect(await childHandlers.get('tool_call')?.(call, ctx)).toBeUndefined();
    expect(call.input.command).toBe('WRAP(child)');
    await childHandlers.get('tool_result')?.({ toolName: 'bash', input: call.input }, ctx);
    await childHandlers.get('tool_result')?.({ toolName: 'bash', input: call.input }, ctx);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    writeFileSync(join(cwdB, '.pi', 'sandbox.json'), JSON.stringify({ network: { unrestricted: true } }));
    const active = await requestWrap('active-A', { cwd: cwdA, hasUI: false });
    const blocked = await childHandlers.get('tool_call')?.(event('blocked-child'), { ...ctx, cwd: cwdB });
    expect(blocked).toMatchObject({ block: true });
    releaseWrap(active);
  });

  test('real filesystem gate blocks policy writes even with permissive fallback', async () => {
    vi.stubEnv('PI_FILESYSTEM_DEFAULT', 'allow');
    vi.stubEnv('PI_FILESYSTEM_DISABLED', '');
    const parentHandlers = handlers;
    handlers = new Map();
    try {
      const { filesystemFactoryHookOnly } = await import('../../../../config/pi/extensions/filesystem.ts');
      filesystemFactoryHookOnly(api());
      const gate = handlers.get('tool_call');
      const paths = ['.pi/sandbox.json', '.pi/filesystem.json', join(root, 'agent', 'bash-permissions.json')];
      const results = await Promise.all(
        paths.flatMap((path) =>
          ['write', 'edit'].map((toolName) => gate?.({ toolName, input: { path, edits: [] } }, ctx)),
        ),
      );
      for (const result of results) expect(result).toMatchObject({ block: true });
      expect(await gate?.({ toolName: 'write', input: { path: '.pi/session-output.txt' } }, ctx)).toBeUndefined();
      expect(selectMock).not.toHaveBeenCalled();
    } finally {
      handlers = parentHandlers;
    }
  });

  test('real apply_patch rejects policy creation before permissive fallback', async () => {
    vi.stubEnv('PI_FILESYSTEM_DEFAULT', 'allow');
    vi.stubEnv('PI_APPLY_PATCH_DISABLED', '');
    interface PatchTool {
      execute: (
        id: string,
        params: { patch: string },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: ExtensionContext,
      ) => Promise<{ isError?: boolean }>;
    }
    const tools: PatchTool[] = [];
    const { default: applyPatch } = await import('../../../../config/pi/extensions/apply-patch.ts');
    applyPatch({
      on: () => undefined,
      registerTool: (tool: PatchTool) => {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI);
    expect(tools).toHaveLength(1);
    const result = await tools[0].execute(
      'policy-patch',
      {
        patch: '*** Begin Patch\n*** Add File: .pi/sandbox.json\n+{}\n*** End Patch',
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(existsSync(join(cwdA, '.pi', 'sandbox.json'))).toBe(false);
  });

  test('dry run logs but does not execute or retain a wrap', async () => {
    vi.stubEnv('PI_SANDBOX_DRY_RUN', '1');
    const call = await fire('echo dry');
    expect(call.input.command).toBe('echo dry');
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('dry-run wrap'), 'info');
  });

  test.each(['sandbox-enable', 'sandbox-network', 'sandbox-reset', 'sandbox-explain', 'sandbox-test'])(
    '%s --help is side-effect-free on the actual command',
    async (name) => {
      await invoke(name, '--help');
      expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining(`Usage: /${name}`), 'info');
      expect(initializeMock).not.toHaveBeenCalled();
      expect(selfTestMock).not.toHaveBeenCalled();
    },
  );

  test('network-only disable/enable preserves filesystem protection and never writes config', async () => {
    await invoke('sandbox-network', 'disable');
    expect(applied.network.allowedDomains).toBeUndefined();
    const filesystem = structuredClone(applied.filesystem);
    const active = await requestWrap('cdp-client', { cwd: cwdA, hasUI: false });
    expect(active.wrapped).toBe(true);
    releaseWrap(active);
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('Filesystem sandbox: active'), 'warning');
    await invoke('sandbox-network', 'enable');
    expect(applied.network.allowedDomains).toEqual([]);
    expect(applied.filesystem).toEqual(filesystem);
    expect(existsSync(join(cwdA, '.pi', 'sandbox.json'))).toBe(false);
    expect(existsSync(join(root, 'agent', 'sandbox.json'))).toBe(false);
  });

  test('network enable overrides env/file unrestricted policy until reset', async () => {
    vi.stubEnv('PI_SANDBOX_NETWORK_UNRESTRICTED', '1');
    await invoke('sandbox-network', 'enable');
    expect(applied.network.allowedDomains).toEqual([]);
    await invoke('sandbox-reset');
    expect(applied.network.allowedDomains).toBeUndefined();
    await invoke('sandbox-network');
    expect(notifyMock).toHaveBeenLastCalledWith(
      expect.stringContaining('Session override: (none; configured policy)'),
      'info',
    );
  });

  test('switching networking with active jobs is refused transactionally, including same cwd', async () => {
    const active = await requestWrap('long-job', { cwd: cwdA, hasUI: false });
    await invoke('sandbox-network', 'disable');
    expect(applied.network.allowedDomains).toEqual([]);
    expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining('controls unchanged'), 'warning');
    releaseWrap(active);
    await invoke('sandbox-network', 'status');
    expect(notifyMock).toHaveBeenLastCalledWith(
      expect.stringContaining('Session override: (none; configured policy)'),
      'info',
    );
    await invoke('sandbox-network', 'disable');
    expect(applied.network.allowedDomains).toBeUndefined();
  });

  test('runtime update failure preserves the previous publication and rolls back controls', async () => {
    await invoke('sandbox-enable');
    const { getActiveSandbox } = await import('../../../../lib/node/pi/sandbox/active.ts');
    const before = getActiveSandbox();
    updateMock.mockImplementationOnce(() => {
      throw new Error('test runtime rejected update');
    });
    await invoke('sandbox-network', 'disable');
    expect(applied.network.allowedDomains).toEqual([]);
    expect(getActiveSandbox()).toBe(before);
    await invoke('sandbox-network', 'status');
    expect(notifyMock).toHaveBeenLastCalledWith(
      expect.stringContaining('Session override: (none; configured policy)'),
      'info',
    );
    await invoke('sandbox-network', 'disable');
    expect(applied.network.allowedDomains).toBeUndefined();
  });

  test('full bypass takes priority and sandbox-enable restores wrapping without clearing network override', async () => {
    await invoke('sandbox-disable');
    await invoke('sandbox-network', 'disable');
    const bypass = await requestWrap('bypass', { cwd: cwdA, hasUI: false });
    expect(bypass.wrapped).toBe(false);
    expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining('NOT ENFORCED (bypassed'), 'warning');
    await invoke('sandbox-enable');
    const protectedJob = await requestWrap('protected', { cwd: cwdA, hasUI: false });
    expect(protectedJob.wrapped).toBe(true);
    expect(applied.network.allowedDomains).toBeUndefined();
    releaseWrap(protectedJob);
  });

  test('reset clears session network grants, overrides, and bypass but keeps saved policy', async () => {
    writeFileSync(join(cwdA, '.pi', 'sandbox.json'), JSON.stringify({ network: { allow: ['saved.example.com'] } }));
    await invoke('sandbox-enable');
    const ask = initializeMock.mock.calls[0][1];
    if (!ask) throw new Error('Missing ask callback');
    const { publishActiveUI } = await import('../../../../lib/node/pi/active-ui.ts');
    selectMock.mockResolvedValue('Allow session.example.com for this session');
    publishActiveUI({ hasUI: true, select: selectMock, input: () => Promise.resolve(undefined), notify: notifyMock });
    expect(await ask({ host: 'session.example.com', port: 443 })).toBe(true);
    publishActiveUI({ hasUI: false, select: selectMock, input: () => Promise.resolve(undefined), notify: notifyMock });
    expect(await ask({ host: 'session.example.com', port: 443 })).toBe(true);
    await invoke('sandbox-network', 'disable');
    await invoke('sandbox-disable');
    await invoke('sandbox-reset');
    expect(applied.network.allowedDomains).toContain('saved.example.com');
    expect(await ask({ host: 'session.example.com', port: 443 })).not.toBe(true);
    const protectedJob = await requestWrap('after-reset', { cwd: cwdA, hasUI: false });
    expect(protectedJob.wrapped).toBe(true);
    releaseWrap(protectedJob);
  });

  test('invalid network args do not mutate controls and completions cover both levels', async () => {
    await invoke('sandbox-network', 'disable extra');
    expect(initializeMock).not.toHaveBeenCalled();
    expect(commands.get('sandbox-network')?.getArgumentCompletions?.('d')).toMatchObject([{ value: 'disable' }]);
    expect(commands.get('sandbox-explain')?.getArgumentCompletions?.('p')).toMatchObject([{ value: 'path' }]);
    expect(commands.get('sandbox-explain')?.getArgumentCompletions?.('path ')).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'path .' })]),
    );
  });

  test('explain is diagnostic only and includes source and port-aware host decisions', async () => {
    writeFileSync(join(cwdA, '.pi', 'sandbox.json'), JSON.stringify({ network: { deny: ['localhost:9222'] } }));
    await invoke('sandbox-explain', 'host localhost:9222');
    expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining('9222'), 'info');
    expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining(join(cwdA, '.pi', 'sandbox.json')), 'info');
    await invoke('sandbox-explain', 'path .pi/sandbox.json');
    expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining('mandatory'), 'info');
    expect(initializeMock).not.toHaveBeenCalled();
  });

  test('self-test uses strict native wrapping with fixture-only custom rules and balanced release', async () => {
    selfTestMock.mockImplementationOnce(async (options) => {
      await options.wrap('fixture check', {
        root: '/tmp/pi-test',
        readDenied: '/tmp/pi-test/secret',
        writeDenied: '/tmp/pi-test/locked',
      });
      options.release();
      return { ok: true, lines: ['fixture checks passed'] };
    });
    await invoke('sandbox-test');
    expect(selfTestMock).toHaveBeenCalledTimes(1);
    const custom = wrapMock.mock.calls[0][2] as { filesystem: { denyRead: unknown[]; denyWrite: unknown[] } };
    expect(custom.filesystem.denyRead).toContainEqual({ path: '/tmp/pi-test/secret', literal: true });
    expect(custom.filesystem.denyWrite).toContainEqual({ path: '/tmp/pi-test/locked', literal: true });
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining('self-test: PASS'), 'info');
  });

  test('self-test refuses bypass and reports initialization failure without unwrapped execution', async () => {
    await invoke('sandbox-disable');
    await invoke('sandbox-test');
    expect(selfTestMock).not.toHaveBeenCalled();
    await invoke('sandbox-enable');
    await handlers.get('session_shutdown')?.({}, ctx);
    // A replacement session has no initialized runtime; native failure must not fall through.
    const factory = await import('../../../../config/pi/extensions/sandbox.ts');
    handlers = new Map();
    commands = new Map();
    factory.default(api());
    await handlers.get('session_start')?.({}, ctx);
    initializeMock.mockRejectedValueOnce(new Error('native test init blocked'));
    await invoke('sandbox-test');
    expect(selfTestMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenLastCalledWith(expect.stringContaining('no unwrapped fallback'), 'error');
  });

  test('shutdown waits for runtime reset before allowing a replacement runtime', async () => {
    await requestWrap('active', { cwd: cwdA, hasUI: false });
    const reset = Promise.withResolvers<void>();
    resetMock.mockReturnValueOnce(reset.promise);
    let stopped = false;
    const shutdown = Promise.resolve(handlers.get('session_shutdown')?.({}, ctx)).then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    reset.resolve();
    await shutdown;
    expect(stopped).toBe(true);
  });
});
