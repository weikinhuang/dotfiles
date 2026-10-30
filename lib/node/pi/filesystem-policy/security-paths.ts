/** Non-overridable write protection for the policy files that control model access. */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { piAgentDir, piProjectPath } from '../pi-paths.ts';

export interface SecurityPathsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit agent directory for callers with an already resolved layout. */
  agentDir?: string;
}

/**
 * Resolve symlinks even when the final file (or several parents) is absent.
 * Do not cache: a trusted host-side config edit can change the symlink target.
 * The depth limit also bounds dangling/cyclic symlink resolution.
 */
function canonicalPath(path: string, depth = 0): string {
  if (depth > 64) return path;
  try {
    return realpathSync(path);
  } catch {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return canonicalPath(resolve(dirname(path), readlinkSync(path)), depth + 1);
      }
    } catch {
      // Missing tail: canonicalize the nearest existing parent instead.
    }
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent, depth + 1), basename(path));
  }
}

/** Lexical and physical spellings of a concrete name, never glob patterns. */
export function pathSpellings(path: string): string[] {
  const lexical = resolve(path);
  return [...new Set([lexical, canonicalPath(lexical)])];
}

/** Both user and project policies remain protected even before they exist. */
export function securityPolicyPaths(cwd: string, options: SecurityPathsOptions = {}): string[] {
  const agentDir = options.agentDir ?? piAgentDir(options.env ?? process.env, options.homeDir ?? homedir());
  const paths = new Set<string>();
  for (const name of ['sandbox.json', 'filesystem.json', 'bash-permissions.json']) {
    for (const path of [join(agentDir, name), piProjectPath(cwd, name)]) {
      for (const spelling of pathSpellings(path)) paths.add(spelling);
    }
  }
  return [...paths];
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Match direct writes, descendants, and replacement of a policy's ancestors.
 * Sibling session/state files are not ancestors and remain writable. This is
 * path-based protection, not inode/hard-link tracking or a race-free FS API.
 */
export function protectedSecurityPolicyPath(
  absolutePath: string,
  cwd: string,
  options: SecurityPathsOptions = {},
): string | undefined {
  const spellings = pathSpellings(absolutePath);
  return securityPolicyPaths(cwd, options).find((policy) =>
    spellings.some((path) => isAtOrBelow(path, policy) || isAtOrBelow(policy, path)),
  );
}
