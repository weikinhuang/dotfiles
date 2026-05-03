/**
 * Filesystem layout + sweep helpers for the subagent extension.
 *
 * Pure module — no pi imports — so it can be unit-tested under `vitest`.
 *
 * Layout:
 *
 *   <root>/<parent-cwd-slug>/subagents/<parent-session-id>/
 *     <iso-timestamp>_<child-session-id>.jsonl
 *
 * Anchoring on `<parent-cwd-slug>` (not the throwaway worktree path for
 * `isolation: "worktree"` children) keeps the transcript alongside the
 * parent's own sessions in `~/.pi/agent/sessions/<slug>/`, so
 * `session-usage.ts`-style tools see related artefacts as a unit.
 *
 * Retention: `sweepStaleSessions` deletes child session files older than
 * `retainDays`. Invoked from `session_start` (catches pre-crash leftovers)
 * and `session_shutdown` (the happy path).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { cwdSlug } from './memory-paths.ts';

export const SUBAGENT_SESSION_DIRNAME = 'subagents';

/** Default root for child sessions. Honours `PI_SUBAGENT_SESSION_ROOT`. */
export function subagentSessionRoot(): string {
  const env = process.env.PI_SUBAGENT_SESSION_ROOT;
  if (env && env.trim().length > 0) return env.trim();
  return join(homedir(), '.pi', 'agent', 'sessions');
}

export interface ChildSessionDirArgs {
  /** Absolute path to the parent session's cwd. */
  parentCwd: string;
  /** Parent session id as reported by pi's SessionManager. */
  parentSessionId: string;
  /** Root override (defaults to {@link subagentSessionRoot}). */
  root?: string;
}

/**
 * Directory where child `<timestamp>_<sid>.jsonl` files land. Matches
 * pi's own naming convention so `SessionManager.list` works on the
 * subfolder without tweaks.
 */
export function childSessionDir(args: ChildSessionDirArgs): string {
  const root = args.root ?? subagentSessionRoot();
  return join(root, cwdSlug(args.parentCwd), SUBAGENT_SESSION_DIRNAME, args.parentSessionId);
}

/**
 * Directory pattern where stale `pi-subagent-*` worktrees accumulate on
 * crash. Rendered relative to the parent cwd's `.git/worktrees/` so the
 * caller can invoke `git worktree remove` or plain `rm -rf` on each.
 */
export function staleWorktreeDir(cwd: string): string {
  return join(cwd, '.git', 'worktrees');
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
 * Walk `<root>/*\/subagents/*\/*.jsonl` and remove files older than
 * `retainDays`. Injected fs so tests drive the whole thing with
 * in-memory data.
 *
 * Directory errors (missing root, unreadable parent) are silent — the
 * sweep is best-effort and must never block a session from starting.
 */
export function sweepStaleSessions(root: string, retainDays: number, fs: SweepFs): SweepResult {
  const out: SweepResult = { scanned: 0, removed: 0, errors: [] };
  const maxAgeMs = retainMs(retainDays);
  if (maxAgeMs <= 0) return out;
  const cutoff = Date.now() - maxAgeMs;

  const projectDirs = fs.readdir(root);
  if (!projectDirs) return out;

  for (const projName of projectDirs) {
    const subagents = join(root, projName, SUBAGENT_SESSION_DIRNAME);
    const st = fs.stat(subagents);
    if (!st?.isDirectory) continue;
    const sessionDirs = fs.readdir(subagents) ?? [];
    for (const sid of sessionDirs) {
      const sessionDir = join(subagents, sid);
      const sst = fs.stat(sessionDir);
      if (!sst?.isDirectory) continue;
      const files = fs.readdir(sessionDir) ?? [];
      for (const fname of files) {
        if (!fname.endsWith('.jsonl')) continue;
        const full = join(sessionDir, fname);
        const fst = fs.stat(full);
        if (!fst?.isFile) continue;
        out.scanned++;
        if (fst.mtimeMs >= cutoff) continue;
        const ok = fs.remove(full);
        if (ok) out.removed++;
        else out.errors.push({ path: full, reason: 'remove-failed' });
      }
    }
  }
  return out;
}

/**
 * Identify stale worktrees the parent crashed out of. Returns the
 * absolute path of every directory under `.git/worktrees/` whose name
 * starts with {@link STALE_WORKTREE_PREFIX}. The caller shells out to
 * `git worktree remove --force <path>` for each.
 */
export function listStaleWorktrees(cwd: string, fs: Pick<SweepFs, 'readdir' | 'stat'>): string[] {
  const dir = staleWorktreeDir(cwd);
  const entries = fs.readdir(dir);
  if (!entries) return [];
  const out: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(STALE_WORKTREE_PREFIX)) continue;
    const full = join(dir, name);
    const st = fs.stat(full);
    if (!st?.isDirectory) continue;
    out.push(full);
  }
  return out;
}
