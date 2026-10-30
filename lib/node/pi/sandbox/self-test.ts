/** Synthetic filesystem probes only. The caller must serialize native wraps,
 * apply fixture allow/deny overrides, and preserve its configured network mode.
 * There is deliberately no unsandboxed fallback and no network probe.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SandboxSelfTestFixture {
  root: string;
  readDenied: string;
  writeDenied: string;
}

export interface SandboxSelfTestRunOptions {
  cwd: string;
  timeoutMs: number;
}

export interface SandboxSelfTestRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  overflowed: boolean;
}

export type SandboxSelfTestRunner = (
  command: string,
  options: SandboxSelfTestRunOptions,
) => Promise<SandboxSelfTestRunResult>;

export interface SandboxSelfTestOptions {
  /** Strict native wrapper only. A resolved wrap owns one release. */
  wrap: (command: string, fixture: SandboxSelfTestFixture) => Promise<string>;
  release: () => void;
  timeoutMs?: number;
  /** Must honor the same timeout, output bounds, and close-before-return contract. */
  run?: SandboxSelfTestRunner;
}

const OUTPUT_LIMIT = 64 * 1024;

/** POSIX shell runner. Kill the whole process group, then await close, before
 * releasing sandbox resources or removing fixtures. Never uses spawnSync.
 */
export const runSandboxSelfTestCommand: SandboxSelfTestRunner = (command, options) => {
  if (process.platform === 'win32') return Promise.reject(new Error('POSIX shell required'));
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let overflowed = false;
    let spawnError: Error | undefined;
    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group may already have exited. Still wait for close below.
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const remaining = Math.max(0, OUTPUT_LIMIT - bytes);
      bytes += chunk.length;
      const text = chunk.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (bytes > OUTPUT_LIMIT && !overflowed) {
        overflowed = true;
        kill();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.on('error', (error) => {
      spawnError = error;
      kill();
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (spawnError) reject(spawnError);
      else resolve({ stdout, stderr, exitCode, timedOut, overflowed });
    });
  });
};

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Does not include subprocess output or exception text in diagnostics, even
 * when a broken wrapper leaks the synthetic token. All paths are freshly owned.
 */
export async function runSandboxSelfTest(options: SandboxSelfTestOptions): Promise<{ ok: boolean; lines: string[] }> {
  const lines = ['Network: not actively probed (configured mode preserved by caller).'];
  const timeoutMs = options.timeoutMs ?? 5000;
  let root: string | undefined;
  let phase = 'fixture setup';
  let ok = false;
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error('Invalid timeout');
    }
    root = await mkdtemp(join(tmpdir(), 'pi-sandbox-self-test-'));
    // Canonical paths matter on macOS, where /var is a symlink to /private/var.
    const canonicalRoot = await realpath(root);
    const fixture: SandboxSelfTestFixture = {
      root: canonicalRoot,
      readDenied: join(canonicalRoot, 'read-denied'),
      writeDenied: join(canonicalRoot, 'write-denied'),
    };
    const workspace = join(canonicalRoot, 'workspace');
    const temp = join(canonicalRoot, 'tmp');
    await mkdir(workspace);
    await mkdir(temp);
    const secret = `synthetic-secret-${randomUUID()}`;
    const original = `synthetic-original-${randomUUID()}\n`;
    await writeFile(fixture.readDenied, `${secret}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(fixture.writeDenied, original, { flag: 'wx', mode: 0o600 });
    if (
      (await readFile(fixture.readDenied, 'utf8')) !== `${secret}\n` ||
      (await readFile(fixture.writeDenied, 'utf8')) !== original
    )
      throw new Error('Host controls failed');
    lines.push('PASS: synthetic read/write targets exist and are readable on the host.');

    const workspaceOutput = join(workspace, 'allowed');
    const tempOutput = join(temp, 'allowed');
    const probes = [
      {
        name: 'allowed workspace/temp write',
        marker: `reached-allowed-${randomUUID()}`,
        operation: `printf '%s\\n' allowed > ${quote(workspaceOutput)} && printf '%s\\n' allowed > ${quote(tempOutput)}`,
        denied: false,
      },
      {
        name: 'denied read',
        marker: `reached-read-${randomUUID()}`,
        operation: `if IFS= read -r value < ${quote(fixture.readDenied)}; then printf '%s\\n' "$value"; exit 0; else exit 73; fi`,
        denied: true,
      },
      {
        name: 'denied write',
        marker: `reached-write-${randomUUID()}`,
        operation: `if printf '%s\\n' changed > ${quote(fixture.writeDenied)}; then exit 0; else exit 73; fi`,
        denied: true,
      },
    ];
    const run = options.run ?? runSandboxSelfTestCommand;
    // Probes are deliberately sequential: establish the positive control
    // before counting denials, and balance each native wrap before the next.
    await probes.reduce(async (previous, probe) => {
      await previous;
      phase = `${probe.name}: native wrap/setup`;
      const command = `printf '%s\\n' ${quote(probe.marker)}; ${probe.operation}`;
      const wrapped = await options.wrap(command, fixture);
      let result: SandboxSelfTestRunResult;
      try {
        phase = `${probe.name}: spawn/run`;
        result = await run(wrapped, { cwd: workspace, timeoutMs });
      } finally {
        options.release();
      }
      phase = probe.name;
      if (result.timedOut) {
        phase += ': timeout';
        throw new Error('Timeout');
      }
      if (result.overflowed) {
        phase += ': output limit exceeded';
        throw new Error('Output overflow');
      }
      if (result.exitCode === null) throw new Error('Terminated');
      if (result.stdout.includes(secret) || result.stderr.includes(secret)) {
        phase += ': synthetic token emitted';
        throw new Error('Token leaked');
      }
      if (!result.stdout.split(/\r?\n/).includes(probe.marker)) {
        phase += ': inconclusive (reached marker missing)';
        throw new Error('Probe not reached');
      }
      if (result.exitCode !== (probe.denied ? 73 : 0)) {
        phase += ': unexpected exit status (operation permitted or failed incorrectly)';
        throw new Error('Unexpected operation result');
      }
      if ((await readFile(fixture.writeDenied, 'utf8')) !== original) {
        phase += ': denied file changed';
        throw new Error('Denied file changed');
      }
      if (
        !probe.denied &&
        ((await readFile(workspaceOutput, 'utf8')) !== 'allowed\n' ||
          (await readFile(tempOutput, 'utf8')) !== 'allowed\n')
      )
        throw new Error('Allowed write failed');
      lines.push(`PASS: ${probe.name}.`);
    }, Promise.resolve());
    ok = true;
  } catch {
    lines.push(`FAIL: ${phase} (setup, execution, or verification failed; not a successful deny).`);
  } finally {
    if (root !== undefined) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        ok = false;
        lines.push('FAIL: synthetic fixture cleanup.');
      }
    }
  }
  return { ok, lines };
}
