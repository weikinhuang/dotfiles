/**
 * Pure helpers for the bash-exit-watchdog extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * What the extension does: when pi's built-in `bash` tool returns
 * `isError: true` (exit code ≠ 0), pi already embeds a
 * "Command exited with code N" line at the tail of the tool output.
 * Small self-hosted models regularly miss that line - it's buried
 * under stdout noise, sometimes past the condensation marker - and
 * carry on as if the command succeeded.
 *
 * This module exposes:
 *
 *   - `parseExitCode(content)` - pulls the exit code out of pi's
 *     existing trailing "Command exited with code N" line, returning
 *     `undefined` if no such line exists.
 *   - `SuppressRule` / `shouldSuppress` - optional allow-list for
 *     commands where a non-zero exit is routine (e.g. `grep` with no
 *     matches returns 1; `diff` returns 1 when files differ). Rules
 *     match on command regex plus optional exit-code list.
 *   - `loadConfig` - JSONC config loader with the same layering as
 *     the other `config/pi/extensions/*.ts` (global then project).
 *   - `formatWarning` - the unmissable header we prepend to the tool
 *     result content.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseJsonc } from './jsonc.ts';

export interface SuppressRule {
  /** Regex compiled lazily - matched against `event.input.command`. */
  commandPattern: string;
  /**
   * When present, only exit codes in this list suppress the warning
   * for matching commands. Missing list → any exit code suppresses.
   */
  exitCodes?: number[];
}

export interface WatchdogConfig {
  suppress: SuppressRule[];
}

export interface ConfigWarning {
  path: string;
  error: string;
}

const DEFAULT_SUPPRESSIONS: SuppressRule[] = [
  // grep exits 1 on no-match - the LLM asking "is X present?" isn't a failure.
  // exitCodes: [1] so "grep: no such file" (exit 2) still warns.
  { commandPattern: '(?:^|[\\s&|;(])grep(?=[\\s]|$)', exitCodes: [1] },
  // same for common grep variants
  { commandPattern: '(?:^|[\\s&|;(])(rg|ag|ack)(?=[\\s]|$)', exitCodes: [1] },
  // diff exits 1 when files differ - often intentional
  { commandPattern: '(?:^|[\\s&|;(])diff(?=[\\s]|$)', exitCodes: [1] },
];

/**
 * Extract the exit code pi's bash tool emits at the tail of errored
 * output: `"…\n\nCommand exited with code N"`.
 *
 * We match the pi-emitted form strictly (double newline + exact
 * phrasing) to avoid picking up arbitrary text the command itself
 * wrote to stdout.
 */
export function parseExitCode(content: string): number | undefined {
  if (typeof content !== 'string') return undefined;
  // Match the pi-specific trailing marker: `\n\nCommand exited with code N`
  const m = /\n\nCommand exited with code (-?\d+)\s*$/.exec(content);
  if (!m?.[1]) return undefined;
  const code = Number.parseInt(m[1], 10);
  return Number.isFinite(code) ? code : undefined;
}

/**
 * Return true when the (command, exitCode) combo matches any
 * suppression rule. A rule without `exitCodes` suppresses every
 * exit code for commands it matches; a rule with `exitCodes`
 * suppresses only when the exit code is in the list.
 *
 * Malformed regexes are skipped silently - the caller handles that
 * via config warnings at load time.
 */
export function shouldSuppress(command: string, exitCode: number, rules: readonly SuppressRule[]): boolean {
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.commandPattern);
    } catch {
      continue;
    }
    if (!re.test(command)) continue;
    if (!rule.exitCodes || rule.exitCodes.length === 0) return true;
    if (rule.exitCodes.includes(exitCode)) return true;
  }
  return false;
}

/**
 * Format the unmissable warning prepended to a failed bash tool
 * result. Deliberately short, deliberately alarming.
 */
export function formatWarning(exitCode: number, command: string): string {
  const trimmed = command.replace(/\s+/g, ' ').trim();
  const snippet = trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  return (
    `⚠ Command FAILED with exit code ${exitCode}. ` +
    `Do NOT treat this output as a successful result.\n` +
    `Failed command: ${snippet}\n`
  );
}

/**
 * Merge user `suppress` patterns onto the built-in defaults rather
 * than replacing them. The common case is "I want grep/diff to stay
 * quiet AND also ignore my custom migration-script exit codes"; forcing
 * the user to re-list the defaults would be noisy.
 */
export function loadConfig(
  cwd: string,
  home: string = homedir(),
): { config: WatchdogConfig; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const paths = [join(home, '.pi', 'agent', 'exit-watchdog.json'), join(cwd, '.pi', 'exit-watchdog.json')];

  const extraRules: SuppressRule[] = [];

  for (const path of paths) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (e) {
      warnings.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      warnings.push({ path, error: 'config root must be an object' });
      continue;
    }
    const { suppress } = parsed as { suppress?: unknown };
    if (suppress === undefined) continue;
    if (!Array.isArray(suppress)) {
      warnings.push({ path, error: '`suppress` must be an array' });
      continue;
    }
    for (const entry of suppress) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.commandPattern !== 'string' || e.commandPattern.length === 0) continue;
      // Validate the regex; reject (with a warning) rather than silently skipping at match time.
      try {
        new RegExp(e.commandPattern);
      } catch (err) {
        warnings.push({ path, error: `bad commandPattern "${e.commandPattern}": ${String(err)}` });
        continue;
      }
      const exitCodes = Array.isArray(e.exitCodes)
        ? e.exitCodes.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : undefined;
      extraRules.push({ commandPattern: e.commandPattern, exitCodes });
    }
  }

  return {
    config: { suppress: [...DEFAULT_SUPPRESSIONS, ...extraRules] },
    warnings,
  };
}

export { DEFAULT_SUPPRESSIONS };
