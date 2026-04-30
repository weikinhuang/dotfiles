/**
 * Pure helpers for config/pi/extensions/statusline.ts.
 *
 * Re-uses the dotfiles-vendored `external/git-prompt.sh` (the same script
 * that powers `PS1` and `config/claude/statusline-command.sh`) so the pi
 * footer shows the same branch decorations as the interactive prompt:
 * dirty (`*`), staged (`+`), stash (`$`), untracked (`%`), and upstream
 * arrows. When the helper isn't available (or spawning bash fails) the
 * caller falls back to pi's `footerData.getGitBranch()`.
 *
 * This module imports only from `node:*` so it stays unit-testable under
 * plain `node --test` with no pi runtime.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Path relative to the dotfiles root where git-prompt.sh lives. */
export const GIT_PROMPT_FILENAME = 'external/git-prompt.sh';

/**
 * How long a cached `__git_ps1` result stays fresh. Kept deliberately short
 * because dirty/untracked/stash flags change whenever the working tree
 * changes and we have no fs watcher for the workdir — only a git HEAD
 * watcher via `footerData.onBranchChange` that invalidates the cache.
 */
export const GIT_SEGMENT_TTL_MS = 5_000;

/** Hard cap on how long bash is allowed to run `__git_ps1`. */
export const GIT_SEGMENT_TIMEOUT_MS = 2_000;

/** execFile maxBuffer. `__git_ps1` output is tiny; this is pure paranoia. */
export const GIT_SEGMENT_MAX_BUFFER = 16 * 1024;

/**
 * Walk upward from `startDir` looking for `external/git-prompt.sh`.
 *
 *  1. Honors `$DOTFILES_ROOT` (same override as `statusline-command.sh`).
 *  2. Otherwise resolves symlinks once (so `~/.dotfiles` → real repo) and
 *     walks parents up to {@link maxDepth} levels.
 *
 * Returns the absolute script path, or `null` when no candidate exists.
 */
export function resolveGitPromptScript(startDir: string, maxDepth = 16): string | null {
  const envRoot = process.env.DOTFILES_ROOT;
  if (envRoot) {
    const p = join(envRoot, GIT_PROMPT_FILENAME);
    if (existsSync(p)) return p;
  }

  let dir: string;
  try {
    dir = realpathSync(startDir);
  } catch {
    dir = startDir;
  }

  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, GIT_PROMPT_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface GitSegmentCacheEntry {
  /** Last value produced by `__git_ps1`, or '' when the fetch failed/empty. */
  value: string;
  /** `Date.now()` at which {@link value} was captured. 0 ⇒ never fetched. */
  ts: number;
  /** Guards against concurrent fetches for the same cwd. */
  inFlight: boolean;
}

export interface FetchGitSegmentOptions {
  /** Absolute path to `external/git-prompt.sh`. */
  scriptPath: string;
  /** Working directory to evaluate `__git_ps1` in. */
  cwd: string;
  /** Override the default bash timeout. */
  timeoutMs?: number;
  /** Override the default execFile maxBuffer. */
  maxBuffer?: number;
  /** Notified when bash/exec itself errors out (timeout, ENOENT, …). */
  onError?: (err: Error) => void;
}

/**
 * Spawn `bash -c 'source <script> && __git_ps1 " (%s)"'` with the same
 * `GIT_PS1_SHOW*` flags as `config/claude/statusline-command.sh`. Resolves
 * to the trimmed segment (leading space + `(branch…)` when non-empty), or
 * `''` on any failure.
 *
 * `LC_ALL=C` is set so symbols and upstream arrows don't get translated
 * by a non-English locale.
 */
export function fetchGitSegmentAsync(options: FetchGitSegmentOptions): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', 'source "$GIT_PROMPT_SCRIPT" && __git_ps1 " (%s)"'],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_PROMPT_SCRIPT: options.scriptPath,
          GIT_PS1_SHOWDIRTYSTATE: 'true',
          GIT_PS1_SHOWSTASHSTATE: 'true',
          GIT_PS1_SHOWUNTRACKEDFILES: 'true',
          GIT_PS1_SHOWUPSTREAM: 'auto',
          LC_ALL: 'C',
        },
        timeout: options.timeoutMs ?? GIT_SEGMENT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? GIT_SEGMENT_MAX_BUFFER,
        encoding: 'utf8',
      },
      (err, stdout) => {
        if (err) {
          options.onError?.(err);
          resolve('');
          return;
        }
        // __git_ps1 uses printf with a leading space (" (%s)"), so the
        // segment we want preserves that single leading space and has any
        // line terminators / tabs collapsed out. We intentionally do NOT
        // .trim() — trimming would drop the leading space and visually
        // glue the branch to the preceding cwd.
        const raw = (stdout ?? '').toString();
        const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+$/, '');
        resolve(cleaned);
      },
    );
  });
}
