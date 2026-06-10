#!/usr/bin/env node
/**
 * Slice generated sprite "sheets" into the per-state frame PNGs the avatar
 * extension loads. Character-agnostic: driven entirely by sprite-manifest.ts
 * and the --set/--in/--out flags. Uses ImageMagick (`magick`); no npm deps.
 *
 * Node 24 runs this directly (`node slice-sheets.ts`, type stripping is on).
 *
 * Input: a directory of sheets named `<tier>.<n>.png`, where <tier> is one of
 * the sequential sheet number `1`, `2`, ... (e.g. activities.1.png,
 * activities.2.png). Each is a GRID.cols x GRID.rows arrangement of sprites on a
 * flat CHROMA background.
 *
 * Grid-line detection: rather than guessing an even split or re-detecting the
 * character (whose bounding box shifts when arms/props stick out), we find the
 * real cell boundaries from the CHROMA gutters. A true gutter row/column is
 * CHROMA across the entire width/height, while inside a cell the character
 * breaks that up -- so projecting a "non-CHROMA" mask and locating the all-green
 * bands gives us GRID.cols+1 vertical and GRID.rows+1 horizontal grid lines.
 * Each cell is cropped to the EXACT interior between its lines (no inset, no
 * padding), so the model's in-box placement is preserved verbatim and frames
 * stay registered. If the line count doesn't match the manifest (e.g. a fully
 * blank edge row that merges into the margin), that sheet falls back to an even
 * GRID.cols x GRID.rows split.
 *
 * After cropping, CHROMA + BORDER (the optional per-cell registration rectangle
 * some UIs draw) are keyed to transparent and the box is resized to one shared
 * canvas (width = TARGET_PX, common cell aspect), so every state is the same
 * size. Empty cells (manifest nulls) are skipped.
 *
 * Output: `<out>/<state>/<frame>.png` (frame 0 = base). <out> defaults to the
 * device-local set dir the extension scans:
 *   ~/.pi/agent/avatar/emotes/<set>   (honors PI_CODING_AGENT_DIR)
 *
 * Usage:
 *   node slice-sheets.ts --set <name> --in <sheets-dir> [--out <dir>] [--sheet 1|2|...]
 *   node slice-sheets.ts --set <name> --check [--out <dir>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ALL_STATES,
  BORDER,
  CELLS,
  CHROMA,
  GRID,
  type Sheet,
  TARGET_PX,
  TIERS,
  allSheets,
  frameCountForState,
} from './sprite-manifest.ts';

const FUZZ = process.env.AVATAR_CHROMA_FUZZ ?? '20%';
// Fuzz for keying out the per-cell registration border some UIs draw. They
// render it anti-aliased/desaturated rather than pure, so this runs wide. Safe
// when BORDER is far from the art (see sprite-manifest); lower if it clips a
// character tone.
const BORDER_FUZZ = process.env.AVATAR_BORDER_FUZZ ?? '40%';
// Erode the alpha by ~1px after keying to remove the green anti-aliased fringe
// AI image UIs leave around soft edges. Set AVATAR_DEFRINGE=0 to disable.
const DEFRINGE = process.env.AVATAR_DEFRINGE !== '0';
// Force the even-split fallback for every sheet (skip gutter detection).
const GRID_MODE = process.env.AVATAR_SLICE === 'grid';
// Wider fuzz for the detection mask only: gutters must key to fully transparent
// so they read as empty, even when a sheet's green drifts a little. The output
// key uses the tighter FUZZ so it doesn't eat into the art.
const DETECT_FUZZ = process.env.AVATAR_DETECT_FUZZ ?? '28%';
// Downscale factor for the detection mask (speed; sub-pixel lines don't matter).
const MASK_SCALE = 4;
// A row/column counts as a gutter when its non-CHROMA pixel count (in mask px)
// is at or below this fraction of the perpendicular dimension, i.e. effectively
// all background. Raise if faint noise in blank cells hides a gutter.
const GUTTER_FRAC = Number(process.env.AVATAR_GUTTER_FRAC ?? '0.015');
// Minimum gutter run length (mask px) so a few stray background rows between
// limbs don't read as a grid line.
const MIN_GUTTER = 2;
// Background key color. By default the slicer samples each sheet's edges and keys
// the actual flat background color it finds - robust when a model renders a
// near-green instead of exact CHROMA. Force a color with AVATAR_BG_COLOR, or set
// AVATAR_BG_AUTODETECT=0 to always key the manifest CHROMA.
const rawBgColor = process.env.AVATAR_BG_COLOR?.trim();
const BG_COLOR_OVERRIDE = rawBgColor !== undefined && rawBgColor.length > 0 ? rawBgColor : undefined;
const BG_AUTODETECT = process.env.AVATAR_BG_AUTODETECT !== '0';

interface SliceOpts {
  set: string;
  in: string;
  out: string;
  sheet: string;
  check: boolean;
}

/** A box interior to extract, in original-image pixels. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Canvas {
  w: number;
  h: number;
}

interface Mask {
  w: number;
  h: number;
  px: Buffer;
}

function printHelp(): void {
  process.stdout.write(
    [
      'slice-sheets - turn sprite sheets into avatar per-state frame PNGs',
      '',
      'Usage:',
      '  node slice-sheets.ts --set <name> --in <sheets-dir> [--out <dir>] [--sheet <tier.n>]',
      '  node slice-sheets.ts --set <name> --check [--out <dir>]',
      '',
      'Flags:',
      '  --set <name>     Emote-set name (output subdir + the name you map in config).',
      '  --in <dir>       Directory of <tier>.<n>.png sheets to slice.',
      '  --out <dir>      Output set dir. Default: <pi-agent>/avatar/emotes/<set>.',
      '  --sheet <name>   Only process this sheet (e.g. standard.1; default: all found).',
      '  --check          Report per-state frame coverage under --out and exit.',
      '  -h, --help       Show this help.',
      '',
      'Env: AVATAR_SLICE=grid (force even split), AVATAR_GUTTER_FRAC,',
      '     AVATAR_CHROMA_FUZZ, AVATAR_BORDER_FUZZ, AVATAR_DEFRINGE=0,',
      '     AVATAR_BG_COLOR=<color> (force key color), AVATAR_BG_AUTODETECT=0.',
      '',
      `Sheets named <tier>.<n>; tiers: ${TIERS.join(', ')}.`,
    ].join('\n') + '\n',
  );
}

function piAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.pi', 'agent');
}

function defaultOut(set: string): string {
  return join(piAgentDir(), 'avatar', 'emotes', set);
}

function parseArgs(argv: string[]): SliceOpts {
  const opts: SliceOpts = { set: '', in: '', out: '', sheet: '', check: false };
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
      case '--set':
        opts.set = next();
        break;
      case '--in':
        opts.in = next();
        break;
      case '--out':
        opts.out = next();
        break;
      // --frame is kept as an alias for --sheet.
      case '--frame':
      case '--sheet':
        opts.sheet = next().toLowerCase();
        break;
      case '--check':
        opts.check = true;
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

function identify(file: string): string {
  try {
    return execFileSync('magick', ['identify', '-format', '%wx%h', file], { encoding: 'utf8' }).trim();
  } catch {
    return '?';
  }
}

function dimensions(file: string): { w: number; h: number } {
  const [w, h] = identify(file)
    .split('x')
    .map((n) => Number(n));
  return { w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 };
}

function keyArgs(bg: string): string[] {
  const defringe = DEFRINGE ? ['-channel', 'A', '-morphology', 'Erode', 'Octagon:1', '+channel'] : [];
  return ['-fuzz', FUZZ, '-transparent', bg, '-fuzz', BORDER_FUZZ, '-transparent', BORDER, ...defringe];
}

// ── Grid-line detection via CHROMA gutters ─────────────────────────────

/**
 * Downscaled binary mask where non-CHROMA pixels (character + any BORDER) are
 * "on" (>127). Only CHROMA is keyed here, so the BORDER lines read as content
 * and can't open a false gutter at a cell edge.
 */
