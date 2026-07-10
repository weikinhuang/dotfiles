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
 *   4. Explicit `paths` rules that exist on disk are resolved through
 *      `realpathSync` so a symlinked deny path (e.g. `~/.ssh` ->
 *      `/mnt/d/.../.ssh`) is denied at its real location. bwrap cannot
 *      mount a tmpfs / ro-bind ON a symlink, so emitting the literal
 *      symlink aborts the whole wrap with `Can't mount tmpfs on ...:
 *      No such file or directory`.
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
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

import { type FilesystemRules, type FilesystemPolicy } from '../filesystem-policy/schema.ts';
import { expandTilde } from '../path-expand.ts';

import { LINUX_RULE_DEPTH_DEFAULT, clampLinuxRuleDepth } from './config-schema.ts';

export type RipgrepRunner = (args: string[], cwd: string) => string;

/**
 * Thrown by {@link defaultRipgrep} when `rg` could not be run at all
 * (binary missing, permission denied, or a non-"no matches" exit). This
 * is distinct from rg's exit-1 "no matches", which is a normal outcome
 * that returns empty output. Compilation catches this and records it in
 * {@link CompiledRulesReport.errors} so the sandbox layer can warn that
 * the kernel deny list may be incomplete instead of silently treating a
 * failed search as "nothing to deny".
 */
export class RipgrepUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RipgrepUnavailableError';
  }
}

