/**
 * Layout helpers for pi's user-scope agent config dir and the
 * project-scope `.pi/` dir. Pure - no pi imports - so callers can
 * unit-test resolution under vitest.
 *
 * Per pi's docs the user-scope agent dir is `~/.pi/agent/` by default
 * and is overridable via the `PI_CODING_AGENT_DIR` env var. All
 * extension-managed config files (bash-permissions.json,
 * sandbox.json, filesystem.json, hooks.json, presets.json,
 * waveform-indicator.json, personas/, agents/, …) live under this
 * dir, NOT under bare `~/.pi/` - extensions in this repo previously
 * stored some of those at `~/.pi/<x>.json` (one level above the
 * agent dir), which doesn't match pi's actual layout.
 *
 * The project-scope dir is always `<cwd>/.pi/`. Pi has no override
 * for it.
 *
 * Resolution is performed on each call so tests / spawned
 * subprocesses that mutate `HOME` or `PI_CODING_AGENT_DIR` mid-run
 * pick up the change without restarting.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Absolute path to the user-scope pi agent dir. Honors
 * `PI_CODING_AGENT_DIR`; falls back to `<home>/.pi/agent`.
 *
 * `env` and `home` are injectable so vitest can pin them without
 * touching the host environment. Production callers should leave
 * them at their defaults.
 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(home, '.pi', 'agent');
}

/**
 * Absolute path to a file or subdirectory under the user-scope pi
 * agent dir. Equivalent to `join(piAgentDir(), ...segments)`.
 */
export function piAgentPath(...segments: string[]): string {
  return join(piAgentDir(), ...segments);
}

/** Absolute path to the project-scope pi dir for `cwd` (i.e. `<cwd>/.pi`). */
export function piProjectDir(cwd: string): string {
  return join(cwd, '.pi');
}

/**
 * Absolute path to a file or subdirectory under the project-scope
 * pi dir for `cwd`. Equivalent to `join(piProjectDir(cwd),
 * ...segments)`.
 */
export function piProjectPath(cwd: string, ...segments: string[]): string {
  return join(piProjectDir(cwd), ...segments);
}
