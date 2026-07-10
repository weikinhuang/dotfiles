/**
 * Sandbox-only config schema (`<piAgentDir>/sandbox.json` /
 * `<repo>/.pi/sandbox.json`). Filesystem rules live in the unified
 * `<piAgentDir>/filesystem.json` consumed by both `filesystem.ts` and
 * `sandbox.ts`; this file covers the ASRT-specific knobs that have no
 * sensible in-process counterpart: network domains, unix sockets, and
 * the platform-flag escape hatches.
 *
 * Pure module - no pi imports - so it's directly unit-testable. We
 * intentionally do NOT pull in zod (or ASRT's exported zod schema) at
 * runtime; this is a hand-rolled validator that records warnings
 * instead of throwing so one bad rule file can't take pi down.
 *
 * `config-translate.ts` does `import type { SandboxRuntimeConfig } from
 * '@anthropic-ai/sandbox-runtime'` to keep the translator structurally
 * pinned to ASRT's shape - that's the only ASRT touch in `lib/`.
 */

export interface SandboxNetworkConfig {
  /** Allow-list of domains the sandboxed bash may connect to. Empty
   *  = deny all. Wildcard `*.example.com` matches subdomains. */
  allow: string[];
  /** Explicit deny-list checked before the allow-list. */
  deny: string[];
  /** Coarse escape hatch: when true, the kernel sandbox does NOT
   *  unshare the network namespace, so sandboxed bash shares the
   *  host's network - including `localhost` / `127.0.0.1` host
   *  services (Docker published ports, a dev server, a local DB).
   *  This disables ALL domain filtering (`allow` / `deny` become
   *  inert); the translator drops `allowedDomains` so ASRT's
   *  `needsNetworkRestriction` is false. Off by default.
   *
   *  Why this is the only way to reach host loopback on Linux: ASRT
   *  isolates the network with `bwrap --unshare-net` whenever any
   *  domain allow-list is present, and hardcodes
   *  `NO_PROXY=localhost,127.0.0.1,…`, so localhost never reaches the
   *  filtering proxy and the isolated namespace's loopback can't see
   *  host services. There is no per-port host-loopback bridge. */
  unrestricted?: boolean;
  /** Narrower escape hatch that KEEPS domain filtering. When true,
   *  `localhost` / `127.0.0.1` / `::1` are added to the ASRT allow-list
   *  and the wrapped command's `NO_PROXY` is rewritten to drop the
   *  loopback entries, so loopback HTTP(S)/SOCKS traffic routes through
   *  ASRT's existing proxy (which dials the host loopback - no SSRF
   *  guard) instead of the isolated namespace's dead loopback. The
   *  allow/deny lists still gate every other destination.
   *
   *  Reaches host loopback services (Docker published ports, dev
   *  servers, a local LLM/API) for any tool that honors `HTTP_PROXY` /
   *  `ALL_PROXY` (curl, wget, pip, npm, most HTTP clients). Raw-TCP
   *  clients that ignore proxy env (`psql`, `redis-cli`, `mysql`, bare
   *  `nc`) are NOT covered - those still need `unrestricted`. No-op
   *  when `unrestricted` is set (host network already shared). Off by
   *  default. */
  allowLocalhost?: boolean;
}

export interface SandboxUnixSocketsConfig {
  /** Absolute paths of unix sockets the sandbox may connect to. */
  allow: string[];
  /** Bypass for users who explicitly opt out of socket sandboxing
   *  (rare; surfaces a startup warning). */
  allowAll?: boolean;
}

export interface SandboxFlags {
  /** ASRT `enableWeakerNestedSandbox`. Surfaces via PI_SANDBOX_NESTED=1.
   *  Required when pi runs inside Docker / nested containers. */
  weakerNestedSandbox: boolean;
  /** ASRT `enableWeakerNetworkIsolation` (macOS only Go-TLS escape).
   *  Surfaces via PI_SANDBOX_WEAKER_NET=1. */
  weakerNetworkIsolation: boolean;
  /** ASRT `network.allowLocalBinding` - lets sandboxed children reach
   *  127.0.0.1 / localhost while remote domains stay filtered.
   *  macOS ONLY: sandbox-exec adds an allow-loopback rule. On Linux
   *  this is a silent no-op (network isolation is `bwrap --unshare-net`
   *  and ASRT never forwards the flag to the Linux path); use
   *  `network.unrestricted` to reach host loopback there. */
  allowLocalBinding: boolean;
  /** Default 3 (per plan section 6). Tuneable for deep monorepos.
   *  Bounded between 1 and 10 by {@link clampLinuxRuleDepth}. */
  linuxRuleDepth: number;
}

