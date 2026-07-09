/**
 * Filesystem layout + sweep helpers for the subagent extension.
 *
 * Pure module - no pi imports - so it can be unit-tested under `vitest`.
 *
 * Layout (mirrors Claude Code's
 * `~/.claude/projects/<cwd-slug>/<parentSid>/subagents/agent-<aid>.jsonl`):
 *
 *   <base>/<parent-session-id>/subagents/
 *     <iso-timestamp>_<child-session-id>.jsonl
 *
 * `<base>` defaults to the parent session's *effective* session dir
 * (`sessionManager.getSessionDir()`), so child transcripts sit right
 * alongside the parent's own `<ts>_<sid>.jsonl` and automatically follow
 * `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` (the base moves, the
 * `<parentSid>/subagents/` layout beneath stays the same). For an ordinary
 * default run that base is `<agentDir>/sessions/<cwd-slug>/`, so the
 * on-disk path is identical to the historical layout. Setting
 * `PI_SUBAGENT_SESSION_ROOT` instead points the base at an explicit root
 * bucketed by the workspace slug (ramdisk / shared store), and
 * `PI_SUBAGENT_SESSION_SLUG` pins that slug so the tree survives a
 * workspace rename/move. See
 * [`config/pi/extensions/AGENTS.md`](../../../config/pi/extensions/AGENTS.md).
 *
 * Retention: {@link sweepStaleSessionsFlat} deletes child session files
 * older than `retainDays` under one workspace's base;
 * {@link sweepStaleSessions} does the same globally under the shared
 * sessions root. Invoked from `session_start` (catches pre-crash
 * leftovers) and `session_shutdown` (the happy path).
 */

import { join } from 'node:path';

import { piAgentPath, slugFromEnv } from '../pi-paths.ts';

export const SUBAGENT_SESSION_DIRNAME = 'subagents';

/**
 * Default root for the explicit-root branch. Honours
 * `PI_SUBAGENT_SESSION_ROOT`, else `piAgentPath('sessions')` (which honours
 * `PI_CODING_AGENT_DIR`). Only used by the global sweep +
 * `subagentSessionBase`'s env-root branch - the default child base is the
 * parent session dir (`getSessionDir()`), not this.
 */
export function subagentSessionRoot(): string {
  const env = process.env.PI_SUBAGENT_SESSION_ROOT;
  if (env && env.trim().length > 0) return env.trim();
  return piAgentPath('sessions');
}

/**
 * The slug segment used to bucket child transcripts under an explicit
 * `PI_SUBAGENT_SESSION_ROOT`. Honours `PI_SUBAGENT_SESSION_SLUG` (trimmed,
 * when non-empty) as a fixed, cwd-independent override so the tree
 * survives a parent workspace rename/move; otherwise falls back to the
 * parent cwd slug. Only consulted for the env-root branch - the default
 * base is the parent session dir, which already encodes the slug (or the
 * verbatim `--session-dir`). Pure - reads only `process.env` and the cwd.
 */
export function subagentSessionSlug(parentCwd: string): string {
  return slugFromEnv(process.env.PI_SUBAGENT_SESSION_SLUG, parentCwd);
}

export interface ChildSessionDirArgs {
  /**
   * The parent session's *effective* session dir
   * (`sessionManager.getSessionDir()`). Child transcripts nest under this
   * by default, so they follow `--session-dir` /
   * `PI_CODING_AGENT_SESSION_DIR` automatically (base moves, layout stays).
   */
  parentSessionDir: string;
  /** Absolute path to the parent session's cwd (env-root slug bucket). */
  parentCwd: string;
  /** Parent session id as reported by pi's SessionManager. */
  parentSessionId: string;
}

/**
 * The per-workspace base dir that child `<parentSid>/subagents/` trees
 * nest under. By default this IS the parent's effective session dir, so
 * the base moves with `--session-dir` while the layout beneath stays the
 * same. `PI_SUBAGENT_SESSION_ROOT` overrides it with an explicit root
 * bucketed by the workspace slug (for a ramdisk / shared store);
 * `PI_SUBAGENT_SESSION_SLUG` pins that slug. Pure.
 */
export function subagentSessionBase(parentSessionDir: string, parentCwd: string): string {
  const envRoot = process.env.PI_SUBAGENT_SESSION_ROOT?.trim();
  if (envRoot && envRoot.length > 0) return join(envRoot, subagentSessionSlug(parentCwd));
  return parentSessionDir;
}

/**
 * Directory where child `<timestamp>_<sid>.jsonl` files land. Matches
 * pi's own naming convention so `SessionManager.list` works on the
 * subfolder without tweaks.
 */
export function childSessionDir(args: ChildSessionDirArgs): string {
  return join(
    subagentSessionBase(args.parentSessionDir, args.parentCwd),
    args.parentSessionId,
    SUBAGENT_SESSION_DIRNAME,
  );
}

export const STALE_WORKTREE_PREFIX = 'pi-subagent-';

/** Days → ms, with a hard floor of 0 (never negative). */
export function retainMs(days: number): number {
  const d = Number.isFinite(days) && days > 0 ? days : 0;
  return d * 24 * 60 * 60 * 1000;
}

