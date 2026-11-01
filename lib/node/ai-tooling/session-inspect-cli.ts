#!/usr/bin/env node
// Metadata-only pi session inspection. Never prints message, thinking, tool,
// recap, timeline, reminder, or label text; see SESSION-INSPECT.md.
// SPDX-License-Identifier: MIT

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { inspectSession, renderSessionInspection } from '../pi/session-inspect.ts';
import { collectCandidates, DEFAULT_DIRS, pickSession } from './session-locator.ts';

export const SESSION_INSPECT_HELP = `Usage: ai-session-inspect [<session-id|prefix|path>] [options]

Metadata-only pi session inspection for debugging context loss without exposing
conversation content. Prints counts, sizes, token usage, recap coverage, window
cutoffs, heuristic findings, and validated identifiers. Never prints message,
thinking, tool, recap, timeline, reminder, label, or path text. Cast names are
always anonymized.

With no selector, inspects the newest pi session.
  --json               Full machine-readable report
  --turns              Per-turn table (sizes, prompt tokens, window cutoffs)
  --recaps             Recap, window checkpoint, timeline/capture, compaction tables
  --snapshots          Reminder snapshot sizes per spec id
  --all                Same as --turns --recaps --snapshots
  --no-ids             Replace tool/model/provider/custom/spec names with ordinals
  -u, --user-dir DIR   pi sessions dir (default: ~/.pi/agent/sessions)
  -h, --help           Show help

Value options accept --flag=value. Local only; no model or network calls.`;

/** Errors whose text is authored here and safe to print. */
class UsageError extends Error {}

interface ParsedArgs {
  selector?: string;
  userDir: string;
  json: boolean;
  turns: boolean;
  recaps: boolean;
  snapshots: boolean;
  anonymizeIds: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    userDir: DEFAULT_DIRS.pi,
    json: false,
    turns: false,
    recaps: false,
    snapshots: false,
    anonymizeIds: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        continue;
      case '--json':
        args.json = true;
        continue;
      case '--turns':
        args.turns = true;
        continue;
      case '--recaps':
        args.recaps = true;
        continue;
      case '--snapshots':
        args.snapshots = true;
        continue;
      case '--all':
        args.turns = true;
        args.recaps = true;
        args.snapshots = true;
        continue;
      case '--no-ids':
        args.anonymizeIds = true;
        continue;
      case '-u':
      case '--user-dir': {
        const value = argv[++index];
        if (!value || value.startsWith('-')) throw new UsageError(`missing value for ${arg}`);
        args.userDir = value;
        continue;
      }
      default:
        break;
    }
    if (arg.startsWith('--user-dir=')) {
      const value = arg.slice('--user-dir='.length);
      if (!value) throw new UsageError('missing value for --user-dir');
      args.userDir = value;
      continue;
    }
    if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}`);
    if (args.selector !== undefined) throw new UsageError('only one session selector is supported');
    args.selector = arg;
  }
  return args;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveSession(selector: string | undefined, userDir: string): string {
  if (selector && isFile(resolve(selector))) return resolve(selector);
  const picked = pickSession(collectCandidates('pi', userDir, process.cwd(), Boolean(selector)), selector);
  if (picked.ok) return picked.filePath;
  if (picked.error === 'ambiguous')
    throw new UsageError(`session selector is ambiguous; matching ids: ${picked.matches.join(', ')}`);
  throw new UsageError('no matching pi session found');
}

function main(argv: readonly string[]): void {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(SESSION_INSPECT_HELP);
    return;
  }
  const file = resolveSession(args.selector, args.userDir);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new UsageError('could not read the selected session file');
  }
  const report = inspectSession(raw.split('\n'), { anonymizeIds: args.anonymizeIds });
  console.log(
    args.json
      ? JSON.stringify(report, null, 2)
      : renderSessionInspection(report, { turns: args.turns, recaps: args.recaps, snapshots: args.snapshots }),
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // Only messages authored above are printed; parser and fs errors can quote content or paths.
  console.error(
    `ai-session-inspect: ${error instanceof UsageError ? error.message : 'inspection failed; no session content was printed'}`,
  );
  process.exitCode = 1;
}