export interface CompileLinuxRulesOptions {
  /** Resolved cwd to root the search at. */
  cwd: string;
  /** Additional roots from the active persona's `writeRoots` (already
   *  tilde-expanded + resolved). */
  extraRoots?: readonly string[];
  /** Bounded depth, default 3, clamped 1..10 by
   *  {@link clampLinuxRuleDepth}. */
  depth?: number;
  /** Home directory for expanding a leading `~` in `paths` rules.
   *  Defaults to `os.homedir()`; injected for deterministic tests. */
  homedir?: string;
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
  /** Ripgrep invocations that FAILED to run (binary missing, permission
   *  denied, non-"no matches" exit). Non-empty means the compiled deny
   *  list is potentially INCOMPLETE - a failed search is not the same as
   *  "no paths to deny". The sandbox layer surfaces these so the kernel
   *  deny list isn't silently trusted when it may be missing entries.
   *  Optional so hand-built report literals (tests, fixtures) stay valid;
   *  {@link compileLinuxRules} always populates it. */
  errors?: string[];
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
  } catch (err) {
    // Exit 1 from rg means "no matches" - a normal outcome; return the
    // (empty) stdout. Anything else - binary missing (ENOENT), permission
    // denied, or exit >= 2 (a real rg error) - must NOT masquerade as
    // "no paths to deny": that would silently empty the kernel deny list.
    // Throw so compilation records it and the sandbox layer can warn.
    const e = err as { status?: number | null; code?: string; stdout?: string | Buffer };
    if (e.status === 1) {
      return typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '');
    }
    const detail = e.code ? `${e.code}` : `exit ${String(e.status)}`;
    throw new RipgrepUnavailableError(`ripgrep failed (${detail}) in ${cwd}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Compile entrypoints
// ──────────────────────────────────────────────────────────────────────

// Shared rg flags for both basename and segment compilation. Order:
//   --no-config       - ignore the user's ~/.ripgreprc / RIPGREP_CONFIG_PATH
//                       so a personal `--glob=!node_modules` line can't
//                       silently hide the very paths we're trying to deny.
//   --no-ignore       - don't apply .gitignore / global ignore at all;
//                       deny-rule resolution must see everything on disk.
//   --hidden          - include dotfiles (most deny rules target dotfiles).
//   --max-depth N     - cap traversal cost.
//   -0 (= --null)     - emit results NUL-separated so paths with newlines
//                       parse correctly. NOT --null-data (that's an INPUT
//                       flag and silently no-ops with --files).
const RG_BASE_FLAGS = ['--no-config', '--no-ignore', '--hidden'] as const;

function rgArgsForBasename(glob: string, depth: number): string[] {
  return ['--files', ...RG_BASE_FLAGS, '--max-depth', String(depth), '-0', '--glob', glob];
}

function rgArgsForSegment(segment: string, depth: number): string[] {
  // Bwrap's deny model walks paths recursively from the deny root, so
  // we just need ONE file inside the segment dir to lock in the rule -
  // any descendants are covered by the bwrap mount.
  return ['--files', ...RG_BASE_FLAGS, '--max-depth', String(depth), '-0', '--glob', `**/${segment}/**`];
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
 * Collapse a per-file rg match to the outermost ancestor directory
 * whose path tail equals `segParts`.
 *
 * Examples (Linux `sep === '/'`):
 *
 *   `/repo/node_modules/foo/bar.js` + `['node_modules']`
 *     -> `/repo/node_modules`
 *   `/repo/sub/node_modules/baz` + `['node_modules']`
 *     -> `/repo/sub/node_modules`
 *   `/repo/node_modules/p/node_modules/inner` + `['node_modules']`
 *     -> `/repo/node_modules`  (outermost wins; recursive deny
 *                                mount covers the inner one)
 *   `/repo/.git/hooks/pre-commit.sample` + `['.git', 'hooks']`
 *     -> `/repo/.git/hooks`
 *   `/repo/.git/config` + `['.git', 'config']`
 *     -> `/repo/.git/config`  (file path collapses to itself when
 *                              the segment ends at the file's
 *                              basename)
 *
 * Returns `undefined` when the path does not contain `segParts` as a
 * contiguous component subsequence - which the rg glob produced by
 * `rgArgsForSegment` shouldn't yield, but the defensive guard keeps a
 * misconfigured rg runner from polluting the deny list.
 */
export function collapseToSegmentDir(absolutePath: string, segParts: string[]): string | undefined {
  if (segParts.length === 0) return absolutePath;
  const parts = absolutePath.split(sep);
  for (let i = 0; i + segParts.length <= parts.length; i++) {
    let ok = true;
    for (let j = 0; j < segParts.length; j++) {
      if (parts[i + j] !== segParts[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return parts.slice(0, i + segParts.length).join(sep);
  }
  return undefined;
}

/**
 * Compile a {@link FilesystemRules} set against the supplied roots.
 * Returns the deduped path list plus a per-rule inertness report.
 */
export function compileLinuxRules(rules: FilesystemRules, options: CompileLinuxRulesOptions): CompiledRulesReport {
  const depth = clampLinuxRuleDepth(options.depth ?? LINUX_RULE_DEPTH_DEFAULT);
  const runRg = options.runRipgrep ?? defaultRipgrep;
  const home = options.homedir ?? homedir();
  const roots = uniqueSorted([options.cwd, ...(options.extraRoots ?? [])]);

  const paths = new Set<string>();
  const inertBasenames: string[] = [];
  const inertSegments: string[] = [];
  const inertPaths: string[] = [];
  const errors: string[] = [];

  // Run a ripgrep query, recording (rather than swallowing) a hard
  // failure so the deny list is never silently trusted as complete when
  // the search could not run. A failed query yields no matches for that
  // rule locally, but `errors` flags the degraded state to the caller.
  const safeRunRg = (args: string[], root: string): string => {
    try {
      return runRg(args, root);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return '';
    }
  };

  for (const basename of rules.basenames) {
    let matched = false;
    for (const root of roots) {
      const out = safeRunRg(rgArgsForBasename(basename, depth), root);
      const found = parseRgOutput(out, root);
      if (found.length > 0) matched = true;
      for (const p of found) paths.add(p);
    }
    if (!matched) inertBasenames.push(basename);
  }

  for (const segment of rules.segments) {
    let matched = false;
    const segParts = segment.split(/[\\/]+/).filter((s) => s.length > 0);
    for (const root of roots) {
      const out = safeRunRg(rgArgsForSegment(segment, depth), root);
      const found = parseRgOutput(out, root);
      if (found.length === 0) continue;
      matched = true;
      // Collapse each per-file match to the OUTERMOST ancestor whose
      // path tail equals `segParts`. Bwrap's deny mount is recursive
      // (`--ro-bind /dev/null <dir>` masks every descendant), so the
      // outermost match is sufficient AND minimal: emitting per-file
      // paths fans out to thousands of bwrap args in workspaces with
      // a populated `node_modules`, blowing past Linux's 128 KiB
      // MAX_ARG_STRLEN on the resulting `bash -c '<wrapped>'` argv.
      // Mirrors ASRT's own `linuxGetMandatoryDenyPaths` heuristic.
      for (const file of found) {
        const collapsed = collapseToSegmentDir(file, segParts);
        if (collapsed) paths.add(collapsed);
      }
    }
    if (!matched) inertSegments.push(segment);
  }

  for (const raw of rules.paths) {
    // Expand a leading `~` before resolving so shipped defaults like
    // `~/.ssh` compile to the real home path instead of `<cwd>/~/.ssh`.
    // Mirrors filesystem-policy/classify.ts and config-translate.ts.
    const resolved = resolve(options.cwd, expandTilde(raw, home));
    if (!existsSync(resolved)) {
      inertPaths.push(raw);
      paths.add(resolved);
      continue;
    }
    // Resolve symlinks to the real on-disk location. bwrap's deny
    // mounts (`--tmpfs` for read-deny, `--ro-bind /dev/null` for
    // write-deny) operate on the resolved mount target, and bwrap
    // CANNOT mount on a path that is itself a symlink - it follows the
    // link and fails with `Can't mount tmpfs on <target>: No such file
    // or directory` when the target doesn't resolve inside the sandbox
    // newroot. This bites a common dotfiles pattern where a sensitive
    // deny path is symlinked to a synced drive (`~/.ssh` ->
    // `/mnt/d/.../.ssh`). Denying the realpath makes the mount land on
    // the actual directory; reads through the original symlink still
    // resolve into the masked target, so the deny is preserved.
    let target = resolved;
    try {
      target = realpathSync(resolved);
    } catch {
      // Fall back to the lexically-resolved path if realpath fails
      // (TOCTOU race, permission). Better an imperfect deny entry than
      // aborting the whole compile.
    }
    paths.add(target);
  }

  return {
    paths: uniqueSorted([...paths]),
    inertBasenames,
    inertSegments,
    inertPaths,
    errors,
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