export interface SweepFs {
  readdir: (path: string) => string[] | null;
  stat: (path: string) => { mtimeMs: number; isFile: boolean; isDirectory: boolean } | null;
  remove: (path: string) => boolean;
}

export interface SweepResult {
  scanned: number;
  removed: number;
  errors: { path: string; reason: string }[];
}

/**
 * Walk `<base>/*\/subagents/*.jsonl` (depth-1: one `<parent-session-id>`
 * level under `base`, then the fixed `subagents/` dir) and remove files
 * older than `retainDays`. This is the shape child transcripts take under
 * a single workspace's session dir, so pass `sessionManager.getSessionDir()`
 * to sweep the current workspace regardless of where `--session-dir` put
 * it. Only ever deletes `*.jsonl` inside a `subagents/` dir - pi's own
 * `<ts>_<sid>.jsonl` transcripts sitting directly in `base` are files, not
 * dirs, so they are never touched. Injected fs so tests drive it with
 * in-memory data; directory errors are silent (best-effort).
 */
export function sweepStaleSessionsFlat(base: string, retainDays: number, fs: SweepFs): SweepResult {
  const out: SweepResult = { scanned: 0, removed: 0, errors: [] };
  const maxAgeMs = retainMs(retainDays);
  if (maxAgeMs <= 0) return out;
  const cutoff = Date.now() - maxAgeMs;

  const sessionDirs = fs.readdir(base);
  if (!sessionDirs) return out;

  for (const sid of sessionDirs) {
    const subagents = join(base, sid, SUBAGENT_SESSION_DIRNAME);
    const sst = fs.stat(subagents);
    if (!sst?.isDirectory) continue;
    const files = fs.readdir(subagents) ?? [];
    for (const fname of files) {
      if (!fname.endsWith('.jsonl')) continue;
      const full = join(subagents, fname);
      const fst = fs.stat(full);
      if (!fst?.isFile) continue;
      out.scanned++;
      if (fst.mtimeMs >= cutoff) continue;
      const ok = fs.remove(full);
      if (ok) out.removed++;
      else out.errors.push({ path: full, reason: 'remove-failed' });
    }
  }
  return out;
}

/**
 * Walk `<root>/*\/*\/subagents/*.jsonl` and remove files older than
 * `retainDays`. This is the global, all-workspaces shape under the shared
 * sessions root (`<root>/<workspace-slug>/<parent-session-id>/subagents/`),
 * used to reap leftovers from OTHER workspaces + the
 * `PI_SUBAGENT_SESSION_ROOT` bucket. For the current workspace's own
 * (possibly `--session-dir`-relocated) tree, use {@link sweepStaleSessionsFlat}.
 *
 * Directory errors (missing root, unreadable parent) are silent - the
 * sweep is best-effort and must never block a session from starting.
 */
export function sweepStaleSessions(root: string, retainDays: number, fs: SweepFs): SweepResult {
  const out: SweepResult = { scanned: 0, removed: 0, errors: [] };
  const projectDirs = fs.readdir(root);
  if (!projectDirs) return out;

  for (const projName of projectDirs) {
    const projDir = join(root, projName);
    const projStat = fs.stat(projDir);
    if (!projStat?.isDirectory) continue;
    // Each project dir has the same `<sid>/subagents/*.jsonl` shape the
    // flat sweep handles, so reuse it and fold the counts.
    const sub = sweepStaleSessionsFlat(projDir, retainDays, fs);
    out.scanned += sub.scanned;
    out.removed += sub.removed;
    for (const e of sub.errors) out.errors.push(e);
  }
  return out;
}

/**
 * Parse `git worktree list --porcelain` output and return the checkout
 * path of every linked worktree whose branch name starts with
 * {@link STALE_WORKTREE_PREFIX} - i.e. the throwaway checkouts a crashed
 * parent leaked (see `worktree.ts::createWorktree`, which names each
 * branch `pi-subagent-*`).
 *
 * Why porcelain instead of scanning `.git/worktrees/`: `git worktree add`
 * names the *admin* dir under `.git/worktrees/` after the checkout's last
 * path segment (`checkout`), NOT after the `pi-subagent-*` branch, so the
 * old admin-dir scan matched nothing. And `git worktree remove` needs the
 * *checkout* path (under `$TMPDIR`), which only the porcelain listing (or
 * the admin `gitdir` file) exposes. This parser returns exactly those
 * checkout paths so the caller can `git worktree remove --force <path>`.
 *
 * Porcelain blocks are separated by blank lines; each opens with a
 * `worktree <abs-path>` line and (for a non-detached checkout) carries a
 * `branch refs/heads/<name>` line. Detached / bare entries (no branch)
 * are skipped. Pure - no fs, no subprocess.
 */
export function parseStaleWorktreePaths(porcelain: string): string[] {
  const out: string[] = [];
  let path: string | null = null;
  let branch: string | null = null;

  const flush = (): void => {
    if (path !== null && branch !== null) {
      const name = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
      if (name.startsWith(STALE_WORKTREE_PREFIX)) out.push(path);
    }
    path = null;
    branch = null;
  };

  for (const line of porcelain.split('\n')) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      // A new block started without a blank separator - flush the prior.
      flush();
      path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim();
    }
  }
  flush();
  return out;
}
