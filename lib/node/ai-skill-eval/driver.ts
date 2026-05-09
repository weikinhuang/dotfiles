// Driver dispatch for ai-skill-eval: spawns the configured LLM command with
// the prompt file as input and captures combined stdout+stderr into an
// output file (matching the bash `> $out 2>&1` redirection semantics).
//
// R1b turned driver invocation async so multiple calls can run concurrently
// through `concurrency.runPool` and so each call can enforce a per-query
// timeout. On timeout we SIGTERM the child, SIGKILL ~2s later if it hasn't
// exited, and append a `DRIVER_TIMEOUT` marker line to the output file so
// the grader can surface it as a flaw.
// SPDX-License-Identifier: MIT

import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, statSync } from 'node:fs';

import { type DriverKind } from './types.ts';

/** Grace period between SIGTERM and the SIGKILL fallback on timeout. */
const SIGKILL_GRACE_MS = 2000;

export interface DriverConfig {
  driver: DriverKind | null;
  driverCmd: string | null;
  model: string | null;
  /** Per-invocation timeout in milliseconds. `null` / `0` / negative means no timeout. */
  timeoutMs?: number | null;
}

export interface DriverResult {
  exitCode: number;
  durationSec: number;
  bytes: number;
  timedOut: boolean;
}

export interface CriticInvocation {
  exitCode: number;
  stdout: string;
}

function hasCommand(cmd: string): boolean {
  const r = spawnSync('bash', ['-c', `command -v ${cmd} >/dev/null 2>&1`]);
  return r.status === 0;
}

interface SpawnToFileResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Spawn `cmd` with stdout+stderr redirected into `outputFile`, returning when
 * the child exits (or when the timeout has forcibly killed it).
 *
 * When `timeoutMs` elapses we SIGTERM the process group, wait
 * {@link SIGKILL_GRACE_MS} for a graceful exit, then SIGKILL. On any timeout
 * kill we append a literal `DRIVER_TIMEOUT` line to `outputFile` so the
 * grader can detect the timeout even if the child managed to flush partial
 * output first.
 */
function spawnToFileAsync(
  cmd: string,
  args: readonly string[],
  outputFile: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number | null; devNullStdio?: boolean } = {},
): Promise<SpawnToFileResult> {
  return new Promise<SpawnToFileResult>((resolve) => {
    // `devNullStdio` lets the codex driver redirect stdout/stderr to /dev/null
    // while still using `outputFile` for the appended DRIVER_TIMEOUT marker.
    const stdioFd = options.devNullStdio ? openSync('/dev/null', 'w') : openSync(outputFile, 'w');
    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', stdioFd, stdioFd],
      env: options.env ?? process.env,
    };
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (err) {
      try {
        closeSync(stdioFd);
      } catch {
        // ignore
      }
      void err;
      resolve({ exitCode: 127, timedOut: false });
      return;
    }

    let timedOut = false;
    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      termTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, SIGKILL_GRACE_MS);
      }, timeoutMs);
    }

    const finish = (exitCode: number): void => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      try {
        closeSync(stdioFd);
      } catch {
        // ignore
      }
      if (timedOut) {
        try {
          appendFileSync(outputFile, '\nDRIVER_TIMEOUT\n');
        } catch {
          // ignore
        }
      }
      resolve({ exitCode, timedOut });
    };

    child.once('error', () => finish(127));
    child.once('exit', (code, signal) => {
      if (code != null) finish(code);
      else if (signal) finish(137);
      else finish(1);
    });
  });
}

/**
 * Synchronous variant used by {@link invokeCritic}. The critic is only called
 * once per eval (not in the parallelised hot path) so keeping it sync avoids
 * touching the critic's callers.
 */
function spawnToFileSync(
  cmd: string,
  args: readonly string[],
  outputFile: string,
  options: SpawnSyncOptions = {},
): number {
  const fd = openSync(outputFile, 'w');
  try {
    const r = spawnSync(cmd, args, {
      ...options,
      stdio: ['ignore', fd, fd],
    });
    return r.status ?? (r.error ? 127 : 1);
  } finally {
    closeSync(fd);
  }
}

function runPi(
  promptFile: string,
  outputFile: string,
  model: string,
  timeoutMs: number | null,
): Promise<SpawnToFileResult> {
  const prompt = readFileSync(promptFile, 'utf8');
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  return spawnToFileAsync('pi', ['-p', prompt, '--model', model, '--no-session'], outputFile, { env, timeoutMs });
}

