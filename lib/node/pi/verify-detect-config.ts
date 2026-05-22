/**
 * Config loader for `verify-before-claim`'s `commandSatisfies` rules.
 *
 * Split out of `verify-detect.ts` so the (rather large) claim-detection
 * core stays focused on regex matching + branch traversal, and the
 * disk-touching config loader can be reasoned about - and tested -
 * independently. `verify-detect.ts` re-exports the public names here so
 * existing call sites keep working without touching their imports.
 */

import { join } from 'node:path';

import { type ConfigWarning, tryReadJsoncFile } from './jsonc.ts';
import { piAgentDir } from './pi-paths.ts';
import type { ClaimKind } from './verify-detect.ts';

const VALID_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>([
  'tests-pass',
  'lint-clean',
  'types-check',
  'build-clean',
  'format-clean',
  'ci-green',
]);

/** User-facing rule shape - the raw JSONC entry. */
export interface CommandSatisfiesRule {
  pattern: string;
  kinds: ClaimKind[];
}

/** Compiled form passed into `partitionClaims` / `verifyingCommandMatches`. */
export interface CompiledSatisfyRule {
  re: RegExp;
  kinds: Set<ClaimKind>;
  /** The source config file path (for diagnostics). */
  source: string;
}

/**
 * Read `verify-before-claim.json` from global + project locations and
 * return compiled `commandSatisfies` rules plus any load / parse
 * warnings. Missing files are silent; malformed JSON, unknown claim
 * kinds, and bad regexes produce structured warnings.
 *
 * The caller (the extension) surfaces warnings via `ctx.ui.notify`.
 */
export function loadSatisfyRules(
  cwd: string,
  agentDir: string = piAgentDir(),
): { rules: CompiledSatisfyRule[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const rules: CompiledSatisfyRule[] = [];
  const paths = [join(agentDir, 'verify-before-claim.json'), join(cwd, '.pi', 'verify-before-claim.json')];

  for (const path of paths) {
    const parsed = tryReadJsoncFile(path, warnings, { requireObject: true });
    if (parsed === undefined) continue;
    const { commandSatisfies } = parsed as { commandSatisfies?: unknown };
    if (commandSatisfies === undefined) continue;
    if (!Array.isArray(commandSatisfies)) {
      warnings.push({ path, error: '`commandSatisfies` must be an array' });
      continue;
    }
    for (const entry of commandSatisfies) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.pattern !== 'string' || e.pattern.length === 0) {
        warnings.push({ path, error: 'rule is missing a non-empty `pattern`' });
        continue;
      }
      if (!Array.isArray(e.kinds) || e.kinds.length === 0) {
        warnings.push({ path, error: `rule "${e.pattern}" is missing a non-empty \`kinds\` array` });
        continue;
      }
      const kinds = new Set<ClaimKind>();
      let ruleOk = true;
      for (const k of e.kinds) {
        if (typeof k !== 'string' || !VALID_KINDS.has(k as ClaimKind)) {
          warnings.push({
            path,
            error: `rule "${e.pattern}" has unknown kind ${JSON.stringify(k)} (allowed: ${Array.from(VALID_KINDS).join(', ')})`,
          });
          ruleOk = false;
          continue;
        }
        kinds.add(k as ClaimKind);
      }
      if (!ruleOk || kinds.size === 0) continue;
      let re: RegExp;
      try {
        re = new RegExp(e.pattern);
      } catch (err) {
        warnings.push({ path, error: `rule "${e.pattern}" has invalid regex: ${String(err)}` });
        continue;
      }
      rules.push({ re, kinds, source: path });
    }
  }
  return { rules, warnings };
}
