/**
 * Classification helpers for the unified `<piAgentDir>/filesystem.json` policy.
 *
 * Read uses deny-then-allow-back semantics:
 *   1. If a `read.deny.*` entry matches, gate the path...
 *   2. ...unless a `read.allow.*` entry also matches, which "allows
 *      back" within an otherwise-denied prefix.
 *   3. No outside-workspace check on reads - reading nearby READMEs
 *      and dotfiles is routine.
 *
 * Write uses allow-only-with-carve-back semantics:
 *   1. If the path is NOT under any `write.allow.paths` prefix, gate
 *      with reason `outside-allowed-write`. `write.allow.paths` is the
 *      OUTER GATE only - it doesn't act as carve-back inside the deny
 *      sets, so the default `'.'` doesn't accidentally cancel every
 *      `write.deny.*` rule.
 *   2. Otherwise, if any `write.deny.*` or `read.deny.*` entry
 *      matches, gate with the matching `deny-*` reason - UNLESS a
 *      matching `write.allow.basenames` or `write.allow.segments`
 *      entry carves the path back. Carve-back mirrors `read.allow`
 *      and lets a project policy say "deny `node_modules` writes,
 *      EXCEPT under `node_modules/.vite-temp`".
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 */

import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

import { type FilesystemMatch, type FilesystemPolicy, type FilesystemRules } from './schema.ts';

// ──────────────────────────────────────────────────────────────────────
// Path helpers (shared with sandbox/* and ported from paths.ts so the
// duplicate copy can be deleted with `paths.ts` in Phase 3).
// ──────────────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the user's home directory. `~user/` is NOT
 * supported (would require a password-db lookup). Anything else falls
 * through unchanged - pi tools don't shell-expand `$HOME` either.
 */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith(`~${sep}`)) {
    return homedir() + p.slice(1);
  }
  return p;
}

