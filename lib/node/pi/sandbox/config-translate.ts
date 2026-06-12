/**
 * Translate the unified `<piAgentDir>/filesystem.json` policy + sandbox-only
 * `<piAgentDir>/sandbox.json` knobs into ASRT's `SandboxRuntimeConfig`.
 *
 * Type-only ASRT touch: `import type { SandboxRuntimeConfig } from
 * '@anthropic-ai/sandbox-runtime'` keeps the translator structurally
 * pinned to the runtime's shape (a 0.0.x bump that drops a field would
 * surface here at typecheck), without pulling ASRT's runtime modules
 * into our pure helper tree. This is the ONLY ASRT touch under
 * `lib/`.
 *
 * Platform divergence (per plan sections 4.2, 9.7, 9.20):
 *
 *   - macOS  - sandbox-exec accepts globs natively, so basenames /
 *              segments are lifted to `**\/<glob>` patterns inline. A
 *              deny-rule pointing at a not-yet-existing file is
 *              silently dropped by sandbox-exec; the caller surfaces
 *              that in the lossy-translation report.
 *   - Linux  - bwrap accepts only literal paths. The caller pre-runs
 *              `compileLinuxPolicy()` against the policy and the
 *              resolved persona writeRoots, then passes the result in.
 *
 * `.` in `paths` resolves against the supplied `cwd`, NOT
 * `process.cwd()` (per plan section 3.2 - multi-cwd sessions translate
 * correctly when several extensions share a singleton manager).
 *
 * Pure module - no pi imports, no ASRT runtime imports.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import { expandTilde } from '../path-expand.ts';

import type { FilesystemPolicy, FilesystemRules } from '../filesystem-policy/schema.ts';

import type { SandboxConfig } from './config-schema.ts';
import type { CompiledPolicyReport } from './linux-rules-compile.ts';

export interface TranslateToASRTOptions {
  /** Resolved policy from `loadFilesystemPolicy()`. */
  policy: FilesystemPolicy;
  /** Resolved sandbox config from `loadSandboxConfig()`. */
  sandbox: SandboxConfig;
  /** Originating session's cwd. `.` in `paths` rules resolves here. */
  cwd: string;
  /** Home directory; defaults to `os.homedir()`. Override for tests. */
  homeDir?: string;
  /** Target platform. `unsupported` is treated like `darwin` for the
   *  glob-based output - callers should be checking platform.kind
   *  themselves and not invoking the sandbox at all on `unsupported`. */
  mode: 'darwin' | 'linux';
  /** Pre-computed compiled rules. REQUIRED for `mode === 'linux'`. */
  compiled?: CompiledPolicyReport;
}

