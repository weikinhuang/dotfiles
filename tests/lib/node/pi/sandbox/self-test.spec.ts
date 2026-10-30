import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
  runSandboxSelfTest,
  runSandboxSelfTestCommand,
  type SandboxSelfTestFixture,
  type SandboxSelfTestOptions,
  type SandboxSelfTestRunResult,
} from '../../../../../lib/node/pi/sandbox/self-test.ts';

/** Emulate a native denial, not a real kernel sandbox. Keep the actual reached
 * marker and run the real allowed writes; replace only the denied operation.
 */
function emulateDeny(command: string): string {
  return command.includes('reached-allowed-') ? command : command.slice(0, command.indexOf('; ') + 2) + 'exit 73';
}

function marker(command: string): string {
  const match = /'(reached-[^']+)'/.exec(command);
  if (!match) throw new Error('Missing test marker');
  return match[1];
}

function resultFor(command: string, extra: Partial<SandboxSelfTestRunResult> = {}): SandboxSelfTestRunResult {
  return {
    stdout: `${marker(command)}\n`,
    stderr: '',
    exitCode: 73,
    timedOut: false,
    overflowed: false,
    ...extra,
  };
}

function harness(transform: (command: string, fixture: SandboxSelfTestFixture) => string = emulateDeny): {
  options: SandboxSelfTestOptions;
  fixtures: SandboxSelfTestFixture[];
  release: ReturnType<typeof vi.fn>;
} {
  const fixtures: SandboxSelfTestFixture[] = [];
  const release = vi.fn();
  return {
    fixtures,
    release,
    options: {
      wrap: (command, fixture) => {
        fixtures.push({ ...fixture });
        return Promise.resolve(transform(command, fixture));
      },
      release,
    },
  };
}

async function expectClean(fixtures: SandboxSelfTestFixture[]): Promise<void> {
  expect(fixtures.length).toBeGreaterThan(0);
  await Promise.all(
    [...new Set(fixtures.map((fixture) => fixture.root))].map(async (root) => {
      await expect(access(root)).rejects.toThrow(/ENOENT/);
    }),
  );
}