function chromaMask(sheetPath: string, bg: string): Mask {
  const pct = Math.round(100 / MASK_SCALE);
  const pgm = execFileSync(
    'magick',
    [
      sheetPath,
      '-fuzz',
      DETECT_FUZZ,
      '-transparent',
      bg,
      '-alpha',
      'extract',
      '-resize',
      `${pct}%`,
      '-threshold',
      '25%',
      'pgm:-',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  let p = 0;
  const isWs = (c: number): boolean => c === 32 || c === 10 || c === 9 || c === 13;
  const token = (): string => {
    while (p < pgm.length && isWs(pgm[p])) p++;
    const start = p;
    while (p < pgm.length && !isWs(pgm[p])) p++;
    return pgm.toString('ascii', start, p);
  };
  token(); // magic "P5"
  const w = Number(token());
  const h = Number(token());
  token(); // maxval
  p++; // single whitespace before the raster
  return { w, h, px: pgm.subarray(p) };
}

/** Runs [start,end] where the profile stays at/under `maxOn` for >= minLen. */
function gutters(sums: number[], maxOn: number, minLen: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < sums.length; i++) {
    if (sums[i] <= maxOn) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minLen) out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0 && sums.length - start >= minLen) out.push([start, sums.length - 1]);
  return out;
}

