/**
 * Pure command-path resolution for the `hooks` extension.
 *
 * A hook entry's `command` may be an absolute path, a `~`-prefixed
 * path, a relative path (`./scripts/my-hook.sh`), or a bare command
 * name resolved on `PATH`. The resolution is pure once the home
 * directory is injected, so it lives here rather than in the shell:
 * the shell passes `os.homedir()` in and gets the resolved string
 * back.
 *
 * NOTE: this keeps its own `~/` expansion rather than reusing
 * `../path-expand.ts`. The two are NOT byte-identical: this one runs
 * the `~/…` tail through `resolve(homedir, tail)` (normalizing `.` /
 * `..` / duplicate separators), whereas `path-expand.ts` does a
 * literal `homedir + path.slice(1)` splice. Swapping would change the
 * resolved string for edge-case inputs, so the swap is deferred to
 * keep behavior identical.
 */

import { isAbsolute, resolve } from 'node:path';

/** Expand a leading `~` / `~/` in `command` against `homedir`. */
function expandTilde(command: string, homedir: string): string {
  if (command === '~') return homedir;
  if (command.startsWith('~/')) return resolve(homedir, command.slice(2));
  return command;
}

/**
 * Resolve a hook's `command` against `cwd`. Absolute and `~`-prefixed
 * paths are honoured; a path with a separator is resolved relative to
 * `cwd` (so `./scripts/my-hook.sh` works); a bare command (no `/`) is
 * passed through unchanged for the shell to look up on `PATH`.
 */
export function resolveCommand(command: string, cwd: string, homedir: string): string {
  const expanded = expandTilde(command, homedir);
  if (isAbsolute(expanded)) return expanded;
  // Heuristic: if the entry has a path separator, resolve it relative
  // to cwd so `./scripts/my-hook.sh` works. Bare commands (no `/`)
  // are passed through unchanged - the shell finds them on PATH.
  if (expanded.includes('/')) return resolve(cwd, expanded);
  return expanded;
}
