/**
 * Bash exit-code watchdog for pi.
 *
 * Small self-hosted models (qwen3-30B-A3B and similar) regularly miss
 * pi's built-in "Command exited with code N" marker because it lives
 * at the tail of bash output, sometimes after 50KB of stdout and an
 * output-condensation note. They then carry on as if the command
 * succeeded.
 *
 * This extension intercepts every `bash` tool result with `isError: true`
 * and prepends an unmissable warning at the HEAD of the content, while
 * leaving pi's original output intact below so the model can still
 * inspect it. Matches pi's own convention of "describe the status, then
 * the raw output".
 *
 * Suppression defaults cover the common cases where non-zero exit is
 * routine (grep with no matches, diff with differences). Additional
 * rules can be added in `~/.pi/agent/exit-watchdog.json` or project
 * `.pi/exit-watchdog.json`:
 *
 *   {
 *     "suppress": [
 *       { "commandPattern": "^./migrations/\\d+", "exitCodes": [3] }
 *     ]
 *   }
 *
 * User rules are merged on top of the built-in defaults.
 *
 * Composition notes:
 *
 *   - Runs on `tool_result`, returning a `{ content }` patch that
 *     chains cleanly with `tool-output-condenser` (condensation still
 *     applies to the body; our warning is a short header and rides
 *     through untouched).
 *   - Complements `verify-before-claim`. That extension catches "tests
 *     pass" claims without backing evidence; this one catches the
 *     upstream case where the model never noticed the command failed
 *     in the first place.
 *
 * Environment:
 *   PI_EXIT_WATCHDOG_DISABLED=1   skip the extension entirely
 *   PI_EXIT_WATCHDOG_DEBUG=1      ctx.ui.notify every decision
 *   PI_EXIT_WATCHDOG_TRACE=<path> append one line per decision to <path>
 *                                 (useful in -p / RPC modes where notify
 *                                 is a no-op)
 */

import { appendFileSync } from 'node:fs';
import { type ExtensionAPI, type ExtensionContext, isBashToolResult } from '@mariozechner/pi-coding-agent';
import {
  type ConfigWarning,
  formatWarning,
  loadConfig,
  parseExitCode,
  shouldSuppress,
  type WatchdogConfig,
} from '../../../lib/node/pi/bash-exit-watchdog.ts';

export default function bashExitWatchdog(pi: ExtensionAPI): void {
  if (process.env.PI_EXIT_WATCHDOG_DISABLED === '1') return;

  const debug = process.env.PI_EXIT_WATCHDOG_DEBUG === '1';
  const tracePath = process.env.PI_EXIT_WATCHDOG_TRACE;
  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[exit-watchdog] ${msg}\n`, 'utf8');
    } catch {
      /* ignore trace write failures — never break a turn over diagnostics */
    }
  };

  let cached: { config: WatchdogConfig; warnings: ConfigWarning[] } | undefined;
  const notified = new Set<string>();

  const getConfig = (cwd: string): WatchdogConfig => {
    if (!cached) cached = loadConfig(cwd);
    return cached.config;
  };

  const surfaceWarnings = (ctx: ExtensionContext): void => {
    if (!cached) return;
    for (const w of cached.warnings) {
      const key = `${w.path}:${w.error}`;
      if (notified.has(key)) continue;
      notified.add(key);
      ctx.ui.notify(`exit-watchdog: failed to load ${w.path}: ${w.error}`, 'warning');
    }
  };

  pi.on('session_start', (_event, ctx) => {
    cached = undefined;
    notified.clear();
    getConfig(ctx.cwd);
    surfaceWarnings(ctx);
  });

  pi.on('tool_result', (event, ctx) => {
    if (!isBashToolResult(event)) return undefined;
    if (!event.isError) return undefined;

    // First text part typically carries all stdout/stderr + pi's tail marker.
    const first = event.content[0];
    if (!first || first.type !== 'text') return undefined;
    const original = first.text;
    const exitCode = parseExitCode(original);
    if (exitCode === undefined || exitCode === 0) return undefined;

    const command = typeof event.input?.command === 'string' ? event.input.command : '';
    const config = getConfig(ctx.cwd);
    surfaceWarnings(ctx);

    if (shouldSuppress(command, exitCode, config.suppress)) {
      if (debug) ctx.ui.notify(`exit-watchdog: suppressed (cmd matched rule), exit=${exitCode}`, 'info');
      trace(`suppressed exit=${exitCode} cmd=${command.slice(0, 80)}`);
      return undefined;
    }

    if (debug) ctx.ui.notify(`exit-watchdog: flagged exit=${exitCode} on "${command.slice(0, 60)}"`, 'info');
    trace(`flagged exit=${exitCode} cmd=${command.slice(0, 80)}`);

    const warning = formatWarning(exitCode, command);
    return {
      content: [{ type: 'text', text: `${warning}\n${original}` }, ...event.content.slice(1)],
    };
  });

  pi.on('session_shutdown', () => {
    cached = undefined;
    notified.clear();
  });
}
