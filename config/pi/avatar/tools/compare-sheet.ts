#!/usr/bin/env node
/**
 * Build a self-contained A/B/C comparison HTML page over the per-cell PNGs that
 * gen-comfyui.ts writes under avatar-ref/gen/<model>/<state>.<frame>.png, so you
 * can eyeball identity / style / quality across image models side by side.
 *
 * Node 24 runs this directly (`node compare-sheet.ts`, type stripping is on).
 *
 * The page is a matrix: one ROW per (state, frame) in sprite-manifest.ts order,
 * one COLUMN per model directory found under the gen root. A row is included
 * only when at least one model produced that cell, so partial A/B/C runs render
 * cleanly. Missing cells in a row show an empty placeholder.
 *
 * Usage:
 *   node compare-sheet.ts [--dir <gen-root>] [--out <file.html>] [--group <name>]
 *                         [--models a,b,c] [--link]
 *
 *   --dir <dir>     Root holding per-model subdirs (default: avatar-ref/gen).
 *   --out <file>    Output HTML path (default: compare.html in the cwd).
 *   --group <name>  Only include this manifest group.
 *   --models a,b,c  Explicit model columns / order (default: every subdir, sorted).
 *   --link          Reference PNGs by file:// path instead of embedding base64.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GROUPS, frameCount, frameDescriptions } from './sprite-manifest.ts';

const DEFAULT_DIR = 'avatar-ref/gen';

interface Opts {
  dir: string;
  out: string;
  group: string;
  models: string[];
  embed: boolean;
}

/** One (state, frame) row, with the per-model image sources aligned to a model list. */
export interface CompareRow {
  group: string;
  state: string;
  frame: number;
  /** Frame description from the manifest (used as a tooltip). */
  desc: string;
  /** Image source per model column (data URI or file:// link); '' when missing. */
  cells: string[];
}

/** Everything the pure HTML builder needs. */
export interface CompareData {
  title: string;
  models: string[];
  rows: CompareRow[];
}

function printHelp(): void {
  process.stdout.write(
    [
      'compare-sheet - A/B/C model-comparison page over avatar-ref/gen/<model>/ outputs',
      '',
      'Usage:',
      '  node compare-sheet.ts [--dir <gen-root>] [--out <file.html>] [--group <name>]',
      '                        [--models a,b,c] [--link]',
      '',
      'Flags:',
      '  --dir <dir>     Root holding per-model subdirs (default: avatar-ref/gen).',
      '  --out <file>    Output HTML path (default: compare.html in the cwd).',
      '  --group <name>  Only include this manifest group.',
      '  --models a,b,c  Explicit model columns / order (default: every subdir, sorted).',
      '  --link          Reference PNGs by file:// path instead of embedding base64.',
      '  -h, --help      Show this help.',
      '',
      `Groups: ${Object.keys(GROUPS).join(', ')}`,
    ].join('\n') + '\n',
  );
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { dir: DEFAULT_DIR, out: '', group: '', models: [], embed: true };
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
      case '--dir':
        opts.dir = next();
        break;
      case '--out':
        opts.out = next();
        break;
      case '--group':
        opts.group = next().toLowerCase();
        break;
      case '--models':
        opts.models = splitList(next());
        break;
      case '--link':
        opts.embed = false;
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        process.exit(1);
    }
  }
  return opts;
}

/** Model subdirs present under the gen root, sorted. */
function discoverModels(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function frameSrc(path: string, embed: boolean): string {
  if (!embed) return `file://${resolve(path)}`;
  try {
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * Walk the manifest in group / state / frame order and resolve each model's PNG.
 * Rows with no image in any model are dropped.
 */
function collectRows(dir: string, models: string[], opts: Opts): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const [groupName, group] of Object.entries(GROUPS)) {
    if (opts.group.length > 0 && groupName !== opts.group) continue;
    for (const state of group.states) {
      const descs = frameDescriptions(groupName, state);
      const frames = frameCount(groupName, state);
      for (let frame = 0; frame < frames; frame++) {
        const cells: string[] = [];
        let any = false;
        for (const model of models) {
          const file = join(dir, model, `${state}.${frame}.png`);
          const src = existsSync(file) ? frameSrc(file, opts.embed) : '';
          if (src.length > 0) any = true;
          cells.push(src);
        }
        if (any) {
          rows.push({ group: groupName, state, frame, desc: descs.at(frame) ?? '', cells });
        }
      }
    }
  }
  return rows;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return '&quot;';
    }
  });
}

function renderCell(src: string): string {
  if (src.length === 0) return '<td class="cell"><div class="missing">—</div></td>';
  return `<td class="cell"><img class="shot" src="${src}" alt="" loading="lazy"></td>`;
}

