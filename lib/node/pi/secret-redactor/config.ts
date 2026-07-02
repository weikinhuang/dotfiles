/**
 * Config loader for the `secret-redactor` extension. Reads the global +
 * project `secret-redactor.json` (JSONC), stacks them (project last), and
 * compiles a `RedactorConfig`. Mirrors `verify-detect-config.ts`: missing
 * files are silent; malformed JSON / bad regex / wrong-typed fields push
 * a structured `ConfigWarning` the extension surfaces once.
 */

import { join } from 'node:path';

import { type ConfigWarning, tryReadJsoncFile } from '../jsonc.ts';
import { piAgentDir, piProjectPath } from '../pi-paths.ts';
import type { CompiledRule } from './patterns.ts';
import { DEFAULT_CONFIG, type RedactorConfig } from './redact.ts';

export interface LoadResult {
  config: RedactorConfig;
  warnings: ConfigWarning[];
}

/** Ensure a user-supplied flag string carries the `g` + `d` flags the redactor needs. */
function ensureFlags(flags: string): string {
  let f = flags;
  if (!f.includes('g')) f += 'g';
  if (!f.includes('d')) f += 'd';
  return f;
}

/** Number of capturing groups in `re` (via the empty-alternation trick). */
function countGroups(re: RegExp): number {
  const m = new RegExp(`${re.source}|`).exec('');
  return m ? m.length - 1 : 0;
}

function compileRule(
  entry: Record<string, unknown>,
  path: string,
  warnings: ConfigWarning[],
): CompiledRule | undefined {
  if (typeof entry.pattern !== 'string' || entry.pattern.length === 0) {
    warnings.push({ path, error: 'rule is missing a non-empty `pattern`' });
    return undefined;
  }
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : undefined;
  if (!id) {
    warnings.push({ path, error: `rule "${entry.pattern}" is missing a non-empty \`id\`` });
    return undefined;
  }
  const rawFlags = typeof entry.flags === 'string' ? entry.flags : '';
  if (rawFlags && !/^[gimsuyd]*$/.test(rawFlags)) {
    warnings.push({ path, error: `rule "${id}" has invalid flags "${rawFlags}"` });
    return undefined;
  }
  let re: RegExp;
  try {
    re = new RegExp(entry.pattern, ensureFlags(rawFlags));
  } catch (err) {
    warnings.push({ path, error: `rule "${id}" has invalid regex: ${String(err)}` });
    return undefined;
  }
  // A pattern with a capture group redacts the value (group 1) and gets
  // keyword-style value guards; a group-less pattern is treated like a
  // prefixed token (whole match, trusted anchor).
  const group = countGroups(re) >= 1 ? 1 : 0;
  return { id, re, group, kind: group === 1 ? 'keyword' : 'prefixed' };
}

/**
 * Load + compile the redactor config from global and project locations.
 * Returns the merged config (defaults where unset) and any warnings.
 */
export function loadRedactorConfig(cwd: string, agentDir: string = piAgentDir()): LoadResult {
  const warnings: ConfigWarning[] = [];
  const config: RedactorConfig = {
    layers: { ...DEFAULT_CONFIG.layers },
    customRules: [],
    allowlist: [],
    keywordMinLength: DEFAULT_CONFIG.keywordMinLength,
  };

  const paths = [join(agentDir, 'secret-redactor.json'), piProjectPath(cwd, 'secret-redactor.json')];
  for (const path of paths) {
    const parsed = tryReadJsoncFile(path, warnings, { requireObject: true });
    if (parsed === undefined) continue;
    const obj = parsed as Record<string, unknown>;

    if (obj.layers && typeof obj.layers === 'object' && !Array.isArray(obj.layers)) {
      const layers = obj.layers as Record<string, unknown>;
      if (typeof layers.prefixed === 'boolean') config.layers.prefixed = layers.prefixed;
      if (typeof layers.keyword === 'boolean') config.layers.keyword = layers.keyword;
      // `entropy` is reserved (Layer C ships disabled / unimplemented); accept silently.
    }

    if (typeof obj.keywordMinLength === 'number' && obj.keywordMinLength > 0) {
      config.keywordMinLength = Math.floor(obj.keywordMinLength);
    }

    if (obj.rules !== undefined) {
      if (!Array.isArray(obj.rules)) {
        warnings.push({ path, error: '`rules` must be an array' });
      } else {
        for (const entry of obj.rules) {
          if (!entry || typeof entry !== 'object') continue;
          const rule = compileRule(entry as Record<string, unknown>, path, warnings);
          if (rule) config.customRules.push(rule);
        }
      }
    }

    if (obj.allowlist !== undefined) {
      if (!Array.isArray(obj.allowlist)) {
        warnings.push({ path, error: '`allowlist` must be an array' });
      } else {
        for (const pat of obj.allowlist) {
          if (typeof pat !== 'string' || pat.length === 0) continue;
          try {
            config.allowlist.push(new RegExp(pat));
          } catch (err) {
            warnings.push({ path, error: `allowlist pattern "${pat}" is invalid regex: ${String(err)}` });
          }
        }
      }
    }
  }

  return { config, warnings };
}
