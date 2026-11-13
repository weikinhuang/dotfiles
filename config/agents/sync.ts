#!/usr/bin/env node
// Agent harness config sync: generates the per-harness shell allowlists from config/agents/shell-permissions.jsonc
// (`generate`) and links / merges the repo config into each harness home (`diff`, `apply`).
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { generateShellPermissionFiles, staleFiles } from '../../lib/node/agents-config/generate.ts';
import { JSON_CODEC } from '../../lib/node/agents-config/settings-merge.ts';
import {
  type HarnessName,
  parseSyncArgs,
  SYNC_HELP,
  SyncArgsError,
  type SyncCommand,
} from '../../lib/node/agents-config/sync-args.ts';
import {
  applyPlan,
  countActions,
  countConflicts,
  planSync,
  renderPlan,
} from '../../lib/node/agents-config/sync-plan.ts';
import { atomicWriteFile } from '../../lib/node/pi/atomic-write.ts';
import { TOML_CODEC } from './toml-codec.ts';

const REPO_ROOT = realpathSync(resolve(import.meta.dirname, '../..'));

function readRepoFile(path: string): string | undefined {
  const abs = join(REPO_ROOT, path);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
}

function runGenerate(check: boolean): number {
  const stale = staleFiles(generateShellPermissionFiles(readRepoFile));
  if (check) {
    for (const file of stale) console.error(`out of date: ${file.path}`);
    if (stale.length > 0) console.error('run: config/agents/sync.ts generate');
    else console.log('generated files are up to date');
    return stale.length > 0 ? 1 : 0;
  }
  for (const file of stale) {
    atomicWriteFile(join(REPO_ROOT, file.path), file.content);
    console.log(`updated ${file.path}`);
  }
  if (stale.length === 0) console.log('generated files are up to date');
  return 0;
}

function runSync(mode: 'diff' | 'apply', harnesses: HarnessName[], force: boolean): number {
  const plans = planSync({
    repoRoot: REPO_ROOT,
    env: process.env,
    harnesses,
    force,
    now: new Date(),
    codecs: { json: JSON_CODEC, jsonc: JSON_CODEC, toml: TOML_CODEC },
  });
  for (const line of renderPlan(plans, REPO_ROOT)) console.log(line);
  const actions = countActions(plans);
  const conflicts = countConflicts(plans);
  if (mode === 'apply') applyPlan(plans);
  const summary =
    actions === 0 && conflicts === 0
      ? 'nothing to do'
      : `${actions} ${mode === 'apply' ? 'applied' : 'to apply'}, ${conflicts} conflict${conflicts === 1 ? '' : 's'}`;
  console.log(`\n${summary}`);
  if (mode === 'diff' && actions > 0) console.log('run: config/agents/sync.ts apply');
  return conflicts > 0 || (mode === 'diff' && actions > 0) ? 1 : 0;
}

function main(argv: string[]): number {
  let args: SyncCommand;
  try {
    args = parseSyncArgs(argv);
  } catch (err) {
    if (!(err instanceof SyncArgsError)) throw err;
    console.error(`${err.message}\n\n${SYNC_HELP}`);
    return 1;
  }
  switch (args.command) {
    case 'help':
      console.log(SYNC_HELP);
      return 0;
    case 'generate':
      return runGenerate(args.check);
    case 'diff':
    case 'apply':
      return runSync(args.command, args.harnesses, args.force);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
