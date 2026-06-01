#!/usr/bin/env node
/**
 * Emit ready-to-paste web-UI prompts for generating avatar sprite sheets,
 * rendered from sprite-manifest.ts so they never drift from the slicer.
 * Character-agnostic: pass your character description via --identity-file
 * (or --identity) and upload your own reference images in the web UI.
 *
 * Node 24 runs this directly (`node print-prompts.ts`, type stripping is on).
 *
 * Each group produces sheets `a` (frame 0), `b` (frame 1), and `x1`/`x2`/...
 * for any extra animation frames. Generate one chat/session per group so the
 * character stays consistent across its sheets.
 *
 * Usage:
 *   node print-prompts.ts [--group <name>] [--sheet a|b|x1|...] [--identity-file <path>]
 *   node print-prompts.ts --identity-file avatar-ref/identity.txt           # all groups, all sheets
 *   node print-prompts.ts --group activities --sheet a --identity "..."      # one sheet
 */

import { readFileSync } from 'node:fs';

import { BORDER, CHROMA, GRID, GROUPS, STYLE, type Sheet, sheetsFor } from './sprite-manifest.ts';

const IDENTITY_PLACEHOLDER =
  '<CHARACTER IDENTITY: describe hair, eyes, outfit, vibe; say "match the attached reference images">';

interface PromptOpts {
  group: string;
  sheet: string;
  identity: string;
}

function parseArgs(argv: string[]): PromptOpts {
  const opts: PromptOpts = { group: '', sheet: '', identity: IDENTITY_PLACEHOLDER };
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
          'Usage: node print-prompts.ts [--group <name>] [--sheet a|b|x1|...] [--identity-file <path>|--identity <text>]\n',
        );
        process.exit(0);
        break;
      case '--group':
        opts.group = next().toLowerCase();
        break;
      // --frame is kept as an alias for --sheet (A->a, B->b).
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
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        process.exit(1);
    }
  }
  return opts;
}

/**
 * Content guard appended to the sheet rules for suggestive / mature groups.
 * Keeps them tasteful and within image-UI policy: expression-driven, fully
 * clothed, head-and-shoulders only - no nudity, suggestive posing, or explicit
 * content. Shared by `sultry` and the opt-in `mature` overlay groups.
 */
const SFW_GUARD =
  'Keep every cell strictly safe-for-work and tasteful: head-and-shoulders only, fully clothed in the same outfit, expression- and gaze-driven only. No nudity, no suggestive or revealing posing, no explicit or sexual content - just facial expression, flush, and a hint of body language.';

const GROUP_GUARDS: Record<string, string> = {
  sultry: SFW_GUARD,
  desire: SFW_GUARD,
  intensity: SFW_GUARD,
  intimacy: SFW_GUARD,
};

function sheetRules(groupName: string): string {
  const cells = GRID.cols * GRID.rows;
  const guard = GROUP_GUARDS[groupName];
  return (
    `Arrange exactly ${cells} sprites in a strict, evenly spaced ${GRID.cols}x${GRID.rows} grid, read left-to-right then top-to-bottom, ` +
    `on a single flat ${CHROMA} (pure green) background. ` +
    `Outline every cell with a thin 1px solid bright cyan (${BORDER}) rectangular border - flat and fully saturated, no gradient or glow. Make all borders the exact same size and evenly spaced, with green gutters between them. ` +
    `Draw one sprite inside each border box at the EXACT same size and position in every cell: head near the top inner edge, centered horizontally, the same bust crop. Leave a clear band of plain green between the character and the cyan border on all sides - nothing should touch or cross the border. ` +
    'The borders are alignment guides only (they get removed). No text, labels, numbers, drop shadows, or extra panel lines.' +
    (guard === undefined ? '' : ` ${guard}`)
  );
}

function buildPrompt(groupName: string, sheet: Sheet): string {
  const lines: string[] = [];
  lines.push(`# ${groupName} - sheet ${sheet.name}`);
  lines.push('');
  lines.push(`Style: ${STYLE}.`);
  lines.push('');
  lines.push('Character: {identity}.');
  lines.push('');
  lines.push(sheetRules(groupName));
  lines.push('');
  lines.push('Cells (one expression each):');
  sheet.cells.forEach((cell, i) => {
    if (cell === null) {
      lines.push(`  ${i + 1}. (leave blank - background only)`);
    } else if (cell.frame === 0) {
      lines.push(`  ${i + 1}. ${cell.state}: ${cell.desc}`);
    } else {
      lines.push(`  ${i + 1}. ${cell.state} [frame ${cell.frame + 1}]: ${cell.desc}`);
    }
  });
  if (sheet.name !== 'a') {
    lines.push('');
    lines.push(
      'Keep the identical character, style, palette, framing, and grid layout as the base sheet (a); only apply the per-cell change noted.',
    );
  }
  return lines.join('\n');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const groups = opts.group.length > 0 ? [opts.group] : Object.keys(GROUPS);
  for (const groupName of groups) {
    if (!(groupName in GROUPS)) {
      process.stderr.write(`Unknown group "${groupName}". Known: ${Object.keys(GROUPS).join(', ')}\n`);
      process.exit(1);
    }
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

main();
