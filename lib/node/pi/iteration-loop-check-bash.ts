/**
 * Bash-kind check executor for the iteration-loop.
 *
 * Runs the declared shell command under `/bin/bash -c`, captures
 * stdout/stderr/exit, and classifies pass/fail per the spec's
 * `passOn` predicate:
 *
 *   - `exit-zero` (default): exit code 0 = pass.
 *   - `regex:<pattern>`: stdout matches JS regex (no flags). Exit
 *     code is ignored.
 *   - `jq:<expr>`: apply `jq -e <expr>` to stdout; pass iff jq exits
 *     0 AND output is truthy. Requires `jq` on PATH.
 *
 * The resulting `Verdict` uses score 1.0 for pass, 0.0 for fail —
 * bash is binary. Issues are populated on fail with a single entry
 * summarizing the failure shape ("exit 2", "regex did not match",
 * "jq: expected .status=='ok'") so the model has something to react
 * to.
 *
 * Pure function wrapping `child_process.spawn`. Tests can inject a
 * fake executor via the optional `spawnImpl` param to avoid touching
 * the real shell.
 *
 * Layout: every helper is declared before the public entry point
 * (`runBashCheck`) at the bottom so no-use-before-define stays happy.
 */

import { type ChildProcess, spawn as spawnDefault } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

import { type BashCheckSpec, type Issue, type Verdict } from './iteration-loop-schema.ts';

const DEFAULT_TIMEOUT_MS = 60_000; // deliberately tighter than DEFAULT_BUDGET.wallClockSeconds (600s); a bash check is one iteration step, not the whole loop.
const STREAM_BUFFER_MAX = 8 * 1024; // per-stream cap (stdout & stderr each); truncate observation dumps so prompts stay compact

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface BashRunEnvironment {
  /**
   * cwd for the check's child process. Almost always the agent's cwd;
   * tests can pass a temp dir.
   */
  cwd: string;
  /** Additional env merged onto `process.env`. */
  env?: Record<string, string>;
}

export interface BashRunResult extends Verdict {
  /**
   * Populated extras so the extension can feed the full observation
   * into the assistant context separately from the summarized verdict.
   */
  observation: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
  };
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe'] | ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcess;

interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  spawnError: string | null;
}

