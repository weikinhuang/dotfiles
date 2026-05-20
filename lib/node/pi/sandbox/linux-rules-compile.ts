/**
 * Compile lexical filesystem rules (`basenames`, `segments`) to literal
 * paths for the Linux/bwrap path of ASRT, which only accepts concrete
 * paths in its `denyRead` / `denyWrite` arrays.
 *
 * Strategy:
 *   1. Use `rg --files --hidden --no-ignore-vcs --max-depth N --glob
 *      <basename>` to enumerate every existing file in the search
 *      roots whose basename matches the rule. Ripgrep is fast, respects
 *      `.gitignore`-aware pruning when asked, and is already a
 *      hard dep of the sandbox extension (`platform.ts` checks for it).
 *   2. For `segments`, walk a separate `rg --files` invocation with the
 *      segment as a literal directory glob (`<seg>/*`). Both result
 *      sets are deduped + sorted before being returned.
 *   3. Search roots are `cwd` plus any `personaWriteRoots` (per
 *      plan section 9.20). Default depth is 3, configurable via
 *      `flags.linuxRuleDepth`.
 *
 * Lossy report: any rule that compiled to ZERO literal paths is
 * surfaced in the result so `/sandbox` can flag the rule as inert. On
 * macOS we don't compile (sandbox-exec accepts globs natively); the
 * caller decides whether to invoke this module based on `platform.kind`.
 *
 * Pure module - no pi imports - so it's directly unit-testable. The
 * `rg` invocation is dependency-injected so tests can replay any
 * basename-search oracle without spawning a real ripgrep.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { type FilesystemRules, type FilesystemPolicy } from '../filesystem-policy/schema.ts';

import { LINUX_RULE_DEPTH_DEFAULT, clampLinuxRuleDepth } from './config-schema.ts';

export type RipgrepRunner = (args: string[], cwd: string) => string;

export interface CompileLinuxRulesOptions {
  /** Resolved cwd to root the search at. */
  cwd: string;
  /** Additional roots from the active persona's `writeRoots` (already
   *  tilde-expanded + resolved). */
  extraRoots?: readonly string[];
  /** Bounded depth, default 3, clamped 1..10 by
   *  {@link clampLinuxRuleDepth}. */
  depth?: number;
  /** Optional injection seam for tests. Defaults to a real `rg` spawn. */
  runRipgrep?: RipgrepRunner;
}

export interface CompiledRulesReport {
  /** Compiled literal paths (deduped, sorted) for the input rules. */
  paths: string[];
  /** Original rules that produced ZERO literal paths. Surfaced in the
   *  `/sandbox` lossy-translation report. */
  inertBasenames: string[];
  inertSegments: string[];
  /** Explicit `paths` rules that don't currently exist on disk. On
   *  Linux these still get passed to bwrap (which can deny inside an
   *  overlay even for not-yet-created paths), but on macOS the rule is
   *  silently dropped - so we surface them in both reports.  */
  inertPaths: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function uniqueSorted(input: string[]): string[] {
  return [...new Set(input)].sort();
}

// ──────────────────────────────────────────────────────────────────────
// Default rg runner
// ──────────────────────────────────────────────────────────────────────

function defaultRipgrep(args: string[], cwd: string): string {
  try {
    return execFileSync('rg', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    // Exit 1 from rg means "no matches" - that's a normal outcome, not
    // an error. Anything else (binary missing, permission denied) we
    // swallow and return empty: the lossy-translation report flags the
    // rule as inert and the caller surfaces it.
    const status = (e as { status?: number }).status;
    if (status === 1) return '';
    return '';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Compile entrypoints
// ──────────────────────────────────────────────────────────────────────

function rgArgsForBasename(glob: string, depth: number): string[] {
  return ['--files', '--hidden', '--no-ignore-vcs', '--max-depth', String(depth), '--null-data', '--glob', glob];
}

function rgArgsForSegment(segment: string, depth: number): string[] {
  // Segments turn into `<seg>/**` glob plus the inverse for nested
  // matches. Bwrap's deny model walks paths recursively from the deny
  // root, so we just need the directory itself - any descendants are
  // covered by the bwrap mount.
  return [
    '--files',
    '--hidden',
    '--no-ignore-vcs',
    '--max-depth',
    String(depth),
    '--null-data',
    '--glob',
    `**/${segment}/**`,
  ];
}

function parseRgOutput(out: string, cwd: string): string[] {
  if (!out) return [];
  return out
    .split('\0')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => resolve(cwd, line));
}

/**
 * Compile a {@link FilesystemRules} set against the supplied roots.
 * Returns the deduped path list plus a per-rule inertness report.
 */
export function compileLinuxRules(rules: FilesystemRules, options: CompileLinuxRulesOptions): CompiledRulesReport {
  const depth = clampLinuxRuleDepth(options.depth ?? LINUX_RULE_DEPTH_DEFAULT);
  const runRg = options.runRipgrep ?? defaultRipgrep;
  const roots = uniqueSorted([options.cwd, ...(options.extraRoots ?? [])]);

  const paths = new Set<string>();
  const inertBasenames: string[] = [];
  const inertSegments: string[] = [];
  const inertPaths: string[] = [];

  for (const basename of rules.basenames) {
    let matched = false;
    for (const root of roots) {
      const out = runRg(rgArgsForBasename(basename, depth), root);
      const found = parseRgOutput(out, root);
      if (found.length > 0) matched = true;
      for (const p of found) paths.add(p);
    }
    if (!matched) inertBasenames.push(basename);
  }

  for (const segment of rules.segments) {
    let matched = false;
    for (const root of roots) {
      const out = runRg(rgArgsForSegment(segment, depth), root);
      const found = parseRgOutput(out, root);
      if (found.length > 0) matched = true;
      for (const p of found) paths.add(p);
    }
    if (!matched) inertSegments.push(segment);
  }

  for (const raw of rules.paths) {
    const resolved = resolve(options.cwd, raw);
    if (!existsSync(resolved)) inertPaths.push(raw);
    paths.add(resolved);
  }

  return {
    paths: uniqueSorted([...paths]),
    inertBasenames,
    inertSegments,
    inertPaths,
  };
}

/**
 * Convenience: compile both `read.deny` and `write.deny` rule sets in
 * one pass. Most callers only ever need this shape - the per-set
 * entrypoint exists so tests can drive each rule kind independently.
 */
export interface CompiledPolicyReport {
  read: CompiledRulesReport;
  write: CompiledRulesReport;
}

export function compileLinuxPolicy(policy: FilesystemPolicy, options: CompileLinuxRulesOptions): CompiledPolicyReport {
  return {
    read: compileLinuxRules(policy.read.deny, options),
    write: compileLinuxRules(policy.write.deny, options),
  };
}
