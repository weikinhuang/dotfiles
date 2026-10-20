/**
 * Bridge ASRT's in-memory `SandboxViolationStore` into the extension's
 * JSONL audit log (`<piAgentDir>/sandbox-violations.log`).
 *
 * Since ASRT 0.0.68 every refused proxy connection - deny-list hit,
 * not-on-allow-list under `strictAllowlist`, a user "Deny" in the ask
 * dialog, a resolved-address guard refusal - is recorded in the store as
 * a line of the form
 *
 *   deny network-outbound <host>:<port> (<reason>)
 *
 * attributed to the wrapped command. The store keeps only the last 100
 * events in memory and hands every subscriber the WHOLE list on each
 * change, so {@link createViolationFeed} de-duplicates by event object
 * identity and forwards only new events.
 *
 * Logging these with a structured `host` is what feeds the
 * `/sandbox-allow` / `/sandbox-deny` completion of recently-blocked
 * domains.
 *
 * Pure module - no pi imports, no ASRT runtime import.
 */

import type { SandboxViolationRecord } from './violations-log.ts';

/** Structural shape of ASRT's `SandboxViolationEvent`. */
export interface AsrtViolationEvent {
  line: string;
  command?: string;
  encodedCommand?: string;
  timestamp?: Date | string;
}

export interface OutboundDeny {
  host: string;
  port: number;
  reason: string;
}

const OUTBOUND_DENY_RE = /^deny network-outbound (.+):(\d+) \((.*)\)\s*$/;

/** Parse ASRT's proxy-deny violation line. `undefined` for any other line. */
export function parseOutboundDeny(line: string): OutboundDeny | undefined {
  const m = OUTBOUND_DENY_RE.exec(line.trim());
  if (!m) return undefined;
  const port = Number(m[2]);
  if (!Number.isInteger(port)) return undefined;
  const host = m[1].replace(/^\[(.*)\]$/, '$1');
  if (!host) return undefined;
  return { host, port, reason: m[3] };
}

/** Render `host:port`, bracketing IPv6 literals so the port stays
 *  unambiguous (`[::1]:443`). */
export function formatHostPort(host: string, port: number | undefined): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return port === undefined ? h : `${h}:${port}`;
}

/** Inverse of {@link formatHostPort}: the bare host of a `host:port`,
 *  `[v6]:port`, or plain host string. */
export function hostOfHostPort(value: string): string {
  const v = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) return bracketed[1];
  // A bare IPv6 literal has several colons and no port we can split off.
  if ((v.match(/:/g) ?? []).length > 1) return v;
  return v.replace(/:\d+$/, '');
}

/** Convert one ASRT violation into an audit-log record, or `undefined`
 *  when it is not a network denial (fs events are handled elsewhere). */
export function violationToRecord(
  v: AsrtViolationEvent,
  opts: { cwd: string; now?: Date },
): SandboxViolationRecord | undefined {
  const deny = parseOutboundDeny(v.line);
  if (!deny) return undefined;
  const ts =
    v.timestamp instanceof Date
      ? v.timestamp.toISOString()
      : typeof v.timestamp === 'string'
        ? v.timestamp
        : (opts.now ?? new Date()).toISOString();
  return {
    ts,
    kind: 'net',
    action: 'deny',
    command: v.command ?? '',
    cwd: opts.cwd,
    host: formatHostPort(deny.host, deny.port),
    note: deny.reason,
  };
}

/**
 * Build a `SandboxViolationStore.subscribe` listener that calls `onNew`
 * once per event it has not seen before. The first call (ASRT invokes
 * the listener immediately on subscribe with the current backlog) is
 * treated as already-seen when `skipBacklog` is true, so re-subscribing
 * after `/reload` doesn't re-log the previous session's tail.
 */
export function createViolationFeed(
  onNew: (event: AsrtViolationEvent) => void,
  opts: { skipBacklog?: boolean } = {},
): (events: readonly AsrtViolationEvent[]) => void {
  const seen = new WeakSet<object>();
  let first = true;
  return (events) => {
    const backlog = first && opts.skipBacklog === true;
    first = false;
    for (const e of events) {
      if (e === null || typeof e !== 'object' || seen.has(e)) continue;
      seen.add(e);
      if (backlog) continue;
      try {
        onNew(e);
      } catch {
        // A logging failure must never break ASRT's notify loop.
      }
    }
  };
}