/**
 * Cell boxes (original-image px), reading order, from the gutters. Returns null
 * when the detected line count doesn't match the manifest grid, so the caller
 * can fall back to an even split.
 */
function detectGrid(mask: Mask): Box[] | null {
  const { w, h, px } = mask;
  const on = (x: number, y: number): number => (px[y * w + x] > 127 ? 1 : 0);
  const colSum = Array.from({ length: w }, (_unused, x) => {
    let s = 0;
    for (let y = 0; y < h; y++) s += on(x, y);
    return s;
  });
  const rowSum = Array.from({ length: h }, (_unused, y) => {
    let s = 0;
    for (let x = 0; x < w; x++) s += on(x, y);
    return s;
  });
  const vGut = gutters(colSum, Math.round(h * GUTTER_FRAC), MIN_GUTTER);
  const hGut = gutters(rowSum, Math.round(w * GUTTER_FRAC), MIN_GUTTER);
  if (vGut.length !== GRID.cols + 1 || hGut.length !== GRID.rows + 1) return null;

  const boxes: Box[] = [];
  for (let r = 0; r < GRID.rows; r++) {
    const y0 = (hGut[r][1] + 1) * MASK_SCALE;
    const y1 = hGut[r + 1][0] * MASK_SCALE;
    for (let c = 0; c < GRID.cols; c++) {
      const x0 = (vGut[c][1] + 1) * MASK_SCALE;
      const x1 = vGut[c + 1][0] * MASK_SCALE;
      boxes.push({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) });
    }
  }
  return boxes;
}

/** Even GRID.cols x GRID.rows split, used when gutter detection can't lock on. */
function evenGrid(imgW: number, imgH: number): Box[] {
  const cellW = imgW / GRID.cols;
  const cellH = imgH / GRID.rows;
  const boxes: Box[] = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      boxes.push({
        x: Math.round(c * cellW),
        y: Math.round(r * cellH),
        w: Math.round(cellW),
        h: Math.round(cellH),
      });
    }
  }
  return boxes;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ── Background color detection ─────────────────────────────────────────

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Parse an ImageMagick pixel string - `srgb(r,g,b)`, `srgba(r,g,b,a)`, `rgb(...)`,
 * or `#rrggbb` / `#rgb` - into [r,g,b] (0-255), or undefined when unrecognized.
 */
export function parsePixel(value: string): [number, number, number] | undefined {
  const text = value.trim();
  const fn = /^s?rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(text);
  if (fn !== null) {
    const r = Number(fn[1]);
    const g = Number(fn[2]);
    const b = Number(fn[3]);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [clamp255(r), clamp255(g), clamp255(b)];
    }
  }
  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (hex6 !== null) {
    return [Number.parseInt(hex6[1], 16), Number.parseInt(hex6[2], 16), Number.parseInt(hex6[3], 16)];
  }
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (hex3 !== null) {
    return [
      Number.parseInt(hex3[1] + hex3[1], 16),
      Number.parseInt(hex3[2] + hex3[2], 16),
      Number.parseInt(hex3[3] + hex3[3], 16),
    ];
  }
  return undefined;
}

/** Quantize a channel so near-identical background pixels share a bucket. */
function quantize(n: number): number {
  return Math.round(n / 12) * 12;
}

/**
 * Pick the flat background key color from sampled perimeter pixels: the most
 * common color (after coarse quantization), returned as the median of that
 * cluster's members as an IM `srgb(r,g,b)` string. The flat background dominates
 * the perimeter even when a few samples clip the character, so the mode is far
 * more robust than a raw median + spread guard. Falls back to `fallback` when
 * fewer than 3 samples parse, or no color clusters into a majority (i.e. the
 * image is not a flat-background sheet).
 */
export function pickBackgroundColor(samples: string[], fallback: string): string {
  const rgb = samples.map(parsePixel).filter((c): c is [number, number, number] => c !== undefined);
  if (rgb.length < 3) return fallback;
  const keyOf = (c: [number, number, number]): string => `${quantize(c[0])},${quantize(c[1])},${quantize(c[2])}`;
  const counts = new Map<string, number>();
  for (const c of rgb) counts.set(keyOf(c), (counts.get(keyOf(c)) ?? 0) + 1);
  let bestKey = '';
  let bestN = 0;
  for (const [key, n] of counts) {
    if (n > bestN) {
      bestKey = key;
      bestN = n;
    }
  }
  if (bestN * 2 < rgb.length) return fallback;
  const members = rgb.filter((c) => keyOf(c) === bestKey);
  const channel = (i: number): number[] => members.map((c) => c[i]);
  return `srgb(${median(channel(0))},${median(channel(1))},${median(channel(2))})`;
}

