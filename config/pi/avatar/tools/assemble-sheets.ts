#!/usr/bin/env node
/**
 * Assemble a chosen model's per-cell PNGs into the grid "sheets" the hosted
 * flow produces, so the winner of an A/B/C comparison can be sliced into the
 * emote set with the SAME slice-sheets.ts QA path as the OpenAI flow.
 *
 * Node 24 runs this directly (`node assemble-sheets.ts`, type stripping is on).
 *
 * Input:  avatar-ref/gen/<model>/<state>.<frame>.png (gen-comfyui.ts output).
 * Output: avatar-ref/sheets/<group>.<sheet>.png, a flat CHROMA (#00FF00) grid
 *         with a cyan (#00FFFF) BORDER drawn around EVERY cell (a sprite is
 *         composited only where one exists; empty/trailing cells get the border
 *         on a bare CHROMA tile), packed in the dense sheetsFor() order. CHROMA
 *         gutters separate the cells exactly as a generated sheet would, so
 *         slice-sheets.ts detects the grid and keys out CHROMA + BORDER
 *         unchanged -- `--check` and contact-sheet QA are identical to the
 *         hosted/grid flow. Bordering every cell (not just filled ones) keeps
 *         the full 4x3 grid structure even on a partial last sheet, so the
 *         slicer's gutter detection locks on instead of falling back to an even
 *         split (which a fully-empty trailing row would otherwise force).
 *
 * After assembling, slice as usual:
 *   node assemble-sheets.ts --model kontext
 *   node slice-sheets.ts --set <set> --in avatar-ref/sheets
 *   node slice-sheets.ts --set <set> --check
 *
 * Usage:
 *   node assemble-sheets.ts --model <name> [--dir <gen-root>] [--out <dir>]
 *                           [--group <name>] [--cell <px>] [--gutter <px>] [--border <px>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BORDER, CELLS, CHROMA, GRID, GROUPS, type Sheet, sheetsFor } from './sprite-manifest.ts';

const DEFAULT_DIR = 'avatar-ref/gen';
const DEFAULT_OUT = 'avatar-ref/sheets';
const DEFAULT_CELL = 512;
const DEFAULT_GUTTER = 32;
const DEFAULT_BORDER = 8;

interface Opts {
  model: string;
  dir: string;
  out: string;
  group: string;
  cell: number;
  gutter: number;
  border: number;
}

/** Fixed grid geometry shared by every assembled sheet (so the slicer's grid
 * reference scaling lands identically across a group's sheets). */
export interface Geom {
  /** Per-cell tile size in px (square; sprite resized to fit, border included). */
  cell: number;
  /** CHROMA gutter between cells and around the outer margin, in px. */
  gutter: number;
  /** Cyan BORDER thickness drawn just inside each cell tile edge, in px. */
  border: number;
  cols: number;
  rows: number;
}

/**
 * One cell tile to draw at a grid index (0..CELLS-1, reading order). `file` is a
 * per-cell PNG to composite; when omitted the tile is a bare CHROMA square with
 * just the registration BORDER (used for empty/trailing cells so the grid stays
 * fully detectable).
 */
export interface Placement {
  index: number;
  file?: string;
}

/** Full sheet canvas size for a geometry: cols/rows tiles plus surrounding gutters. */
export function sheetSize(geom: Geom): { w: number; h: number } {
  return {
    w: geom.cols * geom.cell + (geom.cols + 1) * geom.gutter,
    h: geom.rows * geom.cell + (geom.rows + 1) * geom.gutter,
  };
}

/** Top-left origin (original-image px) of the cell tile at a reading-order index. */
export function cellOrigin(index: number, geom: Geom): { x: number; y: number } {
  const col = index % geom.cols;
  const row = Math.floor(index / geom.cols);
  return {
    x: geom.gutter + col * (geom.cell + geom.gutter),
    y: geom.gutter + row * (geom.cell + geom.gutter),
  };
}

/**
 * The full `magick` argument list for one sheet: a CHROMA canvas, then each
 * placed cell composited at its grid origin. A cell with a `file` is flattened
 * onto CHROMA, fit into the tile interior, and framed with the cyan BORDER; a
 * cell without one is a bare CHROMA tile carrying only the BORDER. Pure string
 * building -- the caller runs it.
 */
