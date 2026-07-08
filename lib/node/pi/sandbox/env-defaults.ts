/**
 * Pure parsers for the two `PI_SANDBOX_*` env knobs that pick a
 * non-UI default behaviour.
 *
 *   - `PI_SANDBOX_DEFAULT`         fallback action when a wrap itself
 *                                  errors: `warn` | `allow` | `block`.
 *   - `PI_SANDBOX_NETWORK_DEFAULT` non-UI default for the network
 *                                  ask-callback: `allow` | `deny`.
 *
 * Both fold every unrecognized / missing value to the documented
 * default (`warn` / `deny`). The env source is injectable so the
 * parse is unit-testable without mutating the real `process.env`; the
 * extension shell calls them with the default (live) env.
 *
 * Pure module - no pi imports.
 */

export type SandboxFallback = 'warn' | 'allow' | 'block';

/**
 * Resolve `PI_SANDBOX_DEFAULT` to the fallback action taken when a
 * wrap can't be produced (uninitialized manager, wrap throw). Defaults
 * to `warn` (run unwrapped and log) for any missing / unknown value.
 */
export function resolveSandboxFallback(env: NodeJS.ProcessEnv = process.env): SandboxFallback {
  const raw = (env.PI_SANDBOX_DEFAULT ?? 'warn').trim().toLowerCase();
  if (raw === 'allow' || raw === 'block' || raw === 'warn') return raw;
  return 'warn';
}

/**
 * Resolve `PI_SANDBOX_NETWORK_DEFAULT` to the non-UI decision for the
 * network ask-callback (when no interactive UI is available). Only an
 * explicit `allow` opts in; every other value defaults to `deny`.
 */
export function resolveNetworkDefault(env: NodeJS.ProcessEnv = process.env): 'allow' | 'deny' {
  const raw = (env.PI_SANDBOX_NETWORK_DEFAULT ?? 'deny').trim().toLowerCase();
  return raw === 'allow' ? 'allow' : 'deny';
}