interface ClassifyOut {
  passed: boolean;
  failReason: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Small utilities
// ──────────────────────────────────────────────────────────────────────

function resolveWorkdir(workdir: string, cwd: string): string {
  return isAbsolute(workdir) ? workdir : resolve(cwd, workdir);
}

function renderRawObservation(exec: ExecResult): string {
  const parts: string[] = [];
  parts.push(`exit: ${exec.exitCode ?? 'null'}${exec.signal ? ` (signal ${exec.signal})` : ''}`);
  if (exec.timedOut) parts.push('[timed out]');
  if (exec.truncated) parts.push('[output truncated]');
  if (exec.stdout) parts.push('--- stdout ---\n' + exec.stdout);
  if (exec.stderr) parts.push('--- stderr ---\n' + exec.stderr);
  return parts.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Process execution
// ──────────────────────────────────────────────────────────────────────

function runProcess(
  spawnFn: SpawnLike,
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ExecResult> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawnFn('/bin/bash', ['-c', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      done({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        spawnError: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;

    const appendCapped = (current: string, chunk: string): string => {
      if (current.length >= STREAM_BUFFER_MAX) {
        truncated = true;
        return current;
      }
      const room = STREAM_BUFFER_MAX - current.length;
      if (chunk.length > room) {
        truncated = true;
        return current + chunk.slice(0, room);
      }
      return current + chunk;
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout = appendCapped(stdout, d);
    });
    child.stderr?.on('data', (d: string) => {
      stderr = appendCapped(stderr, d);
    });

    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if it didn't die within a grace period.
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2_000).unref();
    }, timeoutMs);
    killer.unref();

    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2_000).unref();
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const finalize = (result: ExecResult): void => {
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      done(result);
    };

    child.on('error', (err) => {
      finalize({
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        timedOut,
        truncated,
        spawnError: err.message,
      });
    });

    child.on('close', (code, sig) => {
      finalize({
        exitCode: code,
        signal: sig,
        stdout,
        stderr: aborted && !stderr.includes('[aborted]') ? stderr + '\n[aborted]' : stderr,
        timedOut,
        truncated,
        spawnError: null,
      });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Predicates
// ──────────────────────────────────────────────────────────────────────

function classifyResult(spec: BashCheckSpec, exec: ExecResult): ClassifyOut {
  if (exec.spawnError) {
    return { passed: false, failReason: `spawn failed: ${exec.spawnError}` };
  }
  if (exec.timedOut) {
    return { passed: false, failReason: `timed out after ${spec.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` };
  }
  const passOn = spec.passOn ?? 'exit-zero';
  if (passOn === 'exit-zero') {
    if (exec.exitCode === 0) return { passed: true, failReason: null };
    return {
      passed: false,
      failReason:
        exec.signal !== null ? `process killed by signal ${exec.signal}` : `exit ${exec.exitCode ?? 'unknown'}`,
    };
  }
  if (passOn.startsWith('regex:')) {
    const pattern = passOn.slice('regex:'.length);
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { passed: false, failReason: `invalid regex "${pattern}": ${(e as Error).message}` };
    }
    return re.test(exec.stdout)
      ? { passed: true, failReason: null }
      : { passed: false, failReason: `stdout did not match regex /${pattern}/` };
  }
  if (passOn.startsWith('jq:')) {
    // Evaluated out-of-line in `runJqPredicate` (spawns `jq`). The
    // main entry point stitches its result back into the verdict.
    return { passed: false, failReason: '__jq_pending__' };
  }
  return { passed: false, failReason: `unknown passOn predicate "${passOn}"` };
}

// ──────────────────────────────────────────────────────────────────────
// Verdict assembly
// ──────────────────────────────────────────────────────────────────────

function buildVerdict(exec: ExecResult, passed: boolean, failReason: string | null): BashRunResult {
  const issues: Issue[] = passed
    ? []
    : [
        {
          severity: 'blocker',
          description: failReason ?? 'check failed',
        },
      ];
  const summary = passed
    ? `bash check passed${exec.exitCode !== null ? ` (exit ${exec.exitCode})` : ''}`
    : (failReason ?? 'bash check failed');
  return {
    approved: passed,
    score: passed ? 1 : 0,
    issues,
    summary,
    raw: renderRawObservation(exec),
    observation: {
      exitCode: exec.exitCode,
      signal: exec.signal,
      stdout: exec.stdout,
      stderr: exec.stderr,
      timedOut: exec.timedOut,
      truncated: exec.truncated,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// jq: predicate (async)
// ──────────────────────────────────────────────────────────────────────

/**
 * Post-run evaluator for a `jq:<expr>` predicate. Kept separate from
 * the sync classifier because it spawns a subprocess.
 *
 * Returns `{ passed: boolean, failReason: string | null }` matching
 * `classifyResult`'s shape so the main entry point can stitch the two
 * together.
 *
 * Pass conditions: `jq -e <expr>` exits 0 AND writes a truthy value
 * (non-false, non-null) to stdout.
 *
 * When `jq` isn't on PATH, fail with a clear diagnostic.
 */
export async function runJqPredicate(
  expr: string,
  stdin: string,
  opts: { spawnImpl?: SpawnLike; signal?: AbortSignal } = {},
): Promise<ClassifyOut> {
  const spawnFn = opts.spawnImpl ?? spawnDefault;
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawnFn('jq', ['-e', expr], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      done({ passed: false, failReason: `jq spawn failed: ${(e as Error).message}` });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
    });
    child.stderr?.on('data', (d: string) => {
      err += d;
    });
    const onAbort = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1_000).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      const code = (e as NodeJS.ErrnoException).code;
      const msg = code === 'ENOENT' ? 'jq not found on PATH' : e.message;
      done({ passed: false, failReason: `jq: ${msg}` });
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        const trimmed = out.trim();
        if (trimmed === '' || trimmed === 'null' || trimmed === 'false') {
          done({ passed: false, failReason: `jq expression evaluated falsy: ${trimmed || '(empty)'}` });
          return;
        }
        done({ passed: true, failReason: null });
      } else {
        done({
          passed: false,
          failReason: `jq exited ${code}${err.trim() ? ` — ${err.trim().split('\n')[0]}` : ''}`,
        });
      }
    });
    try {
      child.stdin?.end(stdin);
    } catch {
      /* stdin already closed — harmless */
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Main entry point — placed last so all helpers it fans out to are
// already declared above.
// ──────────────────────────────────────────────────────────────────────

export async function runBashCheck(
  spec: BashCheckSpec,
  env: BashRunEnvironment,
  opts: { spawnImpl?: SpawnLike; signal?: AbortSignal } = {},
): Promise<BashRunResult> {
  const spawnFn = opts.spawnImpl ?? spawnDefault;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = spec.workdir ? resolveWorkdir(spec.workdir, env.cwd) : env.cwd;
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env.env, ...spec.env };

  const exec = await runProcess(spawnFn, spec.cmd, cwd, mergedEnv, timeoutMs, opts.signal);
  let { passed, failReason } = classifyResult(spec, exec);

  // `jq:` pass predicates are deferred out of the sync classifier
  // because they spawn `jq`. Only run the async tail when the command
  // itself didn't already fail (spawn error, timeout, signal, etc.).
  const passOn = spec.passOn ?? 'exit-zero';
  if (passOn.startsWith('jq:') && failReason === '__jq_pending__') {
    if (exec.spawnError) {
      failReason = `spawn failed: ${exec.spawnError}`;
    } else if (exec.timedOut) {
      failReason = `timed out after ${timeoutMs}ms`;
    } else {
      const jqExpr = passOn.slice('jq:'.length);
      const jqResult = await runJqPredicate(jqExpr, exec.stdout, {
        spawnImpl: opts.spawnImpl,
        signal: opts.signal,
      });
      passed = jqResult.passed;
      failReason = jqResult.failReason;
    }
  }

  return buildVerdict(exec, passed, failReason);
}
