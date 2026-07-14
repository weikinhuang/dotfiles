/**
 * Ensure ASRT's sandbox `TMPDIR` exists on the host before a wrap.
 *
 * `@anthropic-ai/sandbox-runtime` unconditionally sets `TMPDIR` inside
 * every sandboxed child to `$CLAUDE_CODE_TMPDIR || $CLAUDE_TMPDIR ||
 * '/tmp/claude'` whenever a filesystem policy is active (see
 * `sandbox-utils.js::generateProxyEnvVars`, gated on `!skipTmpdir`).
 * That directory is also part of `getDefaultWritePaths()`, so ASRT
 * *would* bind it writable into the sandbox - but its Linux binder
 * SKIPS any write-allow path that does not exist on the host
 * (`linux-sandbox-utils.js`: "Skipping non-existent write path").
 *
 * ASRT never creates the directory itself; it assumes the host
 * already has one (Claude Code creates it). pi's sandbox extension
 * did not, so on a fresh box `/tmp/claude` is absent, never bound, and
 * any sandboxed process that writes to `$TMPDIR` fails with
 * `No such file or directory`. The classic cascade is
 * `mktemp` -> empty output -> `curl -o` (badly used) inside tools like
 * `ai-fetch-web`.
 *
 * The fix is to `mkdir -p` the resolved tmpdir on the host before each
 * wrap, mirroring the dangerous-file-stub pre-creation in the same
 * hook. Cheap + idempotent, and re-running per wrap survives a system
 * tmp-reaper deleting it mid-session.
 *
 * FUTURE: this is a workaround for an ASRT gap. If a future ASRT
 * release creates the host tmpdir itself (watch
 * `sandbox-utils.js::generateProxyEnvVars` + the Linux binder's
 * "Skipping non-existent write path" branch), this helper and its
 * `performWrap` call site can be deleted. Until then it must stay:
 * without it, any sandboxed `mktemp`/temp-file write on a host that
 * lacks `/tmp/claude` breaks.
 *
 * Pure module - `node:fs` only, no pi / third-party runtime import.
 */

import { mkdirSync } from 'node:fs';

/**
 * Resolve the tmpdir ASRT will set inside the sandbox. Mirrors ASRT's
 * own `CLAUDE_CODE_TMPDIR || CLAUDE_TMPDIR || '/tmp/claude'` precedence
 * (empty-string values fall through, matching its `||` chain).
 */
export function resolveAsrtTmpdir(env: NodeJS.ProcessEnv = process.env): string {
  // Truthiness (not `??`) so empty-string values fall through, exactly
  // matching ASRT's own `A || B || '/tmp/claude'` precedence chain.
  if (env.CLAUDE_CODE_TMPDIR) return env.CLAUDE_CODE_TMPDIR;
  if (env.CLAUDE_TMPDIR) return env.CLAUDE_TMPDIR;
  return '/tmp/claude';
}

/**
 * Create the resolved ASRT tmpdir on the host if it is missing.
 * Best-effort and never-throwing: a failure here just leaves the
 * pre-existing (broken) behaviour rather than breaking the wrap, and
 * the caller still runs the command. Returns the resolved path.
 *
 * Mode `0o700` matches a private per-user tmpdir; `recursive: true`
 * makes it a no-op when the directory already exists.
 */
export function ensureAsrtTmpdir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveAsrtTmpdir(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Best-effort: leave ASRT's default behaviour untouched on error.
  }
  return dir;
}
