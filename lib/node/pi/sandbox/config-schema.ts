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
  /** ASRT `network.allowLocalBinding` - lets sandboxed children bind
   *  127.0.0.1 sockets (e.g. dev-server tests). */
  allowLocalBinding: boolean;
  /** Default 3 (per plan section 6). Tuneable for deep monorepos.
   *  Bounded between 1 and 10 by {@link clampLinuxRuleDepth}. */
  linuxRuleDepth: number;
}

export interface SandboxConfig {
  network: SandboxNetworkConfig;
  unixSockets: SandboxUnixSocketsConfig;
  flags: SandboxFlags;
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
});

// ──────────────────────────────────────────────────────────────────────
// Empties / merges
// ──────────────────────────────────────────────────────────────────────

export function emptySandboxConfig(): SandboxConfig {
  return {
    network: { allow: [], deny: [] },
    unixSockets: { allow: [], allowAll: false },
    flags: {
      weakerNestedSandbox: false,
      weakerNetworkIsolation: false,
      allowLocalBinding: false,
      linuxRuleDepth: LINUX_RULE_DEPTH_DEFAULT,
    },
  };
}

/** Loose partial used by loaders. Every field is unknown so untrusted
 *  JSON can be piped through. */
export interface PartialSandboxConfig {
  network?: {
    allow?: unknown;
    deny?: unknown;
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
  out.unixSockets.allow.push(...DEFAULT_SANDBOX_CONFIG.unixSockets.allow);
  out.unixSockets.allowAll = DEFAULT_SANDBOX_CONFIG.unixSockets.allowAll;
  out.flags = { ...DEFAULT_SANDBOX_CONFIG.flags };

  const warnings: SandboxConfigWarning[] = [];

  for (const { source, partial } of layers) {
    if (partial.network) {
      pushStrings(out.network.allow, partial.network.allow, source, 'network.allow', warnings);
      pushStrings(out.network.deny, partial.network.deny, source, 'network.deny', warnings);
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
  }

  return { config: out, warnings };
}
