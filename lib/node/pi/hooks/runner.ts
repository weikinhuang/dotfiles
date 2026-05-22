/**
 * Subprocess runner for the `hooks` extension.
 *
 * Given a {@link Hook} and a serialized event payload, this module:
 *
 *   1. Spawns the hook's `command` with stdin = JSON payload (via the
 *      injected {@link HookSpawnFn} so vitest can stub it).
 *   2. Honors the hook's `timeout` (default {@link DEFAULT_TIMEOUT_MS})
 *      and the caller's `AbortSignal`. On timeout the spawn helper
 *      kills the child and reports `timedOut: true`; we log a warning
 *      and surface a `block` result.
 *   3. Parses stdout - if it's valid JSON with a recognized `decision`
 *      field we use it directly; otherwise the whole stdout is treated
 *      as `additionalContext` with `decision: "continue"`.
 *   4. Non-zero exit (and the process was NOT timed out) → `block`
 *      with `stderr` as `reason`. Mirrors Claude Code.
 *
 * Pure-ish: I/O happens through the injectable {@link HookSpawnFn}, so
 * tests pass a stub function and exercise every branch without
 * touching the kernel. The real {@link nodeChildProcessSpawn}
 * implementation is exported for the extension shell to wire in.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { type Hook } from './config.ts';

export const DEFAULT_TIMEOUT_MS = 60000;

export type HookDecision = 'allow' | 'block' | 'continue';

export interface HookResult {
  decision: HookDecision;
  reason?: string;
  additionalContext?: string;
  /** True when the process was killed for exceeding `hook.timeout`. */
  timedOut?: boolean;
}

export interface HookSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the runner aborted the process for exceeding `timeoutMs`. */
  timedOut: boolean;
}

export interface HookSpawnOptions {
  /** Resolved absolute command path. `~` already expanded by the caller. */
  command: string;
  /** JSON payload written to the child's stdin. */
  payload: string;
  /** Hard ceiling - the helper MUST kill the child by `timeoutMs`. */
  timeoutMs: number;
  /** Caller-supplied abort signal; an external abort behaves like a timeout. */
  signal: AbortSignal;
  /** Working directory the child is spawned into. */
  cwd: string;
  /** Whether to launch the hook via `sandbox.ts`. v1 leaves the wrapper to the caller. */
  sandboxed: boolean;
}

export type HookSpawnFn = (opts: HookSpawnOptions) => Promise<HookSpawnResult>;

// ──────────────────────────────────────────────────────────────────────
// Result parsing
// ──────────────────────────────────────────────────────────────────────

const VALID_DECISIONS: ReadonlySet<HookDecision> = new Set(['allow', 'block', 'continue']);

function isHookDecision(value: unknown): value is HookDecision {
  return typeof value === 'string' && VALID_DECISIONS.has(value as HookDecision);
}

/**
 * Parse a hook's stdout payload into a {@link HookResult}. Exported
 * for direct unit testing - the runner happy path runs through this
 * exact function.
 */
export function parseHookStdout(stdout: string): HookResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { decision: 'continue' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { decision: 'continue', additionalContext: stdout };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { decision: 'continue', additionalContext: stdout };
  }
  const obj = parsed as Record<string, unknown>;
  const decision = isHookDecision(obj.decision) ? obj.decision : 'continue';
  const result: HookResult = { decision };
  if (typeof obj.reason === 'string') result.reason = obj.reason;
  if (typeof obj.additionalContext === 'string') result.additionalContext = obj.additionalContext;
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────

export interface RunHookOptions {
  hook: Hook;
  payload: unknown;
  signal: AbortSignal;
  cwd: string;
  spawnFn: HookSpawnFn;
  /** Override the timeout default in tests. */
  defaultTimeoutMs?: number;
}

/**
 * Run a single hook to completion and return its decision.
 *
 * Returns a {@link HookResult}; never throws for an aborted /
 * timed-out / crashed hook - those all map to `block` (or the
 * caller-defined `continue` for fire-and-forget events).
 */
export async function runHook(opts: RunHookOptions): Promise<HookResult> {
  const { hook, payload, signal, cwd, spawnFn } = opts;
  const timeoutMs = hook.timeout ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const serialized = JSON.stringify(payload);
  let res: HookSpawnResult;
  try {
    res = await spawnFn({
      command: hook.command,
      payload: serialized,
      timeoutMs,
      signal,
      cwd,
      sandboxed: hook.sandboxed ?? false,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[hooks] failed to spawn ${JSON.stringify(hook.command)}: ${reason}`);
    return { decision: 'block', reason: `failed to spawn hook: ${reason}` };
  }

  if (res.timedOut) {
    console.warn(`[hooks] ${JSON.stringify(hook.command)} timed out after ${timeoutMs}ms; killed`);
    return {
      decision: 'block',
      reason: `hook timed out after ${timeoutMs}ms`,
      timedOut: true,
    };
  }

  if (res.exitCode !== 0) {
    const stderr = res.stderr.trim();
    return {
      decision: 'block',
      reason: stderr.length > 0 ? stderr : `hook exited with code ${res.exitCode}`,
    };
  }

  return parseHookStdout(res.stdout);
}

// ──────────────────────────────────────────────────────────────────────
// Real spawn implementation
// ──────────────────────────────────────────────────────────────────────

/**
 * Real {@link HookSpawnFn} backed by `node:child_process.spawn`. The
 * extension shell wires this in; tests inject a stub.
 *
 * Hooks are invoked through the user's shell (`sh -c <command>`) so
 * the config can contain pipes / redirects / etc - matches Claude
 * Code's `Bash`-style hook invocation. The `~` in `hook.command` is
 * the caller's responsibility to expand before reaching this function.
 */
export const nodeChildProcessSpawn: HookSpawnFn = async (opts) => {
  return new Promise<HookSpawnResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn('sh', ['-c', opts.command], {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolvePromise({
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: 1,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const onAbort = (): void => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolvePromise({ stdout, stderr, exitCode, timedOut });
    };

    child.on('error', (err) => {
      stderr += stderr.length === 0 ? err.message : `\n${err.message}`;
      settle(1);
    });
    child.on('close', (code) => settle(code));

    try {
      child.stdin?.end(opts.payload);
    } catch {
      // Child may have died between spawn and stdin write; the close
      // handler will fire with the actual exit information.
    }
  });
};