/** Convert `*` / `?` glob to an anchored RegExp; everything else literal. */
export function globToRegex(glob: string): RegExp {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

/** Last segment after the last separator. Empty for trailing-slash paths. */
export function basenameOf(absolutePath: string): string {
  const idx = absolutePath.lastIndexOf(sep);
  return idx === -1 ? absolutePath : absolutePath.slice(idx + 1);
}

export function isInsideWorkspace(absolutePath: string, cwd: string): boolean {
  const rel = relative(cwd, absolutePath);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

/**
 * True if any segment of `absolutePath` exactly equals the supplied
 * single-segment name, OR if the path contains the supplied multi-
 * segment subsequence in order.
 *
 *   pathContainsSegment('/p/.git/hooks/pre-commit', '.git')          true
 *   pathContainsSegment('/p/.git/hooks/pre-commit', '.git/hooks')    true
 *   pathContainsSegment('/p/.github/workflows/ci.yml', '.git')       false
 */
export function pathContainsSegment(absolutePath: string, segment: string): boolean {
  if (!segment) return false;
  const wanted = segment.split(/[/\\]/).filter(Boolean);
  if (wanted.length === 0) return false;
  const parts = absolutePath.split(sep).filter(Boolean);
  outer: for (let i = 0; i + wanted.length <= parts.length; i++) {
    for (let j = 0; j < wanted.length; j++) {
      if (parts[i + j] !== wanted[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** True if `absolutePath` equals or descends from `prefix`. */
export function isUnderPath(absolutePath: string, prefix: string): boolean {
  if (!prefix) return false;
  if (absolutePath === prefix) return true;
  const withSep = prefix.endsWith(sep) ? prefix : prefix + sep;
  return absolutePath.startsWith(withSep);
}

// ──────────────────────────────────────────────────────────────────────
// Rule matching
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a rule-file `paths` entry to an absolute path. Tilde-expand,
 * then resolve against `cwd` so a `paths: ['.']` entry under
 * `<piAgentDir>/filesystem.json` means "the session's cwd at evaluation time"
 * (matches plan section 3.2 - `.` resolves against `ctx.cwd`, not
 * `process.cwd`).
 */
export function resolveRulePath(rawPath: string, cwd: string): string {
  return resolve(cwd, expandTilde(rawPath));
}

/**
 * Walk a rule set and return the first matching reason, or `null`.
 * Precedence inside a rule set:
 *   1. paths (most specific - usually identifies a known sensitive dir)
 *   2. basenames (.env etc.)
 *   3. segments (node_modules, .git/hooks, etc.)
 *
 * The returned `reason` is prefixed `deny-*` even when called for an
 * allow set; callers compose it with a context label themselves.
 */
function matchRules(absolute: string, rules: FilesystemRules, cwd: string): FilesystemMatch | null {
  for (const raw of rules.paths) {
    const prefix = resolveRulePath(raw, cwd);
    if (isUnderPath(absolute, prefix)) {
      return { reason: 'deny-path-prefix', detail: `Path prefix (${raw})` };
    }
  }

  const base = basenameOf(absolute);
  for (const glob of rules.basenames) {
    if (globToRegex(glob).test(base)) {
      return { reason: 'deny-basename', detail: `Basename (${glob})` };
    }
  }

  for (const segment of rules.segments) {
    if (pathContainsSegment(absolute, segment)) {
      return { reason: 'deny-segment', detail: `Path segment (${segment})` };
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Public classify entry points
// ──────────────────────────────────────────────────────────────────────

/**
 * Classify an `inputPath` for a `read` tool call. Returns null when the
 * path is safe, or a {@link FilesystemMatch} describing why the gate
 * should prompt.
 *
 * Deny-then-allow-back: if `read.deny.*` matches AND `read.allow.*`
 * also matches, the path is allowed back through (returns null). The
 * deny-match is still examined so `read.allow` only "carves a hole"
 * inside an existing deny - it can't widen the gate to outside-deny
 * paths (which were already not gated to begin with).
 */
export function classifyRead(inputPath: string, cwd: string, policy: FilesystemPolicy): FilesystemMatch | null {
  const absolute = resolve(cwd, expandTilde(inputPath));
  const denied = matchRules(absolute, policy.read.deny, cwd);
  if (!denied) return null;
  const allowed = matchRules(absolute, policy.read.allow, cwd);
  if (allowed) return null;
  return denied;
}

/**
 * Classify an `inputPath` for a `write` / `edit` tool call. Returns
 * null when the path is safe.
 *
 * Allow-only with carve-back:
 *   1. The path must be inside at least one `write.allow.paths` prefix
 *      (the outer gate) or we return `outside-allowed-write`.
 *   2. After the gate, walk `write.deny` ∪ `read.deny` (anything
 *      read-sensitive is trivially write-sensitive). A match is a
 *      gate, UNLESS
 *   3. `write.allow.basenames` or `write.allow.segments` also matches,
 *      which carves the path back through (returns null). Mirrors
 *      `read.allow` for reads.
 *
 * `write.allow.paths` is intentionally NOT a carve-back source - it's
 * the outer gate. Otherwise the default `'.'` (cwd) would shadow every
 * `write.deny.*` rule under the workspace. To carve out a sub-path of
 * a denied dir, use `write.allow.segments` (`node_modules/.vite-temp`)
 * or `write.allow.basenames`.
 */
export function classifyWrite(inputPath: string, cwd: string, policy: FilesystemPolicy): FilesystemMatch | null {
  const absolute = resolve(cwd, expandTilde(inputPath));

  // Allow-only check: must be inside at least one `write.allow.paths`.
  let insideAllowed = false;
  for (const raw of policy.write.allow.paths) {
    if (isUnderPath(absolute, resolveRulePath(raw, cwd))) {
      insideAllowed = true;
      break;
    }
  }
  if (!insideAllowed) {
    return {
      reason: 'outside-allowed-write',
      detail: `Outside allowed write roots (${policy.write.allow.paths.join(', ') || '<none>'})`,
    };
  }

  // Carve-back rule set: only basenames + segments. Paths are reserved
  // for the outer gate above (see the function's docstring for why).
  const carveBack: FilesystemRules = {
    basenames: policy.write.allow.basenames,
    segments: policy.write.allow.segments,
    paths: [],
  };
  const carved = (): boolean => matchRules(absolute, carveBack, cwd) !== null;

  // Deny-within-allow check: write.deny first (more specific reason),
  // then read.deny (read-sensitive ⊆ write-sensitive). Either deny is
  // overridden by a carve-back match.
  const writeDenied = matchRules(absolute, policy.write.deny, cwd);
  if (writeDenied && !carved()) return writeDenied;
  const readDenied = matchRules(absolute, policy.read.deny, cwd);
  if (readDenied && !carved()) return readDenied;
  return null;
}
