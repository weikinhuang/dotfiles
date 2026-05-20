/**
 * Classification helpers for the unified `~/.pi/filesystem.json` policy.
 *
 * Absorbs (and supersedes) the path-matching helpers from
 * `lib/node/pi/paths.ts`, which `protected-paths.ts` consumes today and
 * is deleted in Phase 3 of the sandbox-runtime extension rollout.
 *
 * Read uses deny-then-allow-back semantics:
 *   1. If a `read.deny.*` entry matches, gate the path...
 *   2. ...unless a `read.allow.*` entry also matches, which "allows
 *      back" within an otherwise-denied prefix.
 *   3. No outside-workspace check on reads (matches existing
 *      `protected-paths` behavior - reading nearby READMEs and dotfiles
 *      is routine).
 *
 * Write uses allow-only semantics:
 *   1. If the path is NOT under any `write.allow.paths` prefix, gate
 *      with reason `outside-allowed-write`.
 *   2. Otherwise, if any `write.deny.*` entry matches, gate with the
 *      matching `deny-*` reason.
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
 * `~/.pi/filesystem.json` means "the session's cwd at evaluation time"
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
 * Allow-only: if the path is not inside any `write.allow.paths` prefix,
 * gate with reason `outside-allowed-write`. The basenames / segments
 * sub-fields of `write.allow` are NOT used as allow-back overrides for
 * the path-prefix check - they only carry meaning inside the deny set.
 *
 * After the allow gate, walk `write.deny` AND `read.deny` (anything
 * read-sensitive is trivially write-sensitive, matching the existing
 * `protected-paths::classifyWrite` union behavior).
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

  // Deny-within-allow check: read.deny ∪ write.deny.
  const writeDenied = matchRules(absolute, policy.write.deny, cwd);
  if (writeDenied) return writeDenied;
  const readDenied = matchRules(absolute, policy.read.deny, cwd);
  if (readDenied) {
    // Allow-back via read.allow doesn't widen writes - reads-and-writes
    // share read.deny because anything sensitive-to-read is sensitive-
    // to-write, but the allow-back semantics are read-only.
    return readDenied;
  }
  return null;
}
