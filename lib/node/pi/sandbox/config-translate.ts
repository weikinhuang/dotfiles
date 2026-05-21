/**
 * Translate the unified `~/.pi/filesystem.json` policy + sandbox-only
 * `~/.pi/sandbox.json` knobs into ASRT's `SandboxRuntimeConfig`.
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
import { resolve } from 'node:path';

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

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
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return home + raw.slice(1);
  return resolve(cwd, raw);
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

  let denyRead: string[];
  let allowRead: string[] | undefined;
  let denyWrite: string[];

  if (mode === 'linux') {
    // Narrow `compiled` once; the early-throw above guarantees presence
    // here. Single `!` keeps oxlint's non-nullable-type-assertion-style
    // happy without spraying bangs across the rest of this branch.
    const compiled = options.compiled!;
    denyRead = linuxRuleStrings(compiled, 'read');
    denyWrite = linuxRuleStrings(compiled, 'write');
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
    denyWrite = macosRuleStrings(policy.write.deny, cwd, home);
    const allow = macosRuleStrings(policy.read.allow, cwd, home);
    allowRead = allow.length > 0 ? allow : undefined;

    // Per plan section 9.22: nonexistent denyWrite/denyRead paths
    // silently become inert on macOS (sandbox-exec resolves to realpath
    // at profile-build time and drops missing rules). Surface them so
    // `/sandbox` can flag.
    for (const raw of policy.write.deny.paths) {
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
