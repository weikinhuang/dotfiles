// Driver dispatch for ai-skill-eval: spawns the configured LLM command with
// the prompt file as input and captures combined stdout+stderr into an
// output file (matching the bash `> $out 2>&1` redirection semantics).
// SPDX-License-Identifier: MIT

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';

import { type DriverKind } from './types.ts';

export interface DriverConfig {
  driver: DriverKind | null;
  driverCmd: string | null;
  model: string | null;
}

export interface DriverResult {
  exitCode: number;
  durationSec: number;
  bytes: number;
}

export interface CriticInvocation {
  exitCode: number;
  stdout: string;
}

function hasCommand(cmd: string): boolean {
  const r = spawnSync('bash', ['-c', `command -v ${cmd} >/dev/null 2>&1`]);
  return r.status === 0;
}

/** Spawn a command and redirect both stdout and stderr into the given file. */
function spawnToFile(cmd: string, args: readonly string[], outputFile: string, options: SpawnSyncOptions = {}): number {
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

function runPi(promptFile: string, outputFile: string, model: string): number {
  const prompt = readFileSync(promptFile, 'utf8');
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  return spawnToFile('pi', ['-p', prompt, '--model', model, '--no-session'], outputFile, { env });
}

function runClaude(promptFile: string, outputFile: string, model: string | null): number {
  const prompt = readFileSync(promptFile, 'utf8');
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  args.push('--bare');
  return spawnToFile('claude', args, outputFile);
}

function runCodex(promptFile: string, outputFile: string, model: string | null): number {
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
  const devNull = openSync('/dev/null', 'w');
  try {
    const r = spawnSync('codex', args, { stdio: ['ignore', devNull, devNull] });
    return r.status ?? (r.error ? 127 : 1);
  } finally {
    closeSync(devNull);
  }
}

function runCustom(driverCmd: string, promptFile: string, outputFile: string): number {
  return spawnToFile('bash', ['-c', driverCmd], outputFile, {
    env: { ...process.env, AI_SKILL_EVAL_PROMPT_FILE: promptFile },
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

export function invokeDriver(cfg: DriverConfig, promptFile: string, outputFile: string): DriverResult {
  const start = Date.now();
  let exitCode: number;
  if (cfg.driverCmd) {
    exitCode = runCustom(cfg.driverCmd, promptFile, outputFile);
  } else {
    const driver = resolveDriver(cfg);
    if (driver === 'pi') {
      const model = cfg.model ?? process.env.AI_SKILL_EVAL_MODEL ?? 'llama-cpp/qwen3-6-35b-a3b';
      exitCode = runPi(promptFile, outputFile, model);
    } else if (driver === 'claude') {
      const model = cfg.model ?? process.env.AI_SKILL_EVAL_MODEL ?? null;
      exitCode = runClaude(promptFile, outputFile, model);
    } else if (driver === 'codex') {
      const model = cfg.model ?? process.env.AI_SKILL_EVAL_MODEL ?? null;
      exitCode = runCodex(promptFile, outputFile, model);
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
  return { exitCode, durationSec, bytes };
}

/**
 * Invoke the critic command and return the combined stdout+stderr as a string.
 * Matches the bash original's `> $critic_out 2>&1` semantics, returning the
 * file contents back to the caller for JSON extraction.
 */
export function invokeCritic(criticCmd: string, promptFile: string, outputFile: string): CriticInvocation {
  const exitCode = spawnToFile('bash', ['-c', criticCmd], outputFile, {
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
