#!/usr/bin/env node
/**
 * Emit ready-to-paste web-UI prompts for generating avatar sprite sheets,
 * rendered from sprite-manifest.ts so they never drift from the slicer.
 * Character-agnostic: pass your character description via --identity-file
 * (or --identity) and upload your own reference images in the web UI.
 *
 * Node 24 runs this directly (`node print-prompts.ts`, type stripping is on).
 *
 * Each group produces sequentially named sheets `1`, `2`, ... that densely pack
 * every (state, frame) cell. Generate one chat/session per group so the
 * character stays consistent across its sheets.
 *
 * Workflow: first generate the canonical "hero" bust (`--hero`, attach your
 * character art), approve one result as avatar-ref/canonical.png, then generate
 * the expression sheets/cells with the hero attached so every sprite matches it.
 *
 * Usage:
 *   node print-prompts.ts --hero --identity-file avatar-ref/identity.txt        # the canonical hero bust
 *   node print-prompts.ts [--group <name>] [--sheet 1|2|...] [--identity-file <path>]
 *   node print-prompts.ts --identity-file avatar-ref/identity.txt           # all groups, all sheets
 *   node print-prompts.ts --group activities --sheet 1 --identity "..."      # one sheet
 *   node print-prompts.ts --cell --group activities --identity-file <path>     # per-cell prompts
 *   node print-prompts.ts --cell --format json --group activities ...          # per-cell JSON
 */

import { readFileSync } from 'node:fs';

import { buildPrompt, cellPrompt, heroPrompt, type CellPromptEntry } from './prompt-lib.ts';
import { GROUPS, frameCount, sheetsFor } from './sprite-manifest.ts';

const IDENTITY_PLACEHOLDER =
  '<CHARACTER IDENTITY: describe hair, eyes, outfit, vibe; say "match the attached reference images">';

type CellFormat = 'text' | 'json';

interface PromptOpts {
  group: string;
  sheet: string;
  identity: string;
  cell: boolean;
  hero: boolean;
  format: CellFormat;
}

function parseArgs(argv: string[]): PromptOpts {
  const opts: PromptOpts = {
    group: '',
    sheet: '',
    identity: IDENTITY_PLACEHOLDER,
    cell: false,
    hero: false,
    format: 'text',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const next = (): string => inline ?? argv[++i];
    switch (key) {
      case '-h':
      case '--help':
        process.stdout.write(
          'Usage: node print-prompts.ts --hero [--identity-file <path>|--identity <text>]\n' +
            '       node print-prompts.ts [--group <name>] [--sheet 1|2|...] [--identity-file <path>|--identity <text>]\n' +
            '       node print-prompts.ts --cell [--format text|json] [--group <name>] [--identity-file <path>|--identity <text>]\n',
        );
        process.exit(0);
        break;
      case '--hero':
        opts.hero = true;
        break;
      case '--group':
        opts.group = next().toLowerCase();
        break;
      // --frame is kept as an alias for --sheet.
      case '--frame':
      case '--sheet':
        opts.sheet = next().toLowerCase();
        break;
      case '--identity':
        opts.identity = next();
        break;
      case '--identity-file':
        opts.identity = readFileSync(next(), 'utf8').trim();
        break;
      case '--cell':
        opts.cell = true;
        break;
      case '--format': {
        const format = next().toLowerCase();
        if (format !== 'text' && format !== 'json') {
          process.stderr.write(`Unknown --format "${format}". Use text or json.\n`);
          process.exit(1);
        }
        opts.format = format;
        break;
      }
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        process.exit(1);
    }
  }
  return opts;
}

function resolveGroups(groupName: string): string[] {
  const groups = groupName.length > 0 ? [groupName] : Object.keys(GROUPS);
  for (const name of groups) {
    if (!(name in GROUPS)) {
      process.stderr.write(`Unknown group "${name}". Known: ${Object.keys(GROUPS).join(', ')}\n`);
      process.exit(1);
    }
  }
  return groups;
}

function collectCellEntries(groupNames: string[], identity: string): CellPromptEntry[] {
  const entries: CellPromptEntry[] = [];
  for (const groupName of groupNames) {
    const group = GROUPS[groupName];
    if (group === undefined) continue;
    for (const state of group.states) {
      const frames = frameCount(groupName, state);
      for (let frame = 0; frame < frames; frame++) {
        entries.push({
          group: groupName,
          state,
          frame,
          prompt: cellPrompt(groupName, state, frame, identity, { reference: true }),
        });
      }
    }
  }
  return entries;
}

function emitCellPrompts(opts: PromptOpts): void {
  const groups = resolveGroups(opts.group);
  const entries = collectCellEntries(groups, opts.identity);
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  for (const entry of entries) {
    const header = `# ${entry.group} / ${entry.state} / frame ${entry.frame}`;
    process.stdout.write(`${header}\n\n${entry.prompt}\n\n${'-'.repeat(72)}\n\n`);
  }
}

function emitSheetPrompts(opts: PromptOpts): void {
  const groups = resolveGroups(opts.group);
  for (const groupName of groups) {
    const sheets = sheetsFor(groupName).filter((sheet) => opts.sheet.length === 0 || sheet.name === opts.sheet);
    if (sheets.length === 0) {
      const names = sheetsFor(groupName)
        .map((sheet) => sheet.name)
        .join(', ');
      process.stderr.write(`No sheet "${opts.sheet}" in group "${groupName}". Sheets: ${names}\n`);
      process.exit(1);
    }
    for (const sheet of sheets) {
      const prompt = buildPrompt(groupName, sheet).replace('{identity}', opts.identity);
      process.stdout.write(`${prompt}\n\n${'-'.repeat(72)}\n\n`);
    }
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.hero) {
    process.stdout.write(`# hero (canonical bust)\n\n${heroPrompt(opts.identity)}\n`);
  } else if (opts.cell) {
    emitCellPrompts(opts);
  } else {
    emitSheetPrompts(opts);
  }
}

main();
