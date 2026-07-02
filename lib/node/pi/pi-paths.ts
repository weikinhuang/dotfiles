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

/**
 * Transform a cwd into the directory name pi uses for its session store:
 * replace `/` with `-` and wrap in `--…--`. So `/mnt/d/foo` becomes
 * `--mnt-d-foo--`. Pure - no subprocess, no git lookup.
 *
 * The leading/trailing double-dash is pi's own visual marker that this is
 * a full-path-encoded directory rather than a normal name. This is a
 * generic pi-layout helper (used by the memory tree, the subagent child
 * session tree, and anything else that mirrors pi's `sessions/<slug>/`
 * bucketing) - it lives here, not in any one extension's `*-paths` module.
 *
 * Note: pi's own encoder additionally maps `\` and `:` (Windows drive
 * paths) and strips only a single leading separator after resolving the
 * path. This helper matches pi for ordinary POSIX cwds; for the exact
 * dir pi is writing to, prefer `sessionManager.getSessionDir()` at
 * runtime rather than recomputing.
 */
export function cwdSlug(cwd: string): string {
  const stripped = cwd.replace(/^\/+|\/+$/g, '');
  return `--${stripped.split('/').join('-')}--`;
}

/**
 * Resolve a per-workspace slug from an env override, falling back to the
 * cwd-derived slug. When `envValue` is a non-empty (trimmed) string it is
 * used verbatim - pinning the slug to a fixed, cwd-independent value so the
 * store survives a workspace folder rename/move; otherwise the cwd slug is
 * used (unchanged default behaviour). Shared by every extension that keys
 * on the session/cwd slug so the override contract stays consistent.
 */
export function slugFromEnv(envValue: string | undefined, cwd: string): string {
  const trimmed = envValue?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  return cwdSlug(cwd);
}