export interface SandboxConfig {
  network: SandboxNetworkConfig;
  unixSockets: SandboxUnixSocketsConfig;
  flags: SandboxFlags;
  /** When true (default), the extension maintains a marked block in
   *  the repo's `<git-common-dir>/info/exclude` that hides the
   *  transient dangerous-file stubs from `git status` (added on
   *  session start, stripped on session end). Set `false` to leave the
   *  exclude file untouched. The env override
   *  `PI_SANDBOX_DISABLE_GIT_EXCLUDE=1` (checked in the extension
   *  shell) is a hard off-switch on top of this. */
  gitExcludeStubs: boolean;
}

export interface SandboxConfigWarning {
  /** Source label used when surfacing the warning. */
  source: string;
  reason: string;
}

// ──────────────────────────────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────────────────────────────

export const LINUX_RULE_DEPTH_MIN = 1;
export const LINUX_RULE_DEPTH_MAX = 10;
export const LINUX_RULE_DEPTH_DEFAULT = 3;

/** Bound the depth the Linux compiler will recurse to prevent the
 *  startup cost of a misconfigured `linuxRuleDepth: 999` against a deep
 *  monorepo. */
export function clampLinuxRuleDepth(value: number): number {
  if (!Number.isFinite(value)) return LINUX_RULE_DEPTH_DEFAULT;
  if (value < LINUX_RULE_DEPTH_MIN) return LINUX_RULE_DEPTH_MIN;
  if (value > LINUX_RULE_DEPTH_MAX) return LINUX_RULE_DEPTH_MAX;
  return Math.floor(value);
}

/** Defaults match plan section 6: deny-all network, no socket bypass,
 *  all flags off, depth 3.
 *
 *  Only the top level is frozen, NOT the inner arrays. Freezing the
 *  arrays + then typing them as mutable `string[]` (the shape of
 *  `SandboxConfig`) would create a type-vs-runtime gap where a future
 *  `DEFAULT_SANDBOX_CONFIG.network.allow.push(...)` typechecks fine
 *  but throws at runtime. The top-level freeze is enough to prevent
 *  accidental reassignment of `DEFAULT_SANDBOX_CONFIG.network`. */
export const DEFAULT_SANDBOX_CONFIG: Readonly<SandboxConfig> = Object.freeze({
  network: {
    allow: [] as string[],
    deny: [] as string[],
    unrestricted: false,
    allowLocalhost: false,
  },
  unixSockets: {
    allow: [] as string[],
    allowAll: false,
  },
  flags: {
    weakerNestedSandbox: false,
    weakerNetworkIsolation: false,
    allowLocalBinding: false,
    linuxRuleDepth: LINUX_RULE_DEPTH_DEFAULT,
  },
  gitExcludeStubs: true,
});

// ──────────────────────────────────────────────────────────────────────
// Empties / merges
// ──────────────────────────────────────────────────────────────────────

export function emptySandboxConfig(): SandboxConfig {
  return {
    network: { allow: [], deny: [], unrestricted: false, allowLocalhost: false },
    unixSockets: { allow: [], allowAll: false },
    flags: {
      weakerNestedSandbox: false,
      weakerNetworkIsolation: false,
      allowLocalBinding: false,
      linuxRuleDepth: LINUX_RULE_DEPTH_DEFAULT,
    },
    gitExcludeStubs: true,
  };
}

/** Loose partial used by loaders. Every field is unknown so untrusted
 *  JSON can be piped through. */
export interface PartialSandboxConfig {
  network?: {
    allow?: unknown;
    deny?: unknown;
    unrestricted?: unknown;
    allowLocalhost?: unknown;
  };
  unixSockets?: {
    allow?: unknown;
    allowAll?: unknown;
  };
  flags?: {
    weakerNestedSandbox?: unknown;
    weakerNetworkIsolation?: unknown;
    allowLocalBinding?: unknown;
    linuxRuleDepth?: unknown;
  };
  gitExcludeStubs?: unknown;
}