function renderRow(row: CompareRow): string {
  const label = `${escapeHtml(row.state)} <span class="frame">f${row.frame}</span>`;
  const cells = row.cells.map(renderCell).join('');
  return `<tr><th class="rowhead" title="${escapeHtml(row.desc)}">${label}</th>${cells}</tr>`;
}

const PAGE_CSS = `
:root { --size: 160px; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif; background: #121212; color: #e6e6e6; }
header { position: sticky; top: 0; z-index: 6; display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  padding: 12px 20px; background: #1c1c1cee; backdrop-filter: blur(6px); border-bottom: 1px solid #333; }
header h1 { font-size: 15px; margin: 0 12px 0 0; font-weight: 600; }
header h1 small { color: #888; font-weight: 400; }
header label { display: flex; gap: 6px; align-items: center; color: #bdbdbd; }
.wrap { padding: 8px 20px 40px; overflow: auto; }
table { border-collapse: separate; border-spacing: 0; }
th, td { padding: 6px; border-bottom: 1px solid #2a2a2a; }
thead th { position: sticky; top: 52px; z-index: 4; background: #1b1b1b; color: #e6e6e6; text-align: center;
  text-transform: capitalize; border-bottom: 1px solid #333; }
thead th.corner { left: 0; z-index: 5; }
.rowhead { position: sticky; left: 0; z-index: 3; background: #181818; text-align: right; white-space: nowrap;
  font-weight: 600; vertical-align: middle; }
.rowhead .frame { color: #888; font-weight: 400; font-variant-numeric: tabular-nums; margin-left: 4px; }
.grouprow th { position: sticky; left: 0; background: #222; color: #9ad; text-transform: capitalize;
  text-align: left; font-weight: 600; border-top: 2px solid #333; }
.cell { text-align: center; vertical-align: middle; }
.shot { width: var(--size); height: var(--size); object-fit: contain; image-rendering: pixelated;
  border-radius: 6px; background: transparent; }
.missing { width: var(--size); height: var(--size); display: flex; align-items: center; justify-content: center;
  color: #555; border: 1px dashed #333; border-radius: 6px; }
body.checker .shot, body.checker .missing { background-color: #2a2a2a;
  background-image: linear-gradient(45deg, #333 25%, transparent 25%), linear-gradient(-45deg, #333 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #333 75%), linear-gradient(-45deg, transparent 75%, #333 75%);
  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
`.trim();

const PAGE_JS = `
(function () {
  var size = document.getElementById('size');
  if (size) size.addEventListener('input', function () {
    document.documentElement.style.setProperty('--size', this.value + 'px');
  });
  var checker = document.getElementById('checker');
  if (checker) checker.addEventListener('change', function () {
    document.body.classList.toggle('checker', this.checked);
  });
})();
`.trim();

/** Render the full comparison page. Pure: takes resolved sources, returns HTML. */
export function buildCompareHtml(data: CompareData): string {
  const headCols = data.models.map((model) => `<th>${escapeHtml(model)}</th>`).join('');
  const span = data.models.length + 1;

  const body: string[] = [];
  let lastGroup = '';
  for (const row of data.rows) {
    if (row.group !== lastGroup) {
      body.push(`<tr class="grouprow"><th colspan="${span}">${escapeHtml(row.group)}</th></tr>`);
      lastGroup = row.group;
    }
    body.push(renderRow(row));
  }

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(data.title)}</title>`,
    `<style>${PAGE_CSS}</style>`,
    '</head><body>',
    '<header>',
    `<h1>${escapeHtml(data.title)} <small>${data.rows.length} cells · ${data.models.length} models</small></h1>`,
    '<label>Size <input id="size" type="range" min="64" max="320" step="8" value="160"></label>',
    '<label><input id="checker" type="checkbox"> Checker</label>',
    '</header>',
    '<div class="wrap"><table>',
    `<thead><tr><th class="corner">state</th>${headCols}</tr></thead>`,
    `<tbody>${body.join('\n')}</tbody>`,
    '</table></div>',
    `<script>${PAGE_JS}</script>`,
    '</body></html>',
  ].join('\n');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.dir;
  if (!existsSync(dir)) {
    process.stderr.write(`Gen root not found: ${dir}\n`);
    process.exit(1);
  }

  const found = discoverModels(dir);
  const models = opts.models.length > 0 ? opts.models : found;
  if (models.length === 0) {
    process.stderr.write(`No model subdirectories found under ${dir}\n`);
    process.exit(1);
  }

  const rows = collectRows(dir, models, opts);
  if (rows.length === 0) {
    process.stderr.write(`No matching <state>.<frame>.png cells found under ${dir}\n`);
    process.exit(1);
  }

  const title = `avatar compare - ${dir}`;
  const out = opts.out.length > 0 ? opts.out : 'compare.html';
  writeFileSync(out, buildCompareHtml({ title, models, rows }));
  process.stdout.write(`Wrote ${out} (${rows.length} cells across ${models.length} model(s)) from ${dir}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
