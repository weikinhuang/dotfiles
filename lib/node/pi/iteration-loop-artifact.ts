/**
 * Artifact-path matching for iteration-loop edit tracking.
 *
 * v1: exact-path match. A declared artifact of `out.svg` matches
 * writes/edits whose target path, normalized against cwd, equals
 * `out.svg`. Anything else (different name, subdir, symlink through a
 * sibling path) is a miss.
 *
 * v1.5 will add glob support (`out-*.svg`, `dist/**\/bundle.js`); the
 * matcher signature is already shaped for that by taking a
 * `declared` string and a `candidate` string — callers shouldn't need
 * to change when we upgrade the implementation.
 *
 * Normalization rules:
 *
 *   - Both inputs are resolved against `cwd` (absolute inputs stay
 *     absolute; relative ones gain cwd).
 *   - `..` and `.` segments are collapsed by `path.resolve`.
 *   - Trailing slashes are stripped.
 *   - Case-sensitive comparison (matches POSIX filesystem semantics;
 *     Windows/case-insensitive FSes are out of scope for v1 — pi's
 *     target platforms are linux/darwin/wsl).
 *
 * No pi imports.
 */

import { isAbsolute, resolve } from 'node:path';

/**
 * Normalize `p` into an absolute, resolved path rooted at `cwd`.
 * Empty/whitespace inputs return `null` so the matcher can reject
 * them without crashing.
 */
export function normalizePath(p: string | undefined | null, cwd: string): string | null {
  if (typeof p !== 'string') return null;
  const trimmed = p.trim();
  if (trimmed.length === 0) return null;
  const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  // Strip a single trailing slash (not the root `/`).
  return abs.length > 1 && abs.endsWith('/') ? abs.slice(0, -1) : abs;
}

/**
 * Does a write/edit against `candidate` affect the declared
 * `artifact`? Both are normalized against `cwd` before comparison.
 *
 * Returns false on any unparseable input (null, undefined, empty
 * string, wrong type) — the caller should treat those as "did not
 * touch the artifact" rather than erroring.
 */
export function artifactMatches(
  artifact: string | undefined | null,
  candidate: string | undefined | null,
  cwd: string,
): boolean {
  const a = normalizePath(artifact, cwd);
  const c = normalizePath(candidate, cwd);
  if (a === null || c === null) return false;
  return a === c;
}

/**
 * Given a list of paths touched by a tool call (write, edit, or
 * multi-file edit), return true iff any of them matches the declared
 * artifact. Convenience wrapper over `artifactMatches` for callers
 * that normalize tool arguments into a path list upstream.
 */
export function anyArtifactMatch(
  artifact: string | undefined | null,
  candidates: readonly (string | undefined | null)[],
  cwd: string,
): boolean {
  const a = normalizePath(artifact, cwd);
  if (a === null) return false;
  for (const c of candidates) {
    const n = normalizePath(c, cwd);
    if (n !== null && n === a) return true;
  }
  return false;
}

/**
 * Extract paths from a tool call's arguments that are likely to be
 * write targets. We care about `write` / `edit` (and their variants
 * in custom extensions). Each tool has its own arg shape; this helper
 * centralizes the duck-typing so the extension's `after_tool_call`
 * handler stays readable.
 *
 * Recognized shapes:
 *   - { path: string }                         // write, edit
 *   - { file_path: string }                    // some alt names
 *   - { files: [{ path: string }, ...] }       // multi-file edits
 *   - { edits: [{ path: string }, ...] }       // some multi-edit tools
 *
 * Unknown shapes return an empty array. This is conservative — we
 * miss-track some exotic tools rather than over-trigger nudges on
 * tools that weren't really edits.
 */
export function extractEditTargets(toolName: string, args: unknown): string[] {
  // Allowlist the tool names we care about. Extension registers this
  // list explicitly so a future rename doesn't silently bypass
  // tracking. Include both snake_case + camelCase variants of common
  // patch tools so a drop-in replacement of `edit` (e.g. pi's
  // built-in `edit`, Claude Code's `str_replace_editor`, Codex's
  // `apply_patch`, notebook-oriented `notebook_edit`) doesn't escape
  // the match.
  const EDIT_TOOLS = new Set([
    'write',
    'edit',
    'multi_edit',
    'multiedit',
    'str_replace_editor',
    'str_replace_based_edit_tool',
    'apply_patch',
    'notebook_edit',
  ]);
  if (!EDIT_TOOLS.has(toolName.toLowerCase())) return [];
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  const seen = new Set<string>();
  const push = (p: unknown): void => {
    if (typeof p === 'string' && p.length > 0 && !seen.has(p)) seen.add(p);
  };
  push(a.path);
  push(a.file_path);
  if (Array.isArray(a.files)) {
    for (const f of a.files) {
      if (f && typeof f === 'object') {
        const maybe = f as { path?: unknown; file_path?: unknown };
        push(maybe.path);
        push(maybe.file_path);
      }
    }
  }
  if (Array.isArray(a.edits)) {
    for (const e of a.edits) {
      if (e && typeof e === 'object') {
        const maybe = e as { path?: unknown; file_path?: unknown };
        push(maybe.path);
        push(maybe.file_path);
      }
    }
  }
  return [...seen];
}