/** 12 perimeter sample points (3 per edge, inset 2px) - background-heavy. */
function perimeterPoints(w: number, h: number): [number, number][] {
  const span = (n: number): number[] =>
    [1 / 6, 3 / 6, 5 / 6].map((f) => Math.min(n - 3, Math.max(2, Math.round(n * f))));
  const points: [number, number][] = [];
  for (const x of span(w)) points.push([x, 2], [x, h - 3]);
  for (const y of span(h)) points.push([2, y], [w - 3, y]);
  return points;
}

/**
 * Detect the flat background color of a sheet by sampling perimeter points.
 * Honors AVATAR_BG_COLOR (force) and AVATAR_BG_AUTODETECT=0 (use CHROMA); falls
 * back to CHROMA on any magick failure or a too-small image.
 */
function detectBackgroundColor(path: string, w: number, h: number): string {
  if (BG_COLOR_OVERRIDE !== undefined) return BG_COLOR_OVERRIDE;
  if (!BG_AUTODETECT || w <= 4 || h <= 4) return CHROMA;
  const fmt = perimeterPoints(w, h)
    .map(([x, y]) => `%[pixel:p{${x},${y}}]`)
    .join(';');
  try {
    const out = execFileSync('magick', [path, '-depth', '8', '-format', fmt, 'info:'], { encoding: 'utf8' });
    const samples = out
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return pickBackgroundColor(samples, CHROMA);
  } catch {
    return CHROMA;
  }
}

// ── Writing frames ─────────────────────────────────────────────────────

/** Crop a box interior, key out the background + BORDER, resize to fill the canvas. */
function writeCell(sheetPath: string, box: Box, canvas: Canvas, dest: string, bg: string): void {
  execFileSync('magick', [
    sheetPath,
    '-crop',
    `${box.w}x${box.h}+${box.x}+${box.y}`,
    '+repage',
    ...keyArgs(bg),
    '-filter',
    'point',
    '-resize',
    `${canvas.w}x${canvas.h}!`,
    dest,
  ]);
}

function nonNullBoxes(sheet: Sheet, boxes: Box[]): { state: string; frame: number; box: Box }[] {
  const out: { state: string; frame: number; box: Box }[] = [];
  for (let i = 0; i < CELLS; i++) {
    const cell = sheet.cells.at(i);
    if (cell === undefined || cell === null) continue;
    const box = boxes.at(i);
    if (box === undefined) continue;
    out.push({ state: cell.state, frame: cell.frame, box });
  }
  return out;
}

function sliceSheet(sheetPath: string, sheet: Sheet, boxes: Box[], canvas: Canvas, outDir: string, bg: string): number {
  let written = 0;
  for (const { state, frame, box } of nonNullBoxes(sheet, boxes)) {
    const stateDir = join(outDir, state);
    mkdirSync(stateDir, { recursive: true });
    writeCell(sheetPath, box, canvas, join(stateDir, `${frame}.png`), bg);
    written++;
  }
  return written;
}

function runCheck(outDir: string): void {
  process.stdout.write(`Checking ${outDir}\n`);
  let complete = 0;
  const missing: string[] = [];
  for (const state of ALL_STATES) {
    const expected = frameCountForState(state);
    let have = 0;
    for (let n = 0; n < expected; n++) {
      if (existsSync(join(outDir, state, `${n}.png`))) have++;
    }
    if (have >= expected) complete++;
    if (have === 0) missing.push(state);
    const dims = have > 0 ? identify(join(outDir, state, '0.png')) : '-';
    process.stdout.write(`  ${state.padEnd(14)} ${have}/${expected}  ${dims}\n`);
  }
  process.stdout.write(`\n${complete}/${ALL_STATES.length} states fully covered.\n`);
  if (missing.length > 0) process.stdout.write(`No frames yet: ${missing.join(', ')}\n`);
}

type Source = 'detected' | 'reference' | 'even-grid';

interface Job {
  file: string;
  tier: string;
  sheet: Sheet;
  w: number;
  h: number;
  raw: Box[] | null;
  boxes: Box[];
  source: Source;
  /** Flat background color keyed out of this sheet (detected or forced). */
  bg: string;
}

