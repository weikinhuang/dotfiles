/**
 * Pure helpers for config/pi/extensions/protected-paths.ts.
 *
 * This module intentionally has zero dependencies on @earendil-works/pi-coding-agent
 * so it can be imported and unit-tested under `vitest` without any
 * TypeScript toolchain or pi runtime.
 */

import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type Reason = 'outside-workspace' | 'basename' | 'segment' | 'path-prefix';

export interface Protection {
  reason: Reason;
  detail: string;
}

/**
 * Rule set consumed by {@link classify}. Each field is independent:
 *
 *   basenames  glob patterns (`*`, `?`) matched against the basename of the
 *              resolved path, e.g. `.env`, `.env.*`, `*.key`.
 *   segments   exact names matched against any segment of the resolved path,
 *              e.g. `node_modules`, `.git`. A segment match fires whether the
 *              path IS the segment (`foo/.git`) or is INSIDE it (`foo/.git/HEAD`).
 *   paths      tilde-expanded, resolved path prefixes, e.g. `~/.ssh`. Matches
 *              when the resolved path is exactly the prefix or a descendant.
 */
export interface ProtectionRules {
  basenames: string[];
  segments: string[];
  paths: string[];
}

/**
 * Top-level user config. Split into two categories so reads and writes can
 * have different strictness:
 *
 *   read   applies to the `read` tool. Outside-workspace is NOT enforced
 *          (reading files outside cwd is often legit — nearby READMEs,
 *          dotfiles, etc.).
 *   write  applies to `write` / `edit`. Outside-workspace IS enforced.
 *          The effective write rule set is `read ∪ write` — anything
 *          sensitive-to-read is trivially sensitive-to-write, so there's
 *          no point forcing users to duplicate entries.
 */
export interface ProtectionConfig {
  read: ProtectionRules;
  write: ProtectionRules;
}

// ──────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Handles `~`, `~/foo`, and (on Windows) `~\foo`. `~user/` is intentionally
 * NOT supported — it requires a password-db lookup and is almost never
 * emitted by an LLM. Anything else (e.g. `$HOME/foo`) is left alone; pi's
 * tools don't do shell env-var expansion either, so the literal string is
 * what would actually be used.
 */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith(`~${sep}`)) {
    return homedir() + p.slice(1);
  }
  return p;
}

/**
 * Convert a simple glob (supporting `*` and `?`) to an anchored RegExp.
 * Everything else is escaped to be matched literally.
 */
