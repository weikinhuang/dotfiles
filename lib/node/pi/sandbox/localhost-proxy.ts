/**
 * Helpers for the `network.allowLocalhost` opt-in (see config-schema.ts).
 *
 * On Linux, ASRT isolates the network with `bwrap --unshare-net` and
 * hardcodes `NO_PROXY=localhost,127.0.0.1,::1,…` in the wrapped shell's
 * environment, so loopback requests never reach ASRT's in-namespace
 * HTTP/SOCKS proxy (and the namespace's own loopback can't see host
 * services). `network.allowLocalhost` makes loopback reachable WITHOUT
 * dropping domain filtering by doing two things:
 *
 *   1. Allow-listing the loopback hosts (so the host-side proxy admits
 *      them - it `dialDirect`s the host loopback with no SSRF guard).
 *      Done in `config-translate.ts`.
 *   2. Rewriting the wrapped command's `NO_PROXY` to drop the loopback
 *      entries, so loopback HTTP(S)/SOCKS traffic routes through the
 *      proxy instead of being bypassed into the dead namespace
 *      loopback. Done here, via a prepended `export`.
 *
 * Only tools that honor `HTTP_PROXY` / `ALL_PROXY` are covered (curl,
 * wget, pip, npm, most language HTTP clients). Raw-TCP clients that
 * ignore proxy env (psql, redis-cli, mysql, bare nc) are not - those
 * need `network.unrestricted`.
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 */

/** Loopback hosts added to the ASRT allow-list when
 *  `network.allowLocalhost` is set. `0.0.0.0` is intentionally excluded
 *  (it is not a connect target). */
export const LOOPBACK_PROXY_ALLOW = ['localhost', '127.0.0.1', '::1'];

/**
 * The `NO_PROXY` value the wrapped command is given under
 * `allowLocalhost`: ASRT's hardcoded default MINUS the three loopback
 * hosts, so loopback routes through the proxy while private / link-local
 * ranges keep their default direct-bypass behavior. Mirrors ASRT's
 * `generateProxyEnvVars` list (sandbox-utils.ts); if ASRT changes its
 * default the only drift is in the private-range bypass, never in the
 * loopback removal this feature depends on.
 */
export const NO_PROXY_WITHOUT_LOOPBACK = '*.local,.local,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';

/**
 * Prepend an `export` that rewrites `NO_PROXY` / `no_proxy` to
 * {@link NO_PROXY_WITHOUT_LOOPBACK} so the wrapped shell routes loopback
 * traffic through ASRT's proxy. `export` always exits 0, so this is
 * safe in front of any command (including `set -e` scripts). The
 * original (unmodified) command is still stashed for the transcript by
 * the caller; only the executed string carries this prefix.
 */
export function prependLocalhostProxyEnv(command: string): string {
  return `export NO_PROXY='${NO_PROXY_WITHOUT_LOOPBACK}' no_proxy='${NO_PROXY_WITHOUT_LOOPBACK}'; ${command}`;
}