function pushStrings(
  into: string[],
  src: unknown,
  source: string,
  scope: string,
  warnings: SandboxConfigWarning[],
): void {
  if (src === undefined) return;
  if (!Array.isArray(src)) {
    warnings.push({ source, reason: `\`${scope}\` must be an array of strings (dropped)` });
    return;
  }
  const arr = src as unknown[];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== 'string') {
      warnings.push({ source, reason: `\`${scope}[${i}]\` is not a string (dropped)` });
      continue;
    }
    into.push(item);
  }
}

function setBoolean(
  value: unknown,
  current: boolean,
  source: string,
  scope: string,
  warnings: SandboxConfigWarning[],
): boolean {
  if (value === undefined) return current;
  if (typeof value !== 'boolean') {
    warnings.push({ source, reason: `\`${scope}\` must be a boolean (kept previous value)` });
    return current;
  }
  return value;
}

/**
 * Merge a stack of partial sandbox configs onto the shipped defaults.
 * Arrays are additive within a category; booleans are last-wins; the
 * Linux depth is clamped after the final merge.
 */
export function mergeSandboxConfigs(layers: { source: string; partial: PartialSandboxConfig }[]): {
  config: SandboxConfig;
  warnings: SandboxConfigWarning[];
} {
  const out = emptySandboxConfig();
  out.network.allow.push(...DEFAULT_SANDBOX_CONFIG.network.allow);
  out.network.deny.push(...DEFAULT_SANDBOX_CONFIG.network.deny);
  out.network.unrestricted = DEFAULT_SANDBOX_CONFIG.network.unrestricted === true;
  out.network.allowLocalhost = DEFAULT_SANDBOX_CONFIG.network.allowLocalhost === true;
  out.unixSockets.allow.push(...DEFAULT_SANDBOX_CONFIG.unixSockets.allow);
  out.unixSockets.allowAll = DEFAULT_SANDBOX_CONFIG.unixSockets.allowAll;
  out.flags = { ...DEFAULT_SANDBOX_CONFIG.flags };
  out.gitExcludeStubs = DEFAULT_SANDBOX_CONFIG.gitExcludeStubs;

  const warnings: SandboxConfigWarning[] = [];

  for (const { source, partial } of layers) {
    if (partial.network) {
      pushStrings(out.network.allow, partial.network.allow, source, 'network.allow', warnings);
      pushStrings(out.network.deny, partial.network.deny, source, 'network.deny', warnings);
      out.network.unrestricted = setBoolean(
        partial.network.unrestricted,
        out.network.unrestricted === true,
        source,
        'network.unrestricted',
        warnings,
      );
      out.network.allowLocalhost = setBoolean(
        partial.network.allowLocalhost,
        out.network.allowLocalhost === true,
        source,
        'network.allowLocalhost',
        warnings,
      );
    }
    if (partial.unixSockets) {
      pushStrings(out.unixSockets.allow, partial.unixSockets.allow, source, 'unixSockets.allow', warnings);
      out.unixSockets.allowAll = setBoolean(
        partial.unixSockets.allowAll,
        out.unixSockets.allowAll === true,
        source,
        'unixSockets.allowAll',
        warnings,
      );
    }
    if (partial.flags) {
      out.flags.weakerNestedSandbox = setBoolean(
        partial.flags.weakerNestedSandbox,
        out.flags.weakerNestedSandbox,
        source,
        'flags.weakerNestedSandbox',
        warnings,
      );
      out.flags.weakerNetworkIsolation = setBoolean(
        partial.flags.weakerNetworkIsolation,
        out.flags.weakerNetworkIsolation,
        source,
        'flags.weakerNetworkIsolation',
        warnings,
      );
      out.flags.allowLocalBinding = setBoolean(
        partial.flags.allowLocalBinding,
        out.flags.allowLocalBinding,
        source,
        'flags.allowLocalBinding',
        warnings,
      );
      if (partial.flags.linuxRuleDepth !== undefined) {
        if (typeof partial.flags.linuxRuleDepth !== 'number') {
          warnings.push({
            source,
            reason: '`flags.linuxRuleDepth` must be a number (kept previous value)',
          });
        } else {
          out.flags.linuxRuleDepth = clampLinuxRuleDepth(partial.flags.linuxRuleDepth);
        }
      }
    }
    out.gitExcludeStubs = setBoolean(partial.gitExcludeStubs, out.gitExcludeStubs, source, 'gitExcludeStubs', warnings);
  }

  return { config: out, warnings };
}