export interface TranslateToASRTResult {
  config: SandboxRuntimeConfig;
  /** Per-rule notes about what was lossy. Renders into `/sandbox`. */
  lossyNotes: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Path / glob helpers
// ──────────────────────────────────────────────────────────────────────

// Local fileExists rather than reaching for `existsSync` directly so a
// future test that wants to inject a virtual fs can rebind this. Right
// now it's a thin wrapper.
function fileExists(p: string): boolean {
  return existsSync(p);
}

/** Resolve a `paths` rule against the session cwd and the home dir. */
function resolveRulePath(raw: string, cwd: string, home: string): string {
  return resolve(cwd, expandTilde(raw, home));
}

/** Convert a basename glob (`*.key`, `.env.*`, `.envrc`) to a sandbox-
 *  exec-friendly literal-or-glob pattern that matches anywhere in the
 *  tree. */
function basenameGlobToTreeGlob(basename: string): string {
  return `**/${basename}`;
}

/** Convert a segment rule (`node_modules`, `.git/hooks`) to a glob
 *  that matches the directory and everything under it. */
function segmentToTreeGlob(segment: string): string {
  return `**/${segment}/**`;
}

/** macOS path list for a rule set: paths + basename globs + segment
 *  globs. */
function macosRuleStrings(rules: FilesystemRules, cwd: string, home: string): string[] {
  const out: string[] = [];
  for (const p of rules.paths) out.push(resolveRulePath(p, cwd, home));
  for (const b of rules.basenames) out.push(basenameGlobToTreeGlob(b));
  for (const s of rules.segments) out.push(segmentToTreeGlob(s));
  return out;
}

/** Linux path list - delegates to the compiled paths supplied by the
 *  caller. The caller MUST pass `compiled` for `mode === 'linux'`. */
function linuxRuleStrings(compiled: CompiledPolicyReport, kind: 'read' | 'write'): string[] {
  return compiled[kind].paths;
}

// ── Carve-back / kernel-deny strip ────────────────────────────
//
// `classify.ts::classifyWrite` honors `write.allow.{basenames,segments}`
// as carve-back inside `write.deny` at the in-process gate. ASRT (both
// bwrap on Linux and sandbox-exec on macOS) has no equivalent allow-
// back hook for writes, so the kernel layer can't selectively re-allow
// a sub-path of a denied dir. Best-effort: when a carve-back rule
// SHADOWS a deny entry (more-specific or equal), drop the deny from
// the kernel layer entirely. The in-process gate stays the source of
// truth for the carved-out subtree, and we surface a lossy note so
// `/sandbox` can flag the relaxation.
//
// Only `write.allow.{basenames,segments}` participate; `write.allow
// .paths` is the outer gate (see classify.ts). `read.deny` is not
// stripped - reads stay enforced even when a write-side carve-back
// fires.

/** Split a multi-segment rule like `node_modules/.vite-temp` into
 *  its non-empty parts. */
function splitSegmentRule(rule: string): string[] {
  return rule.split(/[/\\]+/).filter((s) => s.length > 0);
}

/** True if carve-back segment `carve` shadows deny segment `deny` -
 *  i.e. `carve` equals `deny` or starts with `deny + '/'`. Comparison
 *  is segment-wise so `node_modulez` does NOT shadow `node_modules`. */
function segmentShadows(carve: string, deny: string): boolean {
  const cParts = splitSegmentRule(carve);
  const dParts = splitSegmentRule(deny);
  if (cParts.length === 0 || dParts.length === 0) return false;
  if (cParts.length < dParts.length) return false;
  for (let i = 0; i < dParts.length; i++) {
    if (cParts[i] !== dParts[i]) return false;
  }
  return true;
}

interface ShadowReport {
  segments: string[];
  basenames: string[];
}

/** Compute which `write.deny.{basenames,segments}` entries are
 *  shadowed by a `write.allow.{basenames,segments}` carve-back. */
function computeShadowedDenies(policy: FilesystemPolicy): ShadowReport {
  const carveSegs = policy.write.allow.segments;
  const carveBases = policy.write.allow.basenames;
  return {
    segments: policy.write.deny.segments.filter((d) => carveSegs.some((c) => segmentShadows(c, d))),
    // Basename overlap is gnarly when globs are involved (`.env.*` vs
    // `.env.local` etc.). For v1 we strip only on EXACT-string match -
    // common case is a user adding the same fixture name to both sets.
    basenames: policy.write.deny.basenames.filter((d) => carveBases.includes(d)),
  };
}

/** Build a copy of `write.deny` with shadowed segments / basenames
 *  removed. Used to drive the kernel-deny output ONLY - the in-process
 *  gate keeps using the original policy + carve-back. */
function stripShadowedFromWriteDeny(rules: FilesystemRules, shadowed: ShadowReport): FilesystemRules {
  return {
    paths: rules.paths,
    basenames: rules.basenames.filter((b) => !shadowed.basenames.includes(b)),
    segments: rules.segments.filter((s) => !shadowed.segments.includes(s)),
  };
}

/** True if compiled deny path `p` was generated from a now-shadowed
 *  segment / basename rule. Heuristic: tail-segments equal a shadowed
 *  segment, OR basename matches a shadowed basename glob. Used on the
 *  Linux side where compileLinuxPolicy doesn't preserve provenance. */
function compiledPathIsShadowed(p: string, shadowed: ShadowReport): boolean {
  const parts = p.split(sep).filter((s) => s.length > 0);
  for (const seg of shadowed.segments) {
    const segParts = splitSegmentRule(seg);
    if (segParts.length === 0 || parts.length < segParts.length) continue;
    const tail = parts.slice(parts.length - segParts.length);
    if (segParts.every((s, i) => s === tail[i])) return true;
  }
  if (shadowed.basenames.length > 0) {
    const base = parts[parts.length - 1] ?? '';
    for (const b of shadowed.basenames) {
      // Same glob semantic as classify.ts::globToRegex - cheaper than
      // importing it here since we only need to re-check exact basename
      // strings, not arbitrary path globs.
      const re = new RegExp(
        `^${b
          .split('')
          .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
          .join('')}$`,
      );
      if (re.test(base)) return true;
    }
  }
  return false;
}

/** Append lossy notes describing each shadowed kernel-deny entry so
 *  `/sandbox` surfaces the relaxation. */
function shadowedDenyNotes(shadowed: ShadowReport, mode: 'darwin' | 'linux'): string[] {
  const notes: string[] = [];
  for (const seg of shadowed.segments) {
    notes.push(
      `${mode === 'linux' ? 'Linux' : 'macOS'}: kernel write-deny on segment \`${seg}\` relaxed by a write.allow.segments carve-back; the in-process gate is the only enforcer for that subtree.`,
    );
  }
  for (const b of shadowed.basenames) {
    notes.push(
      `${mode === 'linux' ? 'Linux' : 'macOS'}: kernel write-deny on basename \`${b}\` relaxed by a write.allow.basenames carve-back; the in-process gate is the only enforcer.`,
    );
  }
  return notes;
}

// ──────────────────────────────────────────────────────────────────────
// Public translator
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the ASRT runtime config. Always returns a shape that satisfies
 * `SandboxRuntimeConfig` (after schema validation by ASRT itself); we
 * keep the type assertion narrow so a downstream zod-parse failure
 * surfaces as an obvious shape mismatch in tests.
 */
export function translateToASRT(options: TranslateToASRTOptions): TranslateToASRTResult {
  const { policy, sandbox, cwd, mode } = options;
  const home = options.homeDir ?? homedir();
  const lossyNotes: string[] = [];

  if (mode === 'linux' && !options.compiled) {
    throw new Error('translateToASRT(linux) requires the `compiled` option from compileLinuxPolicy()');
  }

  // ── filesystem ───────────────────────────────────────────────────
  // allowWrite: every entry in `write.allow.paths` resolved, plus the
  // mandatory `~/.pi` auto-add (plan section 3.2 - "Auto-adds ~/.pi to
  // write.allow.paths so any extension that ever writes through a
  // wrapped shell doesn't EPERM").
  const allowWrite = new Set<string>();
  for (const p of policy.write.allow.paths) {
    allowWrite.add(resolveRulePath(p, cwd, home));
  }
  allowWrite.add(`${home}/.pi`);

  // Carve-back / kernel-deny strip: when a `write.allow.{basenames,
  // segments}` entry shadows a `write.deny.{basenames,segments}`
  // entry, drop the deny from the kernel layer. ASRT can't allow-back
  // inside a deny on either bwrap or sandbox-exec, so this is the
  // closest approximation - the in-process gate (classify.ts) keeps
  // enforcing the deny everywhere except the carved-out subtree.
  const shadowed = computeShadowedDenies(policy);
  lossyNotes.push(...shadowedDenyNotes(shadowed, mode));
  const writeDenyForKernel = stripShadowedFromWriteDeny(policy.write.deny, shadowed);

  let denyRead: string[];
  let allowRead: string[] | undefined;
  let denyWrite: string[];

  if (mode === 'linux') {
    // Narrow `compiled` once; the early-throw above guarantees presence
    // here. Single `!` keeps oxlint's non-nullable-type-assertion-style
    // happy without spraying bangs across the rest of this branch.
    const compiled = options.compiled!;
    denyRead = linuxRuleStrings(compiled, 'read');
    // compileLinuxPolicy doesn't preserve provenance from input rule to
    // output literal path, so we filter the compiled deny list here
    // using the lexical shadow report.
    denyWrite = linuxRuleStrings(compiled, 'write').filter((p) => !compiledPathIsShadowed(p, shadowed));
    // No `allowRead` compile pass on Linux - the in-process gate still
    // honors `read.allow.*`, but bwrap's deny path is a flat list. We
    // surface the divergence as a lossy note when a non-empty allow
    // set was supplied.
    if (
      policy.read.allow.basenames.length > 0 ||
      policy.read.allow.segments.length > 0 ||
      policy.read.allow.paths.length > 0
    ) {
      lossyNotes.push('Linux: read.allow.* is not translated to bwrap; the in-process gate still honors it.');
    }
    if (compiled.read.inertBasenames.length > 0) {
      lossyNotes.push(
        `Linux: read.deny.basenames found no on-disk matches: ${compiled.read.inertBasenames.join(', ')}`,
      );
    }
    if (compiled.read.inertSegments.length > 0) {
      lossyNotes.push(`Linux: read.deny.segments found no on-disk matches: ${compiled.read.inertSegments.join(', ')}`);
    }
    if (compiled.write.inertBasenames.length > 0) {
      lossyNotes.push(
        `Linux: write.deny.basenames found no on-disk matches: ${compiled.write.inertBasenames.join(', ')}`,
      );
    }
    if (compiled.write.inertSegments.length > 0) {
      lossyNotes.push(
        `Linux: write.deny.segments found no on-disk matches: ${compiled.write.inertSegments.join(', ')}`,
      );
    }
    // Explicit `paths` rules that don't currently exist on disk. Bwrap
    // CAN enforce them when the parent dir is writable (see plan §9.22),
    // but `/sandbox` should still surface them so users notice typos.
    if (compiled.read.inertPaths.length > 0) {
      lossyNotes.push(`Linux: read.deny.paths entries do not currently exist: ${compiled.read.inertPaths.join(', ')}`);
    }
    if (compiled.write.inertPaths.length > 0) {
      lossyNotes.push(
        `Linux: write.deny.paths entries do not currently exist: ${compiled.write.inertPaths.join(', ')}`,
      );
    }
  } else {
    denyRead = macosRuleStrings(policy.read.deny, cwd, home);
    denyWrite = macosRuleStrings(writeDenyForKernel, cwd, home);
    const allow = macosRuleStrings(policy.read.allow, cwd, home);
    allowRead = allow.length > 0 ? allow : undefined;

    // Per plan section 9.22: nonexistent denyWrite/denyRead paths
    // silently become inert on macOS (sandbox-exec resolves to realpath
    // at profile-build time and drops missing rules). Surface them so
    // `/sandbox` can flag.
    for (const raw of writeDenyForKernel.paths) {
      if (!fileExists(resolveRulePath(raw, cwd, home))) {
        lossyNotes.push(
          `macOS: write.deny.paths entry ${raw} does not currently exist; sandbox-exec will silently drop the rule.`,
        );
      }
    }
    for (const raw of policy.read.deny.paths) {
      if (!fileExists(resolveRulePath(raw, cwd, home))) {
        lossyNotes.push(
          `macOS: read.deny.paths entry ${raw} does not currently exist; sandbox-exec will silently drop the rule.`,
        );
      }
    }
  }

  // ── network ──────────────────────────────────────────────────────
  const allowUnixSockets = sandbox.unixSockets.allow.length > 0 ? [...sandbox.unixSockets.allow] : undefined;

  // ASRT honors a per-path `allowUnixSockets` list only on macOS
  // (sandbox-exec can match socket paths). On Linux, unix-socket
  // access is all-or-nothing, gated by a seccomp-bpf filter that
  // cannot inspect socket paths; the path list is silently dropped
  // and only `allowAllUnixSockets` has any effect. Surface that here
  // so a user who allow-listed e.g. `/var/run/docker.sock` on Linux
  // sees in `/sandbox` why their socket is still blocked.
  if (mode === 'linux' && allowUnixSockets && allowUnixSockets.length > 0 && !sandbox.unixSockets.allowAll) {
    lossyNotes.push(
      `Linux: unixSockets.allow is ignored (seccomp cannot match socket paths); these entries have no effect: ${allowUnixSockets.join(', ')}. Set unixSockets.allowAll to permit unix sockets (coarse - opens all of them).`,
    );
  }

  const networkConfig: SandboxRuntimeConfig['network'] = {
    allowedDomains: [...sandbox.network.allow],
    deniedDomains: [...sandbox.network.deny],
    ...(allowUnixSockets ? { allowUnixSockets } : {}),
    ...(sandbox.unixSockets.allowAll ? { allowAllUnixSockets: true } : {}),
    ...(sandbox.flags.allowLocalBinding ? { allowLocalBinding: true } : {}),
  };

  // ── assemble ─────────────────────────────────────────────────────
  const config: SandboxRuntimeConfig = {
    network: networkConfig,
    filesystem: {
      denyRead,
      ...(allowRead ? { allowRead } : {}),
      allowWrite: [...allowWrite].sort(),
      denyWrite,
    },
    ...(sandbox.flags.weakerNestedSandbox ? { enableWeakerNestedSandbox: true } : {}),
    ...(sandbox.flags.weakerNetworkIsolation ? { enableWeakerNetworkIsolation: true } : {}),
  };

  return { config, lossyNotes };
}
