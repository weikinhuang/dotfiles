#!/usr/bin/env node
/**
 * Build a self-contained HTML contact sheet for a sliced avatar emote set so
 * you can eyeball registration and animation in a browser. Character-agnostic:
 * it scans the set dir the slicer writes and groups states by sprite-manifest.ts.
 *
 * Node 24 runs this directly (`node contact-sheet.ts`, type stripping is on).
 *
 * For every state subdir it embeds the frame PNGs (base64 by default, so the
 * file is portable), shows an animated ping-pong preview plus the individual
 * frames, and reports have/expected frame counts. States not in the manifest
 * land in an "other" section.
 *
 * Usage:
 *   node contact-sheet.ts --set <name> [--out <file.html>] [--group <name>] [--link]
 *   node contact-sheet.ts --dir <set-dir> --out sheet.html
 *
 *   --set <name>    Emote set under <pi-agent>/avatar/emotes/<set> (default: default).
 *   --dir <dir>     Explicit set dir; overrides --set.
 *   --out <file>    Output HTML path (default: <set>-contact.html in the cwd).
 *   --group <name>  Only include this manifest group.
 *   --link          Reference PNGs by file:// path instead of embedding base64.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { GROUPS, frameCountForState } from './sprite-manifest.ts';

interface Opts {
  set: string;
  dir: string;
  out: string;
  group: string;
  embed: boolean;
}

interface StateEntry {
  state: string;
  /** Frame PNG sources (data URIs or file:// links), in frame order. */
  srcs: string[];
  expected: number;
}

interface GroupSection {
  name: string;
  states: StateEntry[];
}

function piAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.pi', 'agent');
}

function defaultDir(set: string): string {
  return join(piAgentDir(), 'avatar', 'emotes', set);
}

function printHelp(): void {
  process.stdout.write(
    [
      'contact-sheet - build an HTML preview of a sliced avatar emote set',
      '',
      'Usage:',
      '  node contact-sheet.ts --set <name> [--out <file.html>] [--group <name>] [--link]',
      '  node contact-sheet.ts --dir <set-dir> --out sheet.html',
      '',
      'Flags:',
      '  --set <name>    Emote set under <pi-agent>/avatar/emotes/<set> (default: default).',
      '  --dir <dir>     Explicit set dir; overrides --set.',
      '  --out <file>    Output HTML path (default: <set>-contact.html in the cwd).',
      '  --group <name>  Only include this manifest group.',
      '  --link          Reference PNGs by file:// path instead of embedding base64.',
      '  -h, --help      Show this help.',
      '',
      `Groups: ${Object.keys(GROUPS).join(', ')}`,
    ].join('\n') + '\n',
  );
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { set: 'default', dir: '', out: '', group: '', embed: true };
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
      case '--dir':
        opts.dir = next();
        break;
      case '--out':
        opts.out = next();
        break;
      case '--group':
        opts.group = next().toLowerCase();
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

/** Frame PNGs in a state dir, sorted by their numeric basename (0,1,2,...). */
function frameFiles(stateDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(stateDir).filter((file) => file.endsWith('.png'));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, n: Number.parseInt(name, 10) }))
    .sort((a, b) => (Number.isNaN(a.n) || Number.isNaN(b.n) ? a.name.localeCompare(b.name) : a.n - b.n))
    .map((entry) => join(stateDir, entry.name));
}

function frameSrc(path: string, embed: boolean): string {
  if (!embed) return `file://${resolve(path)}`;
  try {
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return '';
  }
}

function stateEntry(setDir: string, state: string, embed: boolean): StateEntry | null {
  const srcs = frameFiles(join(setDir, state))
    .map((file) => frameSrc(file, embed))
    .filter((src) => src.length > 0);
  if (srcs.length === 0) return null;
  return { state, srcs, expected: frameCountForState(state) };
}

