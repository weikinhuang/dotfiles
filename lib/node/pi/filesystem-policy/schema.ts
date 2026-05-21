/**
 * Unified filesystem-policy schema consumed by both `filesystem.ts`
 * (the in-process gate for read / write / edit) and `sandbox.ts` (the
 * kernel sandbox via @anthropic-ai/sandbox-runtime).
 *
 * Read uses a "deny-then-allow-back" model: empty deny = allow
 * everything, an entry in `read.deny.*` blocks unless overridden by a
 * matching entry in `read.allow.*`. Write uses an "allow-only" model:
 * everything outside `write.allow.paths` is denied, then `write.deny.*`
 * carves additional holes inside the allowed area.
 *
 * The two models match what ASRT's `FsReadRestrictionConfig` /
 * `FsWriteRestrictionConfig` already do, so the in-process gate and the
 * kernel sandbox stay structurally aligned after Phase 1's translation
 * helpers wire them together.
 *
 * Pure module - no pi imports - so it's directly unit-testable. Tests
 * live in [`../../../../tests/lib/node/pi/filesystem-policy/schema.spec.ts`].
 */

/** Why a path matched. The four `deny-*` reasons mirror the existing
 *  `paths.ts::Reason` values plus a new `outside-allowed-write` for the
 *  allow-only write model. */
export type FilesystemReason = 'deny-basename' | 'deny-segment' | 'deny-path-prefix' | 'outside-allowed-write';

export interface FilesystemMatch {
  reason: FilesystemReason;
  detail: string;
}

/**
 * Rule set. Each field is independent and additive within a category:
 *
 *   basenames  glob patterns (`*`, `?`) matched against the basename of
 *              the resolved path, e.g. `.env`, `.env.*`, `*.key`.
 *   segments   exact names matched against any path segment, e.g.
 *              `.git/hooks`, `node_modules`. A multi-segment string
 *              (`.git/hooks`) matches when the path contains that
 *              ordered subsequence; a single-segment string (`.git`,
 *              `node_modules`) matches when the path contains a segment
 *              with that exact name.
 *   paths      tilde-expanded path prefixes, e.g. `~/.ssh`, `.`, `/tmp`.
 *              Matches when the resolved path equals the prefix or
 *              descends from it.
 */
export interface FilesystemRules {
  basenames: string[];
  segments: string[];
  paths: string[];
}

export interface ReadPolicy {
  /** Paths matched here are gated... */
  deny: FilesystemRules;
  /** ...unless they also match here, which "allows back" inside a deny. */
  allow: FilesystemRules;
}

export interface WritePolicy {
  /** Allow-only: anything outside these patterns is denied. */
  allow: FilesystemRules;
  /** Deny-within-allow: carves holes inside the allowed area. */
  deny: FilesystemRules;
}

export interface FilesystemPolicy {
  read: ReadPolicy;
  write: WritePolicy;
}

/** Layer tag preserved across loaders so warnings can name the source. */
export type FilesystemPolicySource = 'shipped' | 'user' | 'project' | 'env' | 'persona';

export interface FilesystemPolicyWarning {
  /** Source path or layer label. */
  source: string;
  reason: string;
}

// ──────────────────────────────────────────────────────────────────────
// Empties / merges
// ──────────────────────────────────────────────────────────────────────

export function emptyRules(): FilesystemRules {
  return { basenames: [], segments: [], paths: [] };
}

export function emptyReadPolicy(): ReadPolicy {
  return { deny: emptyRules(), allow: emptyRules() };
}

export function emptyWritePolicy(): WritePolicy {
  return { allow: emptyRules(), deny: emptyRules() };
}

export function emptyPolicy(): FilesystemPolicy {
  return { read: emptyReadPolicy(), write: emptyWritePolicy() };
}

/** Loose partial accepted by the merge helpers. Every field is optional
 *  and per-field unknown so loaders can pipe untrusted JSON through. */
export interface PartialRules {
  basenames?: unknown;
  segments?: unknown;
  paths?: unknown;
}
export interface PartialReadPolicy {
  deny?: PartialRules;
  allow?: PartialRules;
}
export interface PartialWritePolicy {
  allow?: PartialRules;
  deny?: PartialRules;
}
export interface PartialFilesystemPolicy {
  read?: PartialReadPolicy;
  write?: PartialWritePolicy;
}

function isStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Merge any number of partial rule sets. String items are kept verbatim;
 * non-string items are coerced via `String(...)` so a stray number in
 * user JSON doesn't crash the loader.
 */
export function mergeRules(...sources: (PartialRules | undefined | null)[]): FilesystemRules {
  const out = emptyRules();
  for (const src of sources) {
    if (!src) continue;
    if (isStringArray(src.basenames)) out.basenames.push(...src.basenames.map((v) => String(v)));
    if (isStringArray(src.segments)) out.segments.push(...src.segments.map((v) => String(v)));
    if (isStringArray(src.paths)) out.paths.push(...src.paths.map((v) => String(v)));
  }
  return out;
}

export function mergeReadPolicies(...sources: (PartialReadPolicy | undefined | null)[]): ReadPolicy {
  return {
    deny: mergeRules(...sources.map((s) => s?.deny)),
    allow: mergeRules(...sources.map((s) => s?.allow)),
  };
}

export function mergeWritePolicies(...sources: (PartialWritePolicy | undefined | null)[]): WritePolicy {
  return {
    allow: mergeRules(...sources.map((s) => s?.allow)),
    deny: mergeRules(...sources.map((s) => s?.deny)),
  };
}

/** Merge any number of partial policies, additively per category. */
export function mergePolicies(...sources: (PartialFilesystemPolicy | undefined | null)[]): FilesystemPolicy {
  return {
    read: mergeReadPolicies(...sources.map((s) => s?.read)),
    write: mergeWritePolicies(...sources.map((s) => s?.write)),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────────────────────────────

/**
 * Built-in defaults that ship with pi. User and project layers ADD on
 * top - there is no "remove a default" knob for v1; if you need one,
 * disable the extension (`PI_FILESYSTEM_DISABLED=1`).
 *
 * Defaults match plan section 6's "Default baseline":
 *
 *   read.deny  - secrets, private keys, cloud creds.
 *   write.allow - cwd ('.') plus /tmp; persona writeRoots merge later.
 *   write.deny  - .env*, .git/hooks, .git/config, node_modules.
 *
 * The frozen object guards against accidental mutation; the loader
 * always merges into a fresh copy via {@link mergePolicies}.
 */
export const DEFAULT_POLICY: Readonly<FilesystemPolicy> = Object.freeze({
  read: Object.freeze({
    deny: Object.freeze({
      basenames: ['.env', '.env.*', '.envrc'],
      segments: [],
      paths: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh', '~/.kube', '~/.docker/config.json'],
    }),
    allow: Object.freeze({ basenames: [], segments: [], paths: [] }),
  }),
  write: Object.freeze({
    allow: Object.freeze({ basenames: [], segments: [], paths: ['.', '/tmp'] }),
    deny: Object.freeze({
      basenames: ['.env', '.env.*'],
      segments: ['.git/hooks', '.git/config', 'node_modules'],
      paths: [],
    }),
  }),
});
