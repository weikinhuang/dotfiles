#!/usr/bin/env node
/**
 * One-shot migration: translate `~/.pi/protected-paths.json` (the
 * legacy schema consumed by `config/pi/extensions/protected-paths.ts`)
 * into the unified `~/.pi/filesystem.json` (consumed by
 * `config/pi/extensions/filesystem.ts` AND
 * `config/pi/extensions/sandbox.ts` after Phase 3 of the
 * sandbox-runtime extension).
 *
 *   protected-paths.read.{basenames,segments,paths}   ->
 *     filesystem.read.deny.{basenames,segments,paths}
 *   protected-paths.write.{basenames,segments,paths}  ->
 *     filesystem.write.deny.{basenames,segments,paths}
 *   filesystem.write.allow.paths                       <-
 *     `['.', '/tmp']`  (the new allow-only model needs explicit roots;
 *     persona writeRoots merge at runtime inside the extensions)
 *
 * Idempotent:
 *
 *   - If `~/.pi/filesystem.json` already exists, the script bails with
 *     a status message - re-running is a no-op.
 *   - If `~/.pi/protected-paths.json` does not exist, nothing to do.
 *   - The legacy file is left in place; delete it manually after you
 *     confirm the new file behaves correctly.
 *
 * Throwaway. Phase 4 of the sandbox-runtime rollout deletes this
 * script along with the last `protected-paths` references.
 *
 * Usage:
 *
 *   tsx scripts/migrate-protected-paths.ts [--dry-run]
 *   node --experimental-strip-types scripts/migrate-protected-paths.ts
 *
 * Exit codes:
 *
 *   0 - migration completed (or no-op).
 *   1 - input file existed but failed to parse.
 *   2 - output file already existed; re-running was deliberately a no-op.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseJsonc } from '../lib/node/pi/jsonc.ts';

interface LegacyRules {
  basenames?: unknown;
  segments?: unknown;
  paths?: unknown;
}

interface LegacyConfig {
  read?: LegacyRules;
  write?: LegacyRules;
}

interface UnifiedRules {
  basenames: string[];
  segments: string[];
  paths: string[];
}

interface UnifiedConfig {
  read: { deny: UnifiedRules; allow: UnifiedRules };
  write: { allow: UnifiedRules; deny: UnifiedRules };
}

function emptyRules(): UnifiedRules {
  return { basenames: [], segments: [], paths: [] };
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function liftRules(legacy: LegacyRules | undefined): UnifiedRules {
  if (!legacy) return emptyRules();
  return {
    basenames: coerceStringArray(legacy.basenames),
    segments: coerceStringArray(legacy.segments),
    paths: coerceStringArray(legacy.paths),
  };
}

/**
 * Translate the legacy two-category config into the unified four-bucket
 * shape. Read rules become `read.deny.*`; write rules become
 * `write.deny.*`. The new allow-only write model needs explicit roots,
 * so we seed `write.allow.paths` with `['.', '/tmp']` (matching the
 * shipped DEFAULT_POLICY).
 */
export function translateLegacyConfig(legacy: LegacyConfig): UnifiedConfig {
  return {
    read: {
      deny: liftRules(legacy.read),
      allow: emptyRules(),
    },
    write: {
      allow: { basenames: [], segments: [], paths: ['.', '/tmp'] },
      deny: liftRules(legacy.write),
    },
  };
}

function main(argv: string[]): number {
  const dryRun = argv.includes('--dry-run');
  const home = homedir();
  const legacyPath = join(home, '.pi', 'protected-paths.json');
  const unifiedPath = join(home, '.pi', 'filesystem.json');

  if (!existsSync(legacyPath)) {
    process.stdout.write(`migrate-protected-paths: ${legacyPath} does not exist; nothing to do.\n`);
    return 0;
  }

  if (existsSync(unifiedPath)) {
    process.stdout.write(
      `migrate-protected-paths: ${unifiedPath} already exists; refusing to overwrite. Re-running is a no-op.\n` +
        `  If you want to redo the migration, move ${unifiedPath} aside first.\n`,
    );
    return 2;
  }

  let parsed: LegacyConfig;
  try {
    const raw = readFileSync(legacyPath, 'utf8');
    parsed = parseJsonc<LegacyConfig>(raw);
  } catch (e) {
    process.stderr.write(
      `migrate-protected-paths: failed to parse ${legacyPath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }

  const unified = translateLegacyConfig(parsed);
  const json = `${JSON.stringify(unified, null, 2)}\n`;

  if (dryRun) {
    process.stdout.write(`migrate-protected-paths: dry-run, would write ${unifiedPath}:\n${json}`);
    return 0;
  }

  writeFileSync(unifiedPath, json, 'utf8');
  process.stdout.write(
    `migrate-protected-paths: wrote ${unifiedPath}.\n` +
      `  The legacy ${legacyPath} is left in place; delete it manually after you\n` +
      `  confirm filesystem.ts behaves as expected.\n`,
  );
  return 0;
}

// Only run when executed directly. The named export above is consumed
// by the spec under tests/scripts/.
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  process.exit(main(process.argv.slice(2)));
}
