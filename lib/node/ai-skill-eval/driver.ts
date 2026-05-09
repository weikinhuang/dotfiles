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
  /** Wall-clock duration, rounded to 2 decimal places. */
  durationSec: number;
  bytes: number;
  timedOut: boolean;
  /**
   * Parsed token count if the driver exposed one. `null` when the driver
   * doesn't surface usage info (claude without `--output-format=stream-json`)
   * or when the log line couldn't be parsed. Best-effort; callers should not
   * rely on a specific format.
   */
  tokens: number | null;
  /** Tool-call count — null until a driver-level capture exists. */
  toolCalls: number | null;
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
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number | null;
    devNullStdio?: boolean;
    /**
     * When set (only meaningful with `devNullStdio`), stdout is captured
     * into `stdoutFile` instead of `/dev/null` while stderr still goes to
     * `/dev/null`. Used by the codex driver so its decorated stdout log
     * (carrying token-usage info) survives for {@link captureTokens} to
     * parse after the run, without clobbering the `-o` reply in
     * `outputFile`.
     */
    stdoutFile?: string | null;
  } = {},
): Promise<SpawnToFileResult> {
  return new Promise<SpawnToFileResult>((resolve) => {
    // `devNullStdio` lets the codex driver redirect stderr (at least) away
    // from `outputFile` while still using `outputFile` for the appended
    // DRIVER_TIMEOUT marker.
    const captureToSidecar = options.devNullStdio === true && options.stdoutFile != null;
    const stdoutFd = captureToSidecar
      ? openSync(options.stdoutFile!, 'w')
      : openSync(options.devNullStdio ? '/dev/null' : outputFile, 'w');
    const stderrFd = captureToSidecar ? openSync('/dev/null', 'w') : stdoutFd;
    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', stdoutFd, stderrFd],
      env: options.env ?? process.env,
    };
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (err) {
      try {
        closeSync(stdoutFd);
      } catch {
        // ignore
      }
      if (captureToSidecar) {
        try {
          closeSync(stderrFd);
        } catch {
          // ignore
        }
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
        closeSync(stdoutFd);
      } catch {
        // ignore
      }
      if (captureToSidecar) {
        try {
          closeSync(stderrFd);
        } catch {
          // ignore
        }
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
  // outputFile. stdout goes to a `<outputFile>.log` sidecar so
  // {@link captureTokens} can parse usage after the run; stderr is
  // discarded (carries the spurious "failed to record rollout items"
  // noise line).
  //
  // Sandbox policy is deliberately unpinned: codex reads the user's
  // ~/.codex/config.toml default. Revisit if a run gets blocked.
  const prompt = readFileSync(promptFile, 'utf8');
  const args = ['exec', '--skip-git-repo-check', '-o', outputFile, '--cd', process.cwd()];
  if (model) args.push('-m', model);
  args.push(prompt);
  return spawnToFileAsync('codex', args, outputFile, {
    timeoutMs,
    devNullStdio: true,
    stdoutFile: `${outputFile}.log`,
  });
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

/**
 * Regex-matches common token-usage patterns against a captured driver log.
 * Returns the first matched integer or null when nothing matches. Patterns
 * cover codex's `tokens used: 12,345`, pi's `tokens: 4200` style, and the
 * generic `total tokens: N` footer some wrappers emit. Kept exported for
 * unit tests.
 */
export function parseTokens(text: string): number | null {
  if (!text) return null;
  const patterns: RegExp[] = [
    /\btokens\s+used\s*:\s*([\d,]+)/i,
    /\btotal[_ ]tokens\s*:\s*([\d,]+)/i,
    /\btokens\s*:\s*([\d,]+)/i,
    /\busage\s*:\s*([\d,]+)\s*tokens?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) {
      const n = Number.parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

/**
 * Best-effort token-count extraction from the captured driver output. Each
 * driver exposes usage differently:
 *
 *   - **pi** appends a usage footer to its reply (captured in `outputFile`).
 *     We look for `tokens:` / `total tokens:` / similar lines and take the
 *     first match.
 *   - **codex** decorates stdout with headers + `tokens used: 12,345`. Our
 *     {@link runCodex} routes stdout to `<outputFile>.log`; we parse that
 *     sidecar.
 *   - **claude** `-p` doesn't emit usage on its default stdout and
 *     `--output-format=stream-json` parsing is out of scope for this round.
 *     Returns null.
 *   - **custom** (`--driver-cmd`) falls through pi-style parsing of
 *     `outputFile` so a user-supplied wrapper that appends a token line
 *     still surfaces.
 *
 * On any parse failure or missing file the function returns `null` rather
 * than throwing — callers treat null as "unavailable for this run".
 */
export function captureTokens(driver: DriverKind | 'custom', outputFile: string): number | null {
  if (driver === 'claude') return null;
  const sourcePath = driver === 'codex' ? `${outputFile}.log` : outputFile;
  let text = '';
  try {
    text = readFileSync(sourcePath, 'utf8');
  } catch {
    return null;
  }
  return parseTokens(text);
}

export async function invokeDriver(cfg: DriverConfig, promptFile: string, outputFile: string): Promise<DriverResult> {
  const start = Date.now();
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : null;
  let outcome: SpawnToFileResult;
  let driverKind: DriverKind | 'custom';
  if (cfg.driverCmd) {
    outcome = await runCustom(cfg.driverCmd, promptFile, outputFile, timeoutMs);
    driverKind = 'custom';
  } else {
    const driver = resolveDriver(cfg);
    driverKind = driver;
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
  const durationSec = Math.round((Date.now() - start) / 10) / 100;
  let bytes = 0;
  try {
    bytes = statSync(outputFile).size;
  } catch {
    bytes = 0;
  }
  const tokens = captureTokens(driverKind, outputFile);
  return {
    exitCode: outcome.exitCode,
    durationSec,
    bytes,
    timedOut: outcome.timedOut,
    tokens,
    toolCalls: null,
  };
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