export function montageArgs(placements: Placement[], geom: Geom, out: string): string[] {
  const { w, h } = sheetSize(geom);
  const inner = Math.max(1, geom.cell - 2 * geom.border);
  const args: string[] = ['-size', `${w}x${h}`, `xc:${CHROMA}`];
  for (const { index, file } of placements) {
    const { x, y } = cellOrigin(index, geom);
    if (file === undefined) {
      args.push(
        '(',
        '-size',
        `${inner}x${inner}`,
        `xc:${CHROMA}`,
        '-bordercolor',
        BORDER,
        '-border',
        String(geom.border),
        ')',
        '-geometry',
        `+${x}+${y}`,
        '-composite',
      );
      continue;
    }
    args.push(
      '(',
      file,
      '-background',
      CHROMA,
      '-alpha',
      'remove',
      '-alpha',
      'off',
      '-resize',
      `${inner}x${inner}`,
      '-gravity',
      'center',
      '-extent',
      `${inner}x${inner}`,
      '-bordercolor',
      BORDER,
      '-border',
      String(geom.border),
      // Reset gravity inside the group so the centered -extent above does not
      // leak NorthWest/center state onto the top-left -geometry composite below.
      '+gravity',
      ')',
      '-geometry',
      `+${x}+${y}`,
      '-composite',
    );
  }
  args.push(out);
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'assemble-sheets - montage per-cell PNGs into <group>.<sheet>.png grid sheets',
      '',
      'Usage:',
      '  node assemble-sheets.ts --model <name> [--dir <gen-root>] [--out <dir>]',
      '                          [--group <name>] [--cell <px>] [--gutter <px>] [--border <px>]',
      '',
      'Flags:',
      '  --model <name>   Per-cell PNG source: <dir>/<model>/<state>.<frame>.png (required).',
      `  --dir <dir>      Root holding per-model subdirs (default: ${DEFAULT_DIR}).`,
      `  --out <dir>      Output dir for <group>.<sheet>.png (default: ${DEFAULT_OUT}).`,
      '  --group <name>   Only assemble this manifest group (default: every group).',
      `  --cell <px>      Per-cell tile size (default: ${DEFAULT_CELL}).`,
      `  --gutter <px>    CHROMA gutter between cells (default: ${DEFAULT_GUTTER}).`,
      `  --border <px>    Cyan BORDER thickness per cell (default: ${DEFAULT_BORDER}).`,
      '  -h, --help       Show this help.',
      '',
      'Then slice as usual:',
      '  node slice-sheets.ts --set <set> --in <out>',
      '  node slice-sheets.ts --set <set> --check',
      '',
      `Groups: ${Object.keys(GROUPS).join(', ')}`,
    ].join('\n') + '\n',
  );
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    process.stderr.write(`Error: ${flag} requires a positive integer, got "${raw}".\n`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    model: '',
    dir: DEFAULT_DIR,
    out: DEFAULT_OUT,
    group: '',
    cell: DEFAULT_CELL,
    gutter: DEFAULT_GUTTER,
    border: DEFAULT_BORDER,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const next = (): string => inlineVal ?? argv[++i];
    switch (key) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--model':
        opts.model = next();
        break;
      case '--dir':
        opts.dir = next();
        break;
      case '--out':
        opts.out = next();
        break;
      case '--group':
        opts.group = next().toLowerCase();
        break;
      case '--cell':
        opts.cell = parsePositiveInt(next(), '--cell');
        break;
      case '--gutter':
        opts.gutter = parsePositiveInt(next(), '--gutter');
        break;
      case '--border':
        opts.border = parsePositiveInt(next(), '--border');
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        process.exit(1);
    }
  }
  return opts;
}

function ensureMagick(): void {
  try {
    execFileSync('magick', ['--version'], { stdio: 'ignore' });
  } catch {
    process.stderr.write('Error: ImageMagick `magick` not found on PATH.\n');
    process.exit(1);
  }
}

/**
 * Tile placements for every cell of a sheet: a sprite where a PNG exists,
 * otherwise a bare bordered CHROMA tile (manifest null, trailing pad, or a
 * non-null cell whose PNG is missing) so the full grid stays detectable.
 * `filled` counts the sprites placed; `missing` lists non-null cells with no PNG.
 */
function resolveSheet(sheet: Sheet, modelDir: string): { placements: Placement[]; filled: number; missing: string[] } {
  const placements: Placement[] = [];
  const missing: string[] = [];
  let filled = 0;
  for (let i = 0; i < CELLS; i++) {
    const cell = sheet.cells.at(i);
    if (cell === undefined || cell === null) {
      placements.push({ index: i });
      continue;
    }
    const file = join(modelDir, `${cell.state}.${cell.frame}.png`);
    if (existsSync(file)) {
      placements.push({ index: i, file });
      filled++;
    } else {
      placements.push({ index: i });
      missing.push(`${cell.state}.${cell.frame}`);
    }
  }
  return { placements, filled, missing };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.model.length === 0) {
    process.stderr.write('Error: --model <name> is required.\n');
    process.exit(1);
  }
  const modelDir = join(opts.dir, opts.model);
  if (!existsSync(modelDir)) {
    process.stderr.write(`Error: model dir not found: ${modelDir}\n`);
    process.exit(1);
  }
  if (opts.group.length > 0 && !(opts.group in GROUPS)) {
    process.stderr.write(`Error: unknown group "${opts.group}".\n`);
    process.exit(1);
  }
  ensureMagick();

  const geom: Geom = {
    cell: opts.cell,
    gutter: opts.gutter,
    border: opts.border,
    cols: GRID.cols,
    rows: GRID.rows,
  };
  mkdirSync(opts.out, { recursive: true });

  const groups = opts.group.length > 0 ? [opts.group] : Object.keys(GROUPS);
  let sheetsWritten = 0;
  let cellsPlaced = 0;
  const allMissing: string[] = [];
  for (const group of groups) {
    for (const sheet of sheetsFor(group)) {
      const { placements, filled, missing } = resolveSheet(sheet, modelDir);
      allMissing.push(...missing.map((cell) => `${group}/${cell}`));
      if (filled === 0) continue;
      const out = join(opts.out, `${group}.${sheet.name}.png`);
      execFileSync('magick', montageArgs(placements, geom, out));
      process.stdout.write(`${out} <- ${filled} cell(s)\n`);
      sheetsWritten++;
      cellsPlaced += filled;
    }
  }

  const { w, h } = sheetSize(geom);
  process.stdout.write(`\nDone: ${sheetsWritten} sheet(s), ${cellsPlaced} cell(s) at ${w}x${h} -> ${opts.out}\n`);
  if (allMissing.length > 0) {
    process.stdout.write(`Missing per-cell PNGs (left blank): ${allMissing.join(', ')}\n`);
  }
  if (sheetsWritten === 0) {
    process.stdout.write(`No per-cell PNGs found under ${modelDir} for the requested group(s).\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
