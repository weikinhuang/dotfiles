/**
 * Detect a bash failure that is most likely caused by the kernel
 * sandbox's network isolation (`bwrap --unshare-net`) cutting the
 * sandboxed process off from host loopback services.
 *
 * Motivation: when network filtering is on, ASRT runs bash in an
 * isolated network namespace whose loopback is NOT the host's. A
 * `curl localhost:PORT` against a Docker published port (or any host
 * service bound on 127.0.0.1) therefore fails - and because ASRT
 * hardcodes `NO_PROXY=localhost,127.0.0.1,…`, the request never even
 * reaches the filtering proxy that could surface a violation. ASRT's
 * own `annotateStderrWithSandboxFailures` produces nothing for this
 * case, so the model just sees an opaque connection failure (curl's
 * `000`, `Connection refused`, etc.) with no clue it was the sandbox.
 *
 * This pure helper recognizes that signature so the extension can
 * prepend an actionable hint. It is intentionally conservative: it
 * fires only when the output references BOTH a loopback host token
 * AND a connection-failure token, so an ordinary remote-host failure
 * (which the allow-list legitimately blocked) does not get the
 * localhost-specific advice.
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 */

/** Loopback / "this host" address tokens. `0.0.0.0` is included
 *  because tools sometimes report the bind address that way and users
 *  curl it. Matched case-insensitively as whole-ish words so
 *  `127.0.0.1` inside a longer token still counts but `localhostile`
 *  does not trip the bare `localhost`. */
const LOOPBACK_TOKENS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  // IPv4-mapped IPv6 loopback that some clients print.
  '::ffff:127.0.0.1',
];

/** Connection-failure phrases emitted by curl / wget / nc / ssh /
 *  generic libc when a TCP connect cannot complete. */
const FAILURE_PATTERNS: RegExp[] = [
  /connection refused/i,
  /failed to connect/i,
  /could ?n['o]?t connect/i, // "couldn't connect" / "could not connect"
  /connection timed out/i,
  /no route to host/i,
  /network is unreachable/i,
  /connection reset by peer/i,
  /empty reply from server/i,
];

/** True when `text` mentions a loopback host. Word-boundary-ish so
 *  `localhost` is matched as a token, while IP literals match
 *  anywhere (they have no alphabetic neighbors to worry about). */
function mentionsLoopback(text: string): boolean {
  const lower = text.toLowerCase();
  for (const tok of LOOPBACK_TOKENS) {
    if (tok === 'localhost') {
      if (/\blocalhost\b/i.test(text)) return true;
      continue;
    }
    if (lower.includes(tok)) return true;
  }
  return false;
}

/** True when `text` contains a recognized connection-failure phrase. */
function mentionsConnectionFailure(text: string): boolean {
  return FAILURE_PATTERNS.some((re) => re.test(text));
}

/**
 * The hint body surfaced when a sandboxed bash command appears to have
 * failed reaching a host loopback service under network isolation.
 * Kept as an exported constant so the extension and the spec share one
 * source of truth.
 */
export const LOOPBACK_FAILURE_HINT =
  'This bash ran under the sandbox network isolation, which unshares the network ' +
  'namespace - so host services on localhost / 127.0.0.1 (Docker published ports, a ' +
  'dev server, a local database) are NOT reachable from inside the sandbox, and the ' +
  'network allow-list cannot fix it (localhost bypasses the filtering proxy). To reach a ' +
  'local service:\n' +
  '  1. For HTTP(S) tools (curl, wget, pip, npm): ask the user to set ' +
  '`network.allowLocalhost: true` in sandbox.json - it routes loopback through the proxy ' +
  'and KEEPS domain filtering on.\n' +
  '  2. `docker exec <container> <cmd>` - hit the service from inside its own container.\n' +
  '  3. Start the service AND curl it within the SAME bash command (they share the ' +
  "sandbox's network namespace), e.g. `server & sleep 1; curl localhost:PORT`.\n" +
  '  4. For raw-TCP clients (psql, redis-cli, mysql, nc) or a blanket fix: ask the user to ' +
  'run `/sandbox-disable`, or set `network.unrestricted: true` (coarse - drops ALL network filtering).';

/**
 * Return {@link LOOPBACK_FAILURE_HINT} when `text` (a bash result's
 * combined stdout+stderr) looks like a host-loopback connection
 * failure, otherwise `undefined`.
 *
 * The caller should only invoke this when network isolation is
 * actually active (sandbox initialized, not bypassed, not
 * `network.unrestricted`) - this helper does not know the sandbox
 * state, only the text signature.
 */
export function detectLoopbackFailure(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (!mentionsLoopback(text)) return undefined;
  if (!mentionsConnectionFailure(text)) return undefined;
  return LOOPBACK_FAILURE_HINT;
}
