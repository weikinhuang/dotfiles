/**
 * Resolve the on-disk directory where a `runOneShotAgent` child
 * session should record its `<timestamp>_<sid>.jsonl` transcript.
 *
 * Pure module - no pi imports - so it can be unit-tested under
 * `vitest`. The pi-coupled glue (`SessionManager.create(cwd, dir)`)
 * stays in the calling extension; this helper owns only the path
 * convention + the precondition check.
 *
 * Convention (mirrors Claude Code's
 * `~/.claude/projects/<cwd-slug>/<parentSid>/subagents/agent-<aid>.jsonl`
 * layout - see [`config/pi/extensions/AGENTS.md`](../../../config/pi/extensions/AGENTS.md)):
 *
 *     <parentSessionDir>/<parentSessionId>/subagents/
 *
 * where `<parentSessionDir>` is the project-level directory that
 * also holds `<parentSessionId>.jsonl`. Walked by
 * [`config/pi/session-usage.ts`](../../../config/pi/session-usage.ts)
 * (and the matching helper in
 * [`subagent-session-paths.ts`](./subagent-session-paths.ts)) to
 * attribute child-session usage + cost back to the parent pi
 * session.
 *
 * Why this exists: the default `sessionManager` on
 * [`runOneShotAgent`](./subagent-spawn.ts) is `SessionManager.inMemory(cwd)`,
 * so any extension that omits the field silently drops the child's
 * transcript on the floor - breaking both cost/audit attribution
 * (`pi session-usage` / `ai-tool-usage` see no evidence the run
 * happened) and forensic debuggability when a fanout child errors.
 * Every `runOneShotAgent` call site MUST resolve its session
 * directory through this helper and wrap the result with
 * `SessionManager.create(...)` instead of accepting the in-memory
 * default.
 */

import { join } from 'node:path';

/**
 * Subset of pi's `SessionManager` we need to derive the child
 * session dir. Both methods may throw or return empty when the
 * parent session is in-memory (e.g. `pi -p --no-session` or a test
 * harness that didn't wire a session) - this helper turns either
 * failure mode into a single, descriptive `Error`.
 */
export interface ParentSessionManagerLike {
  getSessionId(): string | undefined;
  getSessionDir(): string | undefined;
}

export interface ResolveSubagentSessionDirArgs {
  /** The parent extension's `ctx.sessionManager`. */
  parentSessionManager: ParentSessionManagerLike;
  /**
   * Extension label used in error messages (e.g. `"deep-research"`,
   * `"iteration-loop"`). Surfaces in the thrown message so the user
   * knows which extension refused to start.
   */
  extensionLabel: string;
}

/**
 * Returns the directory `<parentSessionDir>/<parentSessionId>/subagents`.
 *
 * Throws when the parent session has no id or no dir - see the
 * module docstring for the rationale (we refuse to silently fall
 * back to an in-memory session manager). Callers that genuinely
 * need an ephemeral run should surface the precondition to the
 * user instead of swallowing it.
 */
export function resolveSubagentSessionDir(args: ResolveSubagentSessionDirArgs): string {
  const { parentSessionManager, extensionLabel } = args;

  let parentId: string | undefined;
  let parentDir: string | undefined;
  try {
    parentId = parentSessionManager.getSessionId();
    parentDir = parentSessionManager.getSessionDir();
  } catch (e) {
    throw new Error(
      `${extensionLabel}: cannot persist subagent session - parent sessionManager threw while reading id/dir (${(e as Error).message}). ` +
        'Restart pi without --no-session (or set --session-dir) so subagent transcripts can be recorded for cost + audit tracking.',
    );
  }

  if (!parentId || !parentDir) {
    throw new Error(
      `${extensionLabel}: cannot persist subagent session - parent session has no id/dir (running pi with --no-session?). ` +
        'Restart pi without --no-session (or set --session-dir) so subagent transcripts are recorded for cost + audit tracking. ' +
        `${extensionLabel} refuses to run against an untracked parent session because every spawn would silently drop its transcript.`,
    );
  }

  return join(parentDir, parentId, 'subagents');
}