/** State subdirs present in the set dir. */
function presentStates(setDir: string): Set<string> {
  try {
    return new Set(
      readdirSync(setDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

function collectSections(setDir: string, opts: Opts): GroupSection[] {
  const present = presentStates(setDir);
  const claimed = new Set<string>();
  const sections: GroupSection[] = [];

  for (const [groupName, group] of Object.entries(GROUPS)) {
    if (opts.group.length > 0 && groupName !== opts.group) {
      for (const state of group.states) claimed.add(state);
      continue;
    }
    const states: StateEntry[] = [];
    for (const state of group.states) {
      claimed.add(state);
      const entry = stateEntry(setDir, state, opts.embed);
      if (entry) states.push(entry);
    }
    if (states.length > 0) sections.push({ name: groupName, states });
  }

  if (opts.group.length === 0) {
    const others: StateEntry[] = [];
    for (const state of [...present].sort()) {
      if (claimed.has(state)) continue;
      const entry = stateEntry(setDir, state, opts.embed);
      if (entry) others.push(entry);
    }
    if (others.length > 0) sections.push({ name: 'other', states: others });
  }
  return sections;
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

function renderCard(entry: StateEntry): string {
  const ok = entry.expected === 0 || entry.srcs.length >= entry.expected;
  const count = entry.expected > 0 ? `${entry.srcs.length}/${entry.expected}` : `${entry.srcs.length}`;
  const frames = entry.srcs.map((src) => `<img class="frame" src="${src}" alt="">`).join('');
  return [
    '<div class="card">',
    `<div class="meta"><span class="name">${escapeHtml(entry.state)}</span>`,
    `<span class="count ${ok ? 'ok' : 'bad'}">${count}</span></div>`,
    '<div class="preview"><img class="anim" alt=""></div>',
    `<div class="frames">${frames}</div>`,
    '</div>',
  ].join('');
}

function renderSection(section: GroupSection): string {
  const cards = section.states.map(renderCard).join('\n');
  return `<section><h2>${escapeHtml(section.name)} <small>${section.states.length}</small></h2><div class="grid">${cards}</div></section>`;
}

const PAGE_CSS = `
:root { --size: 128px; --speed: 320ms; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif; background: #121212; color: #e6e6e6; }
header { position: sticky; top: 0; z-index: 5; display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  padding: 12px 20px; background: #1c1c1cee; backdrop-filter: blur(6px); border-bottom: 1px solid #333; }
header h1 { font-size: 15px; margin: 0 12px 0 0; font-weight: 600; }
header label { display: flex; gap: 6px; align-items: center; color: #bdbdbd; }
section { padding: 8px 20px 24px; }
h2 { text-transform: capitalize; border-bottom: 1px solid #333; padding-bottom: 6px; }
h2 small { color: #888; font-weight: 400; }
.grid { display: flex; flex-wrap: wrap; gap: 16px; }
.card { background: #1b1b1b; border: 1px solid #2c2c2c; border-radius: 10px; padding: 10px; }
.meta { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.name { font-weight: 600; }
.count { font-variant-numeric: tabular-nums; }
.count.ok { color: #8bc34a; }
.count.bad { color: #ff7043; }
.checker { background-color: #2a2a2a;
  background-image: linear-gradient(45deg, #333 25%, transparent 25%), linear-gradient(-45deg, #333 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #333 75%), linear-gradient(-45deg, transparent 75%, #333 75%);
  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
.preview img { width: var(--size); height: var(--size); object-fit: contain; image-rendering: pixelated; }
.preview { border-radius: 8px; overflow: hidden; }
.preview.checker, .frame.checker { }
.frames { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.frame { width: 48px; height: 48px; object-fit: contain; image-rendering: pixelated; border-radius: 4px; }
body.hide-frames .frames { display: none; }
`.trim();

const PAGE_JS = `
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var anims = cards.map(function (card) {
    var srcs = Array.prototype.map.call(card.querySelectorAll('.frame'), function (img) { return img.src; });
    var preview = card.querySelector('.anim');
    if (srcs.length > 0) preview.src = srcs[0];
    return { preview: preview, srcs: srcs, idx: 0, dir: 1 };
  });
  var playing = true, timer = null;
  function tick() {
    anims.forEach(function (a) {
      if (a.srcs.length < 2) return;
      a.idx += a.dir;
      if (a.idx >= a.srcs.length - 1) { a.idx = a.srcs.length - 1; a.dir = -1; }
      else if (a.idx <= 0) { a.idx = 0; a.dir = 1; }
      a.preview.src = a.srcs[a.idx];
    });
  }
  function restart() {
    if (timer) clearInterval(timer);
    var ms = parseInt(document.getElementById('speed').value, 10);
    document.documentElement.style.setProperty('--speed', ms + 'ms');
    if (playing) timer = setInterval(tick, ms);
  }
  document.getElementById('play').addEventListener('click', function () {
    playing = !playing; this.textContent = playing ? 'Pause' : 'Play'; restart();
  });
  document.getElementById('speed').addEventListener('input', restart);
  document.getElementById('size').addEventListener('input', function () {
    document.documentElement.style.setProperty('--size', this.value + 'px');
  });
  document.getElementById('checker').addEventListener('change', function () {
    document.querySelectorAll('.preview').forEach(function (el) { el.classList.toggle('checker', this.checked); }, this);
  });
  document.getElementById('frames').addEventListener('change', function () {
    document.body.classList.toggle('hide-frames', !this.checked);
  });
  restart();
})();
`.trim();

function renderPage(title: string, sections: GroupSection[]): string {
  const total = sections.reduce((sum, section) => sum + section.states.length, 0);
  const body = sections.map(renderSection).join('\n');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_CSS}</style>`,
    '</head><body>',
    '<header>',
    `<h1>${escapeHtml(title)} <small>${total} states</small></h1>`,
    '<button id="play">Pause</button>',
    '<label>Speed <input id="speed" type="range" min="80" max="800" step="20" value="320"></label>',
    '<label>Size <input id="size" type="range" min="48" max="256" step="8" value="128"></label>',
    '<label><input id="checker" type="checkbox"> Checker</label>',
    '<label><input id="frames" type="checkbox" checked> Frames</label>',
    '</header>',
    body,
    `<script>${PAGE_JS}</script>`,
    '</body></html>',
  ].join('\n');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const setDir = opts.dir.length > 0 ? opts.dir : defaultDir(opts.set);
  if (!existsSync(setDir)) {
    process.stderr.write(`Set dir not found: ${setDir}\n`);
    process.exit(1);
  }
  const sections = collectSections(setDir, opts);
  if (sections.length === 0) {
    process.stderr.write(`No frames found under ${setDir}\n`);
    process.exit(1);
  }
  const title = `avatar - ${opts.dir.length > 0 ? opts.dir : opts.set}`;
  const out = opts.out.length > 0 ? opts.out : `${opts.set}-contact.html`;
  writeFileSync(out, renderPage(title, sections));
  const total = sections.reduce((sum, section) => sum + section.states.length, 0);
  process.stdout.write(`Wrote ${out} (${total} states across ${sections.length} group(s)) from ${setDir}\n`);
}

main();