function runClaude(
  promptFile: string,
  outputFile: string,
  model: string | null,
  timeoutMs: number | null,
): Promise<SpawnToFileResult> {
  const prompt = readFileSync(promptFile, 'utf8');
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  args.push('--bare');
  return spawnToFileAsync('claude', args, outputFile, { timeoutMs });
}

function runCodex(
  promptFile: string,
  outputFile: string,
  model: string | null,
  timeoutMs: number | null,
): Promise<SpawnToFileResult> {
  // codex exec decorates stdout with session headers + token usage, so
  // we use its -o flag to capture just the final message directly into
  // outputFile. stdout/stderr are redirected to /dev/null so the decorated
  // log doesn't clobber the captured reply.
  //
  // Sandbox policy is deliberately unpinned: codex reads the user's
  // ~/.codex/config.toml default. Revisit if a run gets blocked.
  const prompt = readFileSync(promptFile, 'utf8');
  const args = ['exec', '--skip-git-repo-check', '-o', outputFile, '--cd', process.cwd()];
  if (model) args.push('-m', model);
  args.push(prompt);
  return spawnToFileAsync('codex', args, outputFile, { timeoutMs, devNullStdio: true });
}

function runCustom(
  driverCmd: string,
  promptFile: string,
  outputFile: string,
  timeoutMs: number | null,
): Promise<SpawnToFileResult> {
  return spawnToFileAsync('bash', ['-c', driverCmd], outputFile, {
    env: { ...process.env, AI_SKILL_EVAL_PROMPT_FILE: promptFile },
    timeoutMs,
  });
}

/** Resolve which built-in driver to use, honoring an explicit config, then env, then PATH probing. */
export function resolveDriver(cfg: DriverConfig): DriverKind {
  if (cfg.driver) return cfg.driver;
  const envDriver = process.env.AI_SKILL_EVAL_DRIVER;
  if (envDriver === 'pi' || envDriver === 'claude' || envDriver === 'codex') return envDriver;
  if (hasCommand('pi')) return 'pi';
  if (hasCommand('claude')) return 'claude';
  if (hasCommand('codex')) return 'codex';
  return 'pi';
}

export async function invokeDriver(cfg: DriverConfig, promptFile: string, outputFile: string): Promise<DriverResult> {
  const start = Date.now();
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : null;
  let outcome: SpawnToFileResult;
  if (cfg.driverCmd) {
    outcome = await runCustom(cfg.driverCmd, promptFile, outputFile, timeoutMs);
  } else {
    const driver = resolveDriver(cfg);
    if (driver === 'pi') {
      const model = cfg.model ?? process.env.AI_SKILL_EVAL_MODEL ?? 'llama-cpp/qwen3-6-35b-a3b';
      outcome = await runPi(promptFile, outputFile, model, timeoutMs);
    } else if (driver === 'claude') {
      const model = cfg.model ?? process.env.AI_SKILL_EVAL_MODEL ?? null;
      outcome = await runClaude(promptFile, outputFile, model, timeoutMs);
    } else if (driver === 'codex') {
      const model = cfg.model ?? process.env.AI_SKILL_EVAL_MODEL ?? null;
      outcome = await runCodex(promptFile, outputFile, model, timeoutMs);
    } else {
      throw new Error(`unknown driver '${String(driver)}' (expected pi, claude, codex, or set --driver-cmd)`);
    }
  }
  const durationSec = Math.round((Date.now() - start) / 1000);
  let bytes = 0;
  try {
    bytes = statSync(outputFile).size;
  } catch {
    bytes = 0;
  }
  return { exitCode: outcome.exitCode, durationSec, bytes, timedOut: outcome.timedOut };
}

/**
 * Invoke the critic command and return the combined stdout+stderr as a string.
 * Matches the bash original's `> $critic_out 2>&1` semantics, returning the
 * file contents back to the caller for JSON extraction. Kept synchronous
 * because the critic runs once per eval (not inside the parallel pool).
 */
export function invokeCritic(criticCmd: string, promptFile: string, outputFile: string): CriticInvocation {
  const exitCode = spawnToFileSync('bash', ['-c', criticCmd], outputFile, {
    env: { ...process.env, AI_SKILL_EVAL_PROMPT_FILE: promptFile },
  });
  let stdout = '';
  try {
    stdout = readFileSync(outputFile, 'utf8');
  } catch {
    stdout = '';
  }
  return { exitCode, stdout };
}