describe('runSandboxSelfTest', () => {
  test('real subprocess positive controls, emulated denials, balanced releases and cleanup', async () => {
    const h = harness();
    const originalWrap = h.options.wrap;
    const allowedWrites: string[][] = [];
    h.options.wrap = async (command, fixture) => {
      expect(await readFile(fixture.readDenied, 'utf8')).toMatch(/^synthetic-secret-/);
      expect(await readFile(fixture.writeDenied, 'utf8')).toMatch(/^synthetic-original-/);
      if (!command.includes('reached-allowed-')) {
        allowedWrites.push(
          await Promise.all([
            readFile(join(fixture.root, 'workspace', 'allowed'), 'utf8'),
            readFile(join(fixture.root, 'tmp', 'allowed'), 'utf8'),
          ]),
        );
      }
      return originalWrap(command, fixture);
    };
    const result = await runSandboxSelfTest(h.options);
    expect(allowedWrites).toEqual([
      ['allowed\n', 'allowed\n'],
      ['allowed\n', 'allowed\n'],
    ]);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      'Network: not actively probed (configured mode preserved by caller).',
      'PASS: synthetic read/write targets exist and are readable on the host.',
      'PASS: allowed workspace/temp write.',
      'PASS: denied read.',
      'PASS: denied write.',
    ]);
    expect(h.release).toHaveBeenCalledTimes(3);
    await expectClean(h.fixtures);
  });

  test.each(['unsupported native sandbox', 'native setup failed'])(
    'wrap error: %s has no fallback or release',
    async (reason) => {
      const h = harness();
      const originalWrap = h.options.wrap;
      h.options.wrap = async (command, fixture) => {
        await originalWrap(command, fixture);
        throw new Error(reason);
      };
      const run = vi.fn();
      const result = await runSandboxSelfTest({ ...h.options, run });
      expect(result.ok).toBe(false);
      expect(result.lines.join('\n')).toContain('native wrap/setup');
      expect(run).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      await expectClean(h.fixtures);
    },
  );

  test('injected spawn rejection releases a successful wrap exactly once', async () => {
    const h = harness();
    const result = await runSandboxSelfTest({
      ...h.options,
      run: () => Promise.reject(new Error('spawn failed')),
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('spawn/run');
    expect(h.release).toHaveBeenCalledTimes(1);
    await expectClean(h.fixtures);
  });

  test('real spawn error (removed cwd) is failure and releases/cleans', async () => {
    const h = harness();
    const originalWrap = h.options.wrap;
    h.options.wrap = async (command, fixture) => {
      await rm(join(fixture.root, 'workspace'), { recursive: true });
      return originalWrap(command, fixture);
    };
    const result = await runSandboxSelfTest(h.options);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('spawn/run');
    expect(h.release).toHaveBeenCalledTimes(1);
    await expectClean(h.fixtures);
  });

  test('invalid timeout fails fixture setup before wrapping', async () => {
    const h = harness();
    await Promise.all(
      [0, -1, NaN, Infinity, 2_147_483_648].map(async (timeoutMs) => {
        const result = await runSandboxSelfTest({ ...h.options, timeoutMs });
        expect(result.ok).toBe(false);
        expect(result.lines.join('\n')).toContain('fixture setup');
      }),
    );
    expect(h.fixtures).toEqual([]);
    expect(h.release).not.toHaveBeenCalled();
  });

  test.each(['read', 'write'])('%s setup error before reached marker is not a successful denial', async (probe) => {
    const h = harness((command) => (command.includes(`reached-${probe}-`) ? 'exit 73' : emulateDeny(command)));
    const result = await runSandboxSelfTest(h.options);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('inconclusive (reached marker missing)');
    expect(h.release).toHaveBeenCalledTimes(probe === 'read' ? 2 : 3);
    await expectClean(h.fixtures);
  });

  test.each(['read', 'write'])('%s unexpectedly permitted fails safely using synthetic files only', async (probe) => {
    const h = harness((command) => (command.includes(`reached-${probe}-`) ? command : emulateDeny(command)));
    const result = await runSandboxSelfTest(h.options);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain(`FAIL: denied ${probe}`);
    expect(result.lines.join('\n')).not.toContain('synthetic-secret-');
    expect(h.release).toHaveBeenCalledTimes(probe === 'read' ? 2 : 3);
    await expectClean(h.fixtures);
  });

  test('a claimed denial cannot conceal a changed denied file', async () => {
    const h = harness();
    const result = await runSandboxSelfTest({
      ...h.options,
      run: async (command, options) => {
        if (!command.includes('reached-write-')) return runSandboxSelfTestCommand(command, options);
        await writeFile(h.fixtures[0].writeDenied, 'changed despite reported denial\n');
        return resultFor(command);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('denied file changed');
    expect(h.release).toHaveBeenCalledTimes(3);
    await expectClean(h.fixtures);
  });

  test.each(['stdout', 'stderr'] as const)('token emitted on %s fails even with a denial exit code', async (stream) => {
    const h = harness();
    const result = await runSandboxSelfTest({
      ...h.options,
      run: async (command, options) => {
        if (!command.includes('reached-read-')) return runSandboxSelfTestCommand(command, options);
        const token = await readFile(h.fixtures[0].readDenied, 'utf8');
        return resultFor(command, { [stream]: `${marker(command)}\n${token}` });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('synthetic token emitted');
    expect(result.lines.join('\n')).not.toContain('synthetic-secret-');
    expect(h.release).toHaveBeenCalledTimes(2);
    await expectClean(h.fixtures);
  });

  test.each([{ timedOut: true }, { overflowed: true }, { exitCode: null }, { exitCode: 127 }])(
    'execution failure with a reached marker is not a denial: %j',
    async (failure) => {
      const h = harness();
      const result = await runSandboxSelfTest({
        ...h.options,
        run: (command, options) =>
          command.includes('reached-read-')
            ? Promise.resolve(resultFor(command, failure))
            : runSandboxSelfTestCommand(command, options),
      });
      expect(result.ok).toBe(false);
      expect(result.lines.join('\n')).not.toContain('PASS: denied read.');
      expect(h.release).toHaveBeenCalledTimes(2);
      await expectClean(h.fixtures);
    },
  );

  test('baseline exit success without actual allowed writes fails its positive control', async () => {
    const h = harness();
    const result = await runSandboxSelfTest({
      ...h.options,
      run: (command) => Promise.resolve(resultFor(command, { exitCode: 0 })),
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('FAIL: allowed workspace/temp write');
    expect(h.release).toHaveBeenCalledTimes(1);
    await expectClean(h.fixtures);
  });

  test('release failure is reported once and fixtures still cleaned', async () => {
    const h = harness();
    h.release.mockImplementation(() => {
      throw new Error('release failed');
    });
    const result = await runSandboxSelfTest(h.options);
    expect(result.ok).toBe(false);
    expect(h.release).toHaveBeenCalledTimes(1);
    await expectClean(h.fixtures);
  });

  test('real timeout kills a waiting process group before release and cleanup', async () => {
    const h = harness(() => 'sleep 30 & wait');
    const run = vi.fn(runSandboxSelfTestCommand);
    const result = await runSandboxSelfTest({ ...h.options, run, timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('timeout');
    const execution: unknown = await run.mock.results[0].value;
    if (
      typeof execution !== 'object' ||
      execution === null ||
      !('timedOut' in execution) ||
      !('exitCode' in execution)
    ) {
      throw new Error('Missing timeout execution result');
    }
    expect(execution.timedOut).toBe(true);
    expect(execution.exitCode).toBeNull();
    expect(h.release).toHaveBeenCalledTimes(1);
    await expectClean(h.fixtures);
  });

  test('real output overflow is bounded, kills the group, releases and cleans', async () => {
    const h = harness(() => "while :; do printf '%01000d' 0; done");
    const run = vi.fn(runSandboxSelfTestCommand);
    const result = await runSandboxSelfTest({ ...h.options, run, timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('output limit exceeded');
    const execution: unknown = await run.mock.results[0].value;
    if (
      typeof execution !== 'object' ||
      execution === null ||
      !('overflowed' in execution) ||
      !('stdout' in execution) ||
      typeof execution.stdout !== 'string' ||
      !('stderr' in execution) ||
      typeof execution.stderr !== 'string'
    ) {
      throw new Error('Missing output overflow execution result');
    }
    expect(execution.overflowed).toBe(true);
    expect(execution.stdout.length + execution.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(h.release).toHaveBeenCalledTimes(1);
    await expectClean(h.fixtures);
  });
});