/** Scale a reference grid (measured on refW x refH) onto another sheet's dims. */
function scaleBoxes(boxes: Box[], refW: number, refH: number, w: number, h: number): Box[] {
  const sx = w / refW;
  const sy = h / refH;
  return boxes.map((b) => ({
    x: Math.round(b.x * sx),
    y: Math.round(b.y * sy),
    w: Math.max(1, Math.round(b.w * sx)),
    h: Math.max(1, Math.round(b.h * sy)),
  }));
}

function collectJobs(inDir: string, sheetFilter: string): Job[] {
  const jobs: Job[] = [];
  const sheets = allSheets();
  for (const file of readdirSync(inDir).filter((f) => f.toLowerCase().endsWith('.png'))) {
    const match = /^([a-z]+)\.([a-z0-9]+)\.png$/i.exec(file);
    if (!match) continue;
    const tier = match[1].toLowerCase();
    const name = `${tier}.${match[2].toLowerCase()}`;
    const sheet = sheets.find((s) => s.name === name);
    if (sheet === undefined) {
      process.stderr.write(`Skipping ${file}: unknown sheet "${name}".\n`);
      continue;
    }
    if (sheetFilter.length > 0 && name !== sheetFilter) continue;

    const path = join(inDir, file);
    const { w, h } = dimensions(path);
    const bg = detectBackgroundColor(path, w, h);
    const raw = GRID_MODE ? null : detectGrid(chromaMask(path, bg));
    jobs.push({ file: path, tier, sheet, w, h, raw, boxes: [], source: 'even-grid', bg });
  }
  return jobs;
}

/**
 * Resolve each job's boxes. Sheets that self-detect use their own grid; those
 * that can't (e.g. a fully blank edge row that merges into the margin) reuse the
 * grid from another sheet of the same tier, since every sheet shares the same
 * grid layout -- this keeps a state's frames registered even when one sheet
 * couldn't be measured. Tiers with no detectable sheet fall back to an even
 * split.
 */
function resolveBoxes(jobs: Job[]): void {
  for (const job of jobs) {
    if (job.raw !== null) {
      job.boxes = job.raw;
      job.source = 'detected';
      continue;
    }
    const ref = jobs.find((j) => j.tier === job.tier && j.raw !== null);
    if (ref !== undefined && ref.raw !== null) {
      job.boxes = scaleBoxes(ref.raw, ref.w, ref.h, job.w, job.h);
      job.source = 'reference';
    } else {
      job.boxes = evenGrid(job.w, job.h);
      job.source = 'even-grid';
    }
  }
}

/**
 * Shared output canvas for every frame: width TARGET_PX, height from the median
 * cell aspect across all detected boxes (so one off sheet can't skew it). The
 * renderer scales each state to the same cell width, so a common canvas keeps
 * heads the same size; cells are uniform, so filling it introduces no padding.
 */
function computeCanvas(jobs: Job[]): Canvas {
  const aspects: number[] = [];
  for (const job of jobs) {
    for (const box of job.boxes) {
      if (box.w > 0) aspects.push(box.h / box.w);
    }
  }
  const aspect = median(aspects);
  return { w: TARGET_PX, h: aspect > 0 ? Math.round(TARGET_PX * aspect) : TARGET_PX };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.set.length === 0) {
    process.stderr.write('Error: --set <name> is required.\n');
    process.exit(1);
  }
  const outDir = opts.out.length > 0 ? opts.out : defaultOut(opts.set);

  if (opts.check) {
    runCheck(outDir);
    return;
  }

  if (opts.in.length === 0) {
    process.stderr.write('Error: --in <sheets-dir> is required (or use --check).\n');
    process.exit(1);
  }
  if (!existsSync(opts.in)) {
    process.stderr.write(`Error: --in directory not found: ${opts.in}\n`);
    process.exit(1);
  }
  ensureMagick();

  const jobs = collectJobs(opts.in, opts.sheet);
  resolveBoxes(jobs);
  const canvas = computeCanvas(jobs);

  let totalFrames = 0;
  let sheetsDone = 0;
  for (const job of jobs) {
    const written = sliceSheet(job.file, job.sheet, job.boxes, canvas, outDir, job.bg);
    process.stdout.write(`${job.file} -> ${written} frame(s) [${job.source}, bg ${job.bg}]\n`);
    totalFrames += written;
    sheetsDone++;
  }
  process.stdout.write(
    `\nDone: ${sheetsDone} sheet(s), ${totalFrames} frame(s) at ${canvas.w}x${canvas.h} -> ${outDir}\n`,
  );
  if (sheetsDone === 0) process.stdout.write('No matching <tier>.<n>.png sheets found in --in.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