export function globToRegex(glob: string): RegExp {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

export function basenameOf(absolutePath: string): string {
  const idx = absolutePath.lastIndexOf(sep);
  return idx === -1 ? absolutePath : absolutePath.slice(idx + 1);
}

export function isInsideWorkspace(absolutePath: string, cwd: string): boolean {
  const rel = relative(cwd, absolutePath);
  // `rel` starts with `..` (or is absolute on Windows) when outside.
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

/**
 * True if any segment of the absolute path (including cwd-relative portions)
 * exactly equals `segment`. We split the full absolute path rather than just
 * the relative remainder so that a file literally named `.git` sitting at
 * the workspace root still matches the segment rule.
 */
export function pathContainsSegment(absolutePath: string, segment: string): boolean {
  if (!segment) return false;
  return absolutePath.split(sep).includes(segment);
}

/**
 * True if `absolutePath` is exactly `prefix` or a descendant of it.
 *
 * Both arguments must already be absolute/tilde-expanded. Uses path-aware
 * separator matching so `/foo/bar` does NOT match `/foo/barbaz`.
 */
export function isUnderPath(absolutePath: string, prefix: string): boolean {
  if (!prefix) return false;
  if (absolutePath === prefix) return true;
  const withSep = prefix.endsWith(sep) ? prefix : prefix + sep;
  return absolutePath.startsWith(withSep);
}

// ──────────────────────────────────────────────────────────────────────
// Rule / config helpers
// ──────────────────────────────────────────────────────────────────────

export function emptyRules(): ProtectionRules {
  return { basenames: [], segments: [], paths: [] };
}

export function emptyConfig(): ProtectionConfig {
  return { read: emptyRules(), write: emptyRules() };
}

/** Merge any number of partial rule sets into a single concrete rule set. */
export function mergeRules(...sources: (Partial<ProtectionRules> | undefined | null)[]): ProtectionRules {
  const out = emptyRules();
  for (const src of sources) {
    if (!src) continue;
    if (Array.isArray(src.basenames)) out.basenames.push(...src.basenames.map(String));
    if (Array.isArray(src.segments)) out.segments.push(...src.segments.map(String));
    if (Array.isArray(src.paths)) out.paths.push(...src.paths.map(String));
  }
  return out;
}

/** Merge any number of partial configs, additively per category. */
export function mergeConfigs(
  ...sources: ({ read?: Partial<ProtectionRules>; write?: Partial<ProtectionRules> } | undefined | null)[]
): ProtectionConfig {
  return {
    read: mergeRules(...sources.map((s) => s?.read)),
    write: mergeRules(...sources.map((s) => s?.write)),
  };
}

/**
 * Built-in defaults. These are always active — user config only ADDS to
 * them. If you need to turn a default off, set PI_PROTECTED_PATHS_DISABLED=1
 * and build your own gate.
 *
 * `read` covers files/dirs whose contents themselves are sensitive (secrets,
 * private keys). `write` adds directories that are safe to read from but
 * dangerous to mutate (vendored deps, VCS metadata).
 */
export const DEFAULT_CONFIG: Readonly<ProtectionConfig> = Object.freeze({
  read: Object.freeze({
    basenames: ['.env', '.env.*', '.envrc'],
    segments: [],
    paths: ['~/.ssh'],
  }),
  write: Object.freeze({
    basenames: [],
    segments: ['node_modules', '.git'],
    paths: [],
  }),
});

// ──────────────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────────────

export interface ClassifyOptions {
  /**
   * Whether to treat a path outside `cwd` as protected. `true` for
   * writes (default), `false` for reads (reading external files is
   * often legitimate — nearby READMEs, config templates, etc.).
   */
  checkOutsideWorkspace?: boolean;
}

/**
 * Classify an `inputPath` against a rule set. Returns null when the path
 * is safe, or a {@link Protection} describing why the gate should prompt.
 *
 * The `inputPath` is tilde-expanded before being resolved, so an LLM
 * reading `~/.ssh/id_rsa` trips the path-prefix rule instead of being
 * silently resolved to `./~/.ssh/id_rsa`.
 *
 * Precedence (first match wins):
 *   1. path-prefix       — catches `~/.ssh/*` etc. Checked first so the
 *                          user sees a specific reason rather than a
 *                          generic "outside workspace".
 *   2. outside-workspace — only if `checkOutsideWorkspace` is true
 *   3. basename          — globs on the basename
 *   4. segment           — exact match on any path segment
 */
export function classify(
  inputPath: string,
  cwd: string,
  rules: ProtectionRules,
  options: ClassifyOptions = {},
): Protection | null {
  const { checkOutsideWorkspace = true } = options;
  const absolute = resolve(cwd, expandTilde(inputPath));

  for (const raw of rules.paths) {
    const prefix = resolve(expandTilde(raw));
    if (isUnderPath(absolute, prefix)) {
      return { reason: 'path-prefix', detail: `Protected path prefix (${raw})` };
    }
  }

  if (checkOutsideWorkspace && !isInsideWorkspace(absolute, cwd)) {
    return { reason: 'outside-workspace', detail: `Outside workspace (${cwd})` };
  }

  const base = basenameOf(absolute);
  for (const glob of rules.basenames) {
    if (globToRegex(glob).test(base)) {
      return { reason: 'basename', detail: `Sensitive basename (${glob})` };
    }
  }

  for (const segment of rules.segments) {
    if (pathContainsSegment(absolute, segment)) {
      return { reason: 'segment', detail: `Inside protected directory (${segment}/)` };
    }
  }

  return null;
}

/**
 * Convenience: classify for a `read` tool call (read rules only, no
 * outside-workspace check).
 */
export function classifyRead(inputPath: string, cwd: string, config: ProtectionConfig): Protection | null {
  return classify(inputPath, cwd, config.read, { checkOutsideWorkspace: false });
}

/**
 * Convenience: classify for a `write` / `edit` tool call. Uses the union
 * of read and write rules so anything sensitive-to-read is also
 * sensitive-to-write without needing duplicate config entries.
 */
export function classifyWrite(inputPath: string, cwd: string, config: ProtectionConfig): Protection | null {
  const merged = mergeRules(config.read, config.write);
  return classify(inputPath, cwd, merged, { checkOutsideWorkspace: true });
}
