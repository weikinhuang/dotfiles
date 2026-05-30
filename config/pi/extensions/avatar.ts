/**
 * `avatar` - a reactive avatar widget for pi.
 *
 * Two things drive the avatar:
 *
 *   1. **Activity (automatic).** Lifecycle events animate sprite states -
 *      `hi` on session start, `idle` (with blink), `think`, `talk`,
 *      `read` / `write` / `tool` (cycling), `failure`, `compact`.
 *   2. **Emotion (LLM-triggered).** The model emits a self-closing
 *      `[emote:happy]` marker inline in its reply; the marker is stripped
 *      from the visible text (and scrubbed from history) and switches the
 *      avatar to that emotion sprite for `emoteHoldMs`, overriding the
 *      activity animation. This reuses the `color-tags` rewrite/scrub
 *      pattern (`before_agent_start` + `message_update` + `context`).
 *
 * Rendering is intentionally minimal: direct kitty graphics, direct iTerm2
 * inline images, and sixel (Windows Terminal >= 1.22), with a kaomoji
 * (ASCII) fallback. The ASCII set is also used inside tmux / screen (image
 * passthrough is not implemented yet) and whenever the resolved sprite set
 * ships no PNG frames. The pure logic - config layering, model->set glob
 * resolution, marker parsing, escape encoders, PNG sizing + decode, sixel
 * encoding, terminal detection - lives under `lib/node/pi/avatar/` and is
 * unit-tested; only the pi-coupled glue (widget, timers, event wiring)
 * lives here.
 *
 * Sprites resolve project -> user -> shipped:
 *   <cwd>/.pi/avatar/emotes/<set>/
 *   <piAgentDir>/avatar/emotes/<set>/
 *   config/pi/avatar/emotes/<set>/  (shipped; falls back to `default`)
 *
 * Config layers (lowest -> highest): shipped defaults ->
 * <piAgentDir>/avatar.json -> <cwd>/.pi/avatar.json.
 *
 * Environment:
 *   PI_AVATAR_DISABLED=1    skip the extension entirely
 *   PI_AVATAR_NO_PROMPT=1   keep the avatar, drop the [emote:] prompt addendum
 *   PI_AVATAR_RENDER=...     force a protocol (kitty|iterm2|sixel|halfblock|ascii); overrides config
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { getCellDimensions, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { coerceConfigLayer, mergeConfigLayers } from '../../../lib/node/pi/avatar/config.ts';
import { parseSimpleYaml } from '../../../lib/node/pi/avatar/ascii-yaml.ts';
import { classifyStateDirs, isActivityState, pickRandom, resolveEmoteSet } from '../../../lib/node/pi/avatar/emotes.ts';
import { encodeITermImage, encodeKittyImage } from '../../../lib/node/pi/avatar/encode.ts';
import { encodeHalfblock } from '../../../lib/node/pi/avatar/halfblock.ts';
import { decodePng } from '../../../lib/node/pi/avatar/png-decode.ts';
import { SIXEL_IMAGE_LINE_MARKER, encodeSixel, resizeNearest } from '../../../lib/node/pi/avatar/sixel.ts';
import {
  appendEmotePrompt,
  buildEmotePromptAddendum,
  parseEmoteMarkers,
  stripEmoteMarkers,
} from '../../../lib/node/pi/avatar/markers.ts';
import { readPngDimensions } from '../../../lib/node/pi/avatar/png.ts';
import { isInTmux, wrapForTmux } from '../../../lib/node/pi/avatar/tmux.ts';
import { resolveProtocol } from '../../../lib/node/pi/avatar/terminal.ts';
import { formatToolTally, toolNameToState } from '../../../lib/node/pi/avatar/state.ts';
import type { ActivityState, AvatarConfig, Protocol } from '../../../lib/node/pi/avatar/types.ts';
import { piAgentPath, piProjectPath } from '../../../lib/node/pi/pi-paths.ts';
import { fmtSi } from '../../../lib/node/pi/token-format.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

type RenderedFrame =
  | { kind: 'image'; sequence: string; rows: number; style: 'kitty' | 'iterm2' | 'sixel' }
  | { kind: 'halfblock'; cells: string[]; rows: number }
  | { kind: 'text'; lines: string[] };

interface LoadedState {
  frames: RenderedFrame[];
}
type FrameStore = Map<string, LoadedState>;

interface BuiltStore {
  store: FrameStore;
  emotions: string[];
}

/** Minimal shape of a mutable assistant content part we rewrite/scrub. */
interface MutablePart {
  type?: string;
  text?: string;
  thinking?: string;
}
interface MutableMessage {
  role?: string;
  content?: MutablePart[];
}

/** Minimal shape read off `ctx.model` for the info panel. */
interface ModelInfo {
  id?: string;
  name?: string;
  reasoning?: boolean;
}

/** Minimal shape of a session entry we sum for the info panel. */
interface UsageEntry {
  type?: string;
  message?: { role?: string; usage?: { input?: number; output?: number } };
}

// ──────────────────────────────────────────────────────────────────────
// Pure-ish helpers (fs + sprite loading)
// ──────────────────────────────────────────────────────────────────────

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function loadConfig(cwd: string): AvatarConfig {
  const userLayer = coerceConfigLayer(readJson(piAgentPath('avatar.json')));
  const projectLayer = coerceConfigLayer(readJson(piProjectPath(cwd, 'avatar.json')));
  return mergeConfigLayers(userLayer, projectLayer);
}

function findSetDir(setName: string, extEmotesDir: string, cwd: string): string {
  const candidates = [
    piProjectPath(cwd, 'avatar', 'emotes', setName),
    piAgentPath('avatar', 'emotes', setName),
    join(extEmotesDir, setName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(extEmotesDir, 'default');
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listPngs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.png'))
      .sort();
  } catch {
    return [];
  }
}

function imageRows(
  dims: { width: number; height: number },
  cols: number,
  cell: { widthPx: number; heightPx: number },
): number {
  if (dims.width <= 0 || cell.heightPx <= 0) return Math.max(1, Math.round(cols / 2));
  const scaledHeightPx = (dims.height * (cols * cell.widthPx)) / dims.width;
  return Math.max(1, Math.round(scaledHeightPx / cell.heightPx));
}

function buildImageFrame(
  pngPath: string,
  protocol: Protocol,
  cols: number,
  cell: { widthPx: number; heightPx: number },
): RenderedFrame | null {
  let data: Buffer;
  try {
    data = readFileSync(pngPath);
  } catch {
    return null;
  }
  const dims = readPngDimensions(data) ?? { width: 1, height: 1 };
  const rows = imageRows(dims, cols, cell);
  if (protocol === 'halfblock') {
    // Half-block packs two pixel rows into one cell-row, so target 2*rows px tall.
    const decoded = decodePng(data);
    if (!decoded) return null;
    const cells = encodeHalfblock(resizeNearest(decoded, cols, rows * 2));
    return { kind: 'halfblock', cells, rows: cells.length };
  }
  const inTmux = isInTmux(process.env);
  if (protocol === 'sixel') {
    // Sixel ships actual pixels: decode, scale to the on-screen footprint, encode.
    const decoded = decodePng(data);
    if (!decoded) return null;
    const dstW = Math.max(1, Math.round(cols * cell.widthPx));
    const dstH = Math.max(1, Math.round((decoded.height * dstW) / decoded.width));
    const inner = encodeSixel(resizeNearest(decoded, dstW, dstH));
    // Wrap only the DCS payload for tmux; the marker stays outside so pi-tui
    // still sees `\x1b_G` at line start and skips its width guard. Outside
    // tmux, the marker still sits in front of the bare sixel as before.
    const wrapped = inTmux ? wrapForTmux(inner) : inner;
    const sequence = SIXEL_IMAGE_LINE_MARKER + wrapped;
    return { kind: 'image', sequence, rows, style: 'sixel' };
  }
  const base64 = data.toString('base64');
  const size = { cols, rows };
  // Kitty (`\x1b_G`) and iTerm2 (`\x1b]1337;File=`) lines stay recognised by
  // pi-tui's `isImageLine` even when wrapped, because the doubled-ESC encoding
  // preserves the protocol prefix as a substring.
  if (protocol === 'iterm2') {
    const raw = encodeITermImage(base64, size, data.length);
    return { kind: 'image', sequence: inTmux ? wrapForTmux(raw) : raw, rows, style: 'iterm2' };
  }
  const raw = encodeKittyImage(base64, size);
  return { kind: 'image', sequence: inTmux ? wrapForTmux(raw) : raw, rows, style: 'kitty' };
}

function discoverImageStore(setDir: string, protocol: Protocol, cols: number): BuiltStore {
  const cell = getCellDimensions();
  const { activities, emotions } = classifyStateDirs(listSubdirs(setDir));
  const store: FrameStore = new Map();
  for (const state of [...activities, ...emotions]) {
    const frames: RenderedFrame[] = [];
    for (const file of listPngs(join(setDir, state))) {
      const frame = buildImageFrame(join(setDir, state, file), protocol, cols, cell);
      if (frame) frames.push(frame);
    }
    if (frames.length > 0) store.set(state, { frames });
  }
  return { store, emotions: emotions.filter((name) => store.has(name)) };
}

function asciiFramesToLines(value: string | string[] | Record<string, string>): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return Object.values(value);
}

function discoverAsciiStore(setDir: string, extEmotesDir: string): BuiltStore {
  const candidates = [join(setDir, 'ascii.yaml'), join(extEmotesDir, 'ascii', 'ascii.yaml')];
  let text: string | null = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      text = readFileSync(candidate, 'utf8');
      break;
    } catch {
      /* try next candidate */
    }
  }

  const store: FrameStore = new Map();
  const emotions: string[] = [];
  if (text === null) return { store, emotions };

  for (const [state, value] of Object.entries(parseSimpleYaml(text))) {
    const texts = asciiFramesToLines(value);
    if (texts.length === 0) continue;
    const frames: RenderedFrame[] = texts.map((frameText) => ({ kind: 'text', lines: frameText.split('\n') }));
    store.set(state, { frames });
    if (!isActivityState(state)) emotions.push(state);
  }
  emotions.sort();
  return { store, emotions };
}

// ──────────────────────────────────────────────────────────────────────
// Renderer - holds the loaded frames and the currently-shown frame
// ──────────────────────────────────────────────────────────────────────

class AvatarRenderer {
  private tui: TUI | null = null;
  private store: FrameStore = new Map();
  private current: RenderedFrame | null = null;

  setTui(tui: TUI | null): void {
    this.tui = tui;
  }

  setStore(store: FrameStore): void {
    this.store = store;
    this.current = null;
  }

  getFrame(): RenderedFrame | null {
    return this.current;
  }

  has(state: string): boolean {
    return this.store.has(state);
  }

  count(state: string): number {
    return this.store.get(state)?.frames.length ?? 0;
  }

  showIndex(state: string, index: number): boolean {
    const loaded = this.store.get(state);
    if (!loaded || loaded.frames.length === 0) return false;
    const length = loaded.frames.length;
    const wrapped = ((index % length) + length) % length;
    this.current = loaded.frames[wrapped];
    this.tui?.requestRender();
    return true;
  }

  showRandom(state: string): boolean {
    const loaded = this.store.get(state);
    if (!loaded || loaded.frames.length === 0) return false;
    const frame = pickRandom(loaded.frames);
    if (!frame) return false;
    this.current = frame;
    this.tui?.requestRender();
    return true;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Animator - timer-driven state machine over the renderer
// ──────────────────────────────────────────────────────────────────────

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

class Animator {
  currentState = 'idle';
  private emotionActive = false;
  private cycleIndex = 0;
  private cycleDir = 1;

  private holdTimer: Timer | null = null;
  private altTimer: Timer | null = null;
  private altRestore: Timer | null = null;
  private emotionTimer: Timer | null = null;
  private cycleTimer: Interval | null = null;

  private readonly renderer: AvatarRenderer;
  private config: AvatarConfig;

  constructor(renderer: AvatarRenderer, config: AvatarConfig) {
    this.renderer = renderer;
    this.config = config;
  }

  updateConfig(config: AvatarConfig): void {
    this.config = config;
  }

  setTui(tui: TUI | null): void {
    this.renderer.setTui(tui);
  }

  getFrame(): RenderedFrame | null {
    return this.renderer.getFrame();
  }

  clearTimers(): void {
    this.clearStateTimers();
    this.emotionActive = false;
  }

  private clearStateTimers(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.altTimer) clearTimeout(this.altTimer);
    if (this.altRestore) clearTimeout(this.altRestore);
    if (this.emotionTimer) clearTimeout(this.emotionTimer);
    if (this.cycleTimer) clearInterval(this.cycleTimer);
    this.holdTimer = null;
    this.altTimer = null;
    this.altRestore = null;
    this.emotionTimer = null;
    this.cycleTimer = null;
  }

  /** Public activity transition; ignored while an emotion overlay holds. */
  transitionTo(state: ActivityState): void {
    if (this.emotionActive) return;
    this.applyState(state);
  }

  private applyState(state: ActivityState): void {
    this.clearStateTimers();
    this.currentState = state;
    switch (state) {
      case 'hi':
        this.renderer.showRandom('hi');
        this.holdTimer = setTimeout(() => this.applyState('idle'), this.config.holdDuration.hi);
        break;
      case 'idle':
        this.enterAlt('idle');
        break;
      case 'wait':
        // After the user submits, before the first token streams back.
        this.enterAlt(this.renderer.has('wait') ? 'wait' : 'think');
        break;
      case 'think':
        this.enterAlt('think');
        break;
      case 'talk':
        this.enterCycle('talk', this.config.talkTickMs);
        break;
      case 'read':
      case 'write':
      case 'tool':
        this.enterCycle(state, this.config.cycleMs);
        break;
      case 'success':
        this.enterHold('success', this.config.holdDuration.success);
        break;
      case 'failure':
        this.enterHold('failure', this.config.holdDuration.failure);
        break;
      case 'compact':
        this.renderer.showRandom('compact');
        break;
    }
  }

  /** Show the base frame and occasionally flip to the alt frame (idle blink / think swap). */
  private enterAlt(state: ActivityState): void {
    this.renderer.showIndex(state, 0);
    this.scheduleAlt(state);
  }

  private scheduleAlt(state: ActivityState): void {
    const delay = randomInRange(this.config.blinkInterval[0], this.config.blinkInterval[1]);
    this.altTimer = setTimeout(() => {
      if (this.currentState !== state) return;
      if (this.renderer.count(state) < 2) {
        this.scheduleAlt(state);
        return;
      }
      this.renderer.showIndex(state, 1);
      this.altRestore = setTimeout(() => {
        if (this.currentState !== state) return;
        this.renderer.showIndex(state, 0);
        this.scheduleAlt(state);
      }, 180);
    }, delay);
  }

  private enterCycle(state: string, intervalMs: number): void {
    this.cycleIndex = 0;
    this.cycleDir = 1;
    this.renderer.showIndex(state, 0);
    const count = this.renderer.count(state);
    if (count <= 1) return;
    this.cycleTimer = setInterval(() => {
      if (this.currentState !== state) return;
      this.cycleIndex += this.cycleDir;
      if (this.cycleIndex >= count - 1) this.cycleDir = -1;
      if (this.cycleIndex <= 0) this.cycleDir = 1;
      this.renderer.showIndex(state, this.cycleIndex);
    }, intervalMs);
  }

  private enterHold(state: ActivityState, durationMs: number): void {
    this.renderer.showRandom(state);
    this.holdTimer = setTimeout(() => this.applyState('idle'), durationMs);
  }

  /** Release a held emotion overlay so activity transitions resume (e.g. at the next turn). */
  releaseEmotion(): void {
    if (!this.emotionActive) return;
    if (this.emotionTimer) clearTimeout(this.emotionTimer);
    this.emotionTimer = null;
    this.emotionActive = false;
  }

  /**
   * Switch to an LLM-triggered emotion overlay, blocking activity
   * transitions. A positive `emoteHoldMs` reverts to `idle` after that
   * long; a value `<= 0` holds the emotion until the next turn releases
   * it (roleplay mode). Returns false when the set has no frames for `name`.
   */
  enterEmotion(name: string): boolean {
    if (!this.renderer.has(name)) return false;
    this.clearStateTimers();
    this.emotionActive = true;
    this.currentState = name;
    this.cycleIndex = 0;
    this.cycleDir = 1;
    this.renderer.showIndex(name, 0);
    const count = this.renderer.count(name);
    if (count > 1) {
      this.cycleTimer = setInterval(() => {
        if (this.currentState !== name) return;
        this.cycleIndex += this.cycleDir;
        if (this.cycleIndex >= count - 1) this.cycleDir = -1;
        if (this.cycleIndex <= 0) this.cycleDir = 1;
        this.renderer.showIndex(name, this.cycleIndex);
      }, this.config.cycleMs);
    }
    if (this.config.emoteHoldMs > 0) {
      this.emotionTimer = setTimeout(() => {
        this.emotionActive = false;
        this.applyState('idle');
      }, this.config.emoteHoldMs);
    }
    return true;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Marker rewriting (live) + scrubbing (history)
// ──────────────────────────────────────────────────────────────────────

/** Strip `[emote:NAME]` markers from assistant text parts in place; return the names found. */
function applyEmoteMarkers(message: MutableMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const names: string[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text.length > 0) {
      const parsed = parseEmoteMarkers(part.text);
      if (parsed.emotes.length > 0) {
        part.text = parsed.text;
        names.push(...parsed.emotes);
      }
    }
  }
  return names;
}

/** Remove `[emote:NAME]` markers from outgoing assistant context messages. */
function scrubContextMessages(messages: MutableMessage[]): { messages: MutableMessage[] } | undefined {
  let changed = false;
  const next = messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
    let partChanged = false;
    const content = message.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const replacement: MutablePart = Object.assign({}, part);
      if (typeof part.text === 'string' && part.text.includes('[emote:')) {
        replacement.text = stripEmoteMarkers(part.text);
        partChanged = true;
      }
      if (typeof part.thinking === 'string' && part.thinking.includes('[emote:')) {
        replacement.thinking = stripEmoteMarkers(part.thinking);
        partChanged = true;
      }
      return replacement;
    });
    if (partChanged) {
      changed = true;
      return Object.assign({}, message, { content });
    }
    return message;
  });
  return changed ? { messages: next } : undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Widget rendering
// ──────────────────────────────────────────────────────────────────────

function thinkingLevel(pi: ExtensionAPI): string | undefined {
  try {
    return pi.getThinkingLevel();
  } catch {
    return undefined;
  }
}

function buildInfoLines(
  width: number,
  config: AvatarConfig,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  toolCounts: ReadonlyMap<string, number>,
  state: string,
): string[] {
  const lines: string[] = [];
  const model = ctx.model as ModelInfo | undefined;
  let modelStr = model?.name ?? 'no model';
  const level = thinkingLevel(pi);
  if (model?.reasoning === true && level !== undefined) modelStr += ` \u2022 ${level}`;
  if (state.length > 0) modelStr += ` \u2022 ${state}`;
  lines.push(modelStr);

  const usage = ctx.getContextUsage();
  if (usage) {
    const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : '?';
    const tokens = usage.tokens !== null ? fmtSi(usage.tokens) : '?';
    lines.push(`Context: ${tokens}/${fmtSi(usage.contextWindow)} (${pct})`);
  }

  let input = 0;
  let output = 0;
  try {
    const entries = ctx.sessionManager.getEntries() as unknown as UsageEntry[];
    for (const entry of entries) {
      if (entry.type === 'message' && entry.message?.role === 'assistant') {
        input += entry.message.usage?.input ?? 0;
        output += entry.message.usage?.output ?? 0;
      }
    }
  } catch {
    /* session entries unavailable - skip the usage rows */
  }
  lines.push(`\u2191${fmtSi(input)} \u2193${fmtSi(output)}`);
  lines.push(formatToolTally(toolCounts));

  const infoWidth = Math.max(4, width - config.size - 5);
  return lines.map((line) => (visibleWidth(line) > infoWidth ? truncateToWidth(line, infoWidth, '\u2026') : line));
}

function renderKittyFrame(
  frame: RenderedFrame & { kind: 'image' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const avatarPad = ' '.repeat(size);
  const lines: string[] = [];
  for (let i = 0; i < frame.rows; i++) {
    const head = i === 0 ? ` ${frame.sequence}${avatarPad}` : ` ${avatarPad}`;
    lines.push(`${head} ${sep} ${info[i] ?? ''}`);
  }
  return lines;
}

function renderITermFrame(
  frame: RenderedFrame & { kind: 'image' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const skipPad = `\x1b[${1 + size}C`;
  const lines: string[] = [];
  for (let i = 0; i < frame.rows; i++) {
    if (i < frame.rows - 1) {
      lines.push(`${skipPad} ${sep} ${info[i] ?? ''}`);
    } else {
      const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : '';
      lines.push(`${up}\x1b[1C${frame.sequence} ${sep} ${info[i] ?? ''}`);
    }
  }
  return lines;
}

/**
 * Render a sixel avatar frame. Unlike kitty / iTerm2 (whose terminals track the
 * image as an object and advance the cursor for us), sixel paints raw pixels
 * into the cell grid, so the layout has to cooperate with pi-tui's differential
 * renderer:
 *
 *   - Info text sits to the right of the image and is positioned with
 *     cursor-forward (`CSI n C`), not spaces - spaces would draw over (and so
 *     erase) the image pixels.
 *   - The sixel is painted on the LAST emitted line, after pi-tui has issued its
 *     per-line `\x1b[2K` erases for the block; painting on an earlier line would
 *     get wiped by the next line's erase. `\x1b[{rows-1}A` walks the cursor up
 *     to the top of the reserved block so the image paints downward over it.
 *   - Before painting, the image's cell column is cleared row-by-row with
 *     `\x1b[{n}X` (erase chars, left region only) so a previous frame's pixels
 *     do not ghost through transparent areas of the new frame.
 *   - The whole paint is wrapped in DECSC / DECRC (`\x1b7` / `\x1b8`) so the
 *     cursor returns to the end of the last line, where pi-tui's cursor model
 *     expects it. pi-tui itself does not use DECSC / DECRC.
 */
function renderSixelFrame(
  frame: RenderedFrame & { kind: 'image' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const skip = `\x1b[${1 + size}C`;
  const lines: string[] = [];
  for (let i = 0; i < frame.rows - 1; i++) {
    lines.push(`${skip} ${sep} ${info[i] ?? ''}`);
  }
  const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : '';
  const clearWidth = size + 1;
  let paint = `\x1b7\r${up}`;
  for (let r = 0; r < frame.rows; r++) {
    paint += `\x1b[${clearWidth}X`;
    if (r < frame.rows - 1) paint += '\x1b[1B';
  }
  paint += `${up}\x1b[1C${frame.sequence}\x1b8`;
  const last = frame.rows - 1;
  lines.push(`${skip} ${sep} ${info[last] ?? ''}${paint}`);
  return lines;
}

/**
 * Render a half-block (pixel-art) avatar frame. Each entry in `frame.cells`
 * is a styled string of `size` cells (one cell = two stacked pixels) and
 * already terminates with an SGR reset, so the separator and info text on
 * the right stay unstyled. No cursor gymnastics: pi-tui's `extractAnsiCode`
 * strips the SGR codes, so each cell counts as one visible column.
 */
function renderHalfblockFrame(
  frame: RenderedFrame & { kind: 'halfblock' },
  size: number,
  info: string[],
  sep: string,
): string[] {
  const blank = ' '.repeat(size);
  const lines: string[] = [];
  for (let i = 0; i < frame.rows; i++) {
    const cell = frame.cells[i] ?? blank;
    lines.push(` ${cell} ${sep} ${info[i] ?? ''}`);
  }
  return lines;
}

/** Collapse a kaomoji frame to a single ` face | tally ` line to save vertical space. */
function renderTextFrameCompact(
  frame: RenderedFrame & { kind: 'text' },
  size: number,
  tally: string,
  sep: string,
  width: number,
): string[] {
  const emote = frame.lines[0] ?? '';
  const pad = Math.max(0, size - visibleWidth(emote));
  const cell =
    emote.length > 0 ? `${' '.repeat(Math.floor(pad / 2))}${emote}${' '.repeat(Math.ceil(pad / 2))}` : ' '.repeat(size);
  const tallyWidth = Math.max(4, width - size - 4);
  const trimmed = visibleWidth(tally) > tallyWidth ? truncateToWidth(tally, tallyWidth, '\u2026') : tally;
  return [` ${cell} ${sep} ${trimmed}`];
}

function renderTextFrame(frame: RenderedFrame & { kind: 'text' }, size: number, info: string[], sep: string): string[] {
  const emoteRow = 1;
  const rowCount = Math.max(emoteRow + frame.lines.length, info.length, 3);
  const lines: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const idx = i - emoteRow;
    const emote = idx >= 0 && idx < frame.lines.length ? frame.lines[idx] : '';
    const pad = Math.max(0, size - visibleWidth(emote));
    const cell =
      emote.length > 0
        ? `${' '.repeat(Math.floor(pad / 2))}${emote}${' '.repeat(Math.ceil(pad / 2))}`
        : ' '.repeat(size);
    lines.push(` ${cell} ${sep} ${info[i] ?? ''}`);
  }
  return lines;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function avatar(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_AVATAR_DISABLED)) return;
  const promptDisabled = envTruthy(process.env.PI_AVATAR_NO_PROMPT);

  const extDir = dirname(fileURLToPath(import.meta.url));
  // Shipped assets live alongside the extensions dir at config/pi/avatar/emotes.
  const extEmotesDir = join(extDir, '..', 'avatar', 'emotes');

  let config = mergeConfigLayers();
  const renderer = new AvatarRenderer();
  const animator = new Animator(renderer, config);

  let enabled = true;
  let widgetActive = false;
  let protocol: Protocol = 'ascii';
  let emotions: string[] = [];
  let currentSet = 'default';
  let lastCwd = process.cwd();
  let lastCtx: ExtensionContext | null = null;
  const toolCounts = new Map<string, number>();

  function loadForModel(cwd: string, modelId: string): void {
    config = loadConfig(cwd);
    animator.updateConfig(config);
    const envOverride = process.env.PI_AVATAR_RENDER ?? config.render;
    protocol = resolveProtocol(envOverride, process.env);
    const resolved = resolveEmoteSet(modelId, config.emotes);
    currentSet = resolved.set;
    const setDir = findSetDir(currentSet, extEmotesDir, cwd);
    let built =
      protocol === 'ascii'
        ? discoverAsciiStore(setDir, extEmotesDir)
        : discoverImageStore(setDir, protocol, config.size);
    // Graceful fallback: a set with no PNG frames (the committed state ships
    // only the kaomoji set) renders as ASCII text regardless of protocol.
    if (built.store.size === 0 && protocol !== 'ascii') {
      built = discoverAsciiStore(setDir, extEmotesDir);
    }
    renderer.setStore(built.store);
    emotions = built.emotions;
  }

  function widgetFactory(): (tui: TUI, theme: Theme) => Component {
    return (tui, theme) => {
      animator.setTui(tui);
      return {
        render(width: number): string[] {
          if (width < config.hideBelow) return [];
          const frame = animator.getFrame();
          if (!frame || lastCtx === null) return [];
          const sep = theme.fg('border', '\u2502');
          const rule = theme.fg('border', '\u2500'.repeat(Math.max(1, width)));
          if (frame.kind === 'text' && config.compact) {
            return [rule, ...renderTextFrameCompact(frame, config.size, formatToolTally(toolCounts), sep, width)];
          }
          const info = buildInfoLines(width, config, lastCtx, pi, toolCounts, animator.currentState);
          const lines = [rule];
          if (frame.kind === 'image') {
            if (frame.style === 'sixel') {
              lines.push(...renderSixelFrame(frame, config.size, info, sep));
            } else if (frame.style === 'iterm2') {
              lines.push(...renderITermFrame(frame, config.size, info, sep));
            } else {
              lines.push(...renderKittyFrame(frame, config.size, info, sep));
            }
          } else if (frame.kind === 'halfblock') {
            lines.push(...renderHalfblockFrame(frame, config.size, info, sep));
          } else {
            lines.push(...renderTextFrame(frame, config.size, info, sep));
          }
          return lines;
        },
        invalidate(): void {
          /* nothing cached */
        },
        dispose(): void {
          animator.setTui(null);
        },
      };
    };
  }

  function mountWidget(ctx: ExtensionContext): void {
    ctx.ui.setWidget('avatar', widgetFactory(), { placement: 'aboveEditor' });
    widgetActive = true;
  }

  function unmountWidget(ctx: ExtensionContext): void {
    animator.clearTimers();
    if (widgetActive) {
      ctx.ui.setWidget('avatar', undefined);
      widgetActive = false;
    }
  }

  pi.on('session_start', (_event, ctx) => {
    animator.clearTimers();
    toolCounts.clear();
    lastCtx = ctx;
    lastCwd = ctx.cwd;
    const modelId = (ctx.model as ModelInfo | undefined)?.id ?? '';
    loadForModel(ctx.cwd, modelId);
    enabled = config.enabled;
    if (!enabled || !ctx.hasUI) return;
    mountWidget(ctx);
    animator.transitionTo('idle');
    setTimeout(() => animator.transitionTo('hi'), 500);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) unmountWidget(ctx);
    else animator.clearTimers();
    lastCtx = null;
  });

  pi.on('model_select', (event) => {
    if (!enabled) return;
    const modelId = (event.model as ModelInfo | undefined)?.id ?? '';
    loadForModel(lastCwd, modelId);
    if (widgetActive) animator.transitionTo('idle');
  });

  if (!promptDisabled) {
    pi.on('before_agent_start', (event, ctx) => {
      if (!enabled) return undefined;
      const base = event.systemPrompt.length > 0 ? event.systemPrompt : ctx.getSystemPrompt();
      return { systemPrompt: appendEmotePrompt(base, buildEmotePromptAddendum({ emotions })) };
    });
  }

  pi.on('agent_start', () => {
    if (!widgetActive) return;
    // A new turn releases any emotion held from the previous response.
    animator.releaseEmotion();
    animator.transitionTo('wait');
  });

  pi.on('message_update', (event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    const message = event.message as MutableMessage;
    const names = applyEmoteMarkers(message);
    if (!widgetActive) return;
    if (names.length > 0) {
      animator.enterEmotion(names[names.length - 1]);
      return;
    }
    const stream = event.assistantMessageEvent;
    if (stream.type === 'thinking_start' || stream.type === 'thinking_delta') {
      if (animator.currentState !== 'think') animator.transitionTo('think');
      return;
    }
    if (stream.type === 'toolcall_start') {
      const blocks = stream.partial.content;
      const block = Array.isArray(blocks) ? blocks[stream.contentIndex] : undefined;
      const name =
        block && typeof block === 'object' && 'name' in block && typeof (block as { name?: unknown }).name === 'string'
          ? (block as { name: string }).name
          : '';
      animator.transitionTo(name.length > 0 ? toolNameToState(name) : 'tool');
      return;
    }
    if (stream.type === 'text_delta' && animator.currentState !== 'talk') {
      animator.transitionTo('talk');
    }
  });

  pi.on('context', (event) => {
    if (!enabled) return undefined;
    const result = scrubContextMessages(event.messages as unknown as MutableMessage[]);
    return result ? { messages: result.messages as never } : undefined;
  });

  pi.on('tool_execution_start', (event) => {
    toolCounts.set(event.toolName, (toolCounts.get(event.toolName) ?? 0) + 1);
    if (widgetActive) animator.transitionTo(toolNameToState(event.toolName));
  });

  pi.on('tool_execution_end', (event) => {
    if (!widgetActive) return;
    animator.transitionTo(event.isError ? 'failure' : 'read');
  });

  pi.on('agent_end', () => {
    if (!widgetActive) return;
    if (animator.currentState !== 'idle' && animator.currentState !== 'hi') {
      animator.transitionTo('idle');
    }
  });

  pi.on('session_before_compact', () => {
    if (widgetActive) animator.transitionTo('compact');
  });

  pi.on('session_compact', () => {
    if (widgetActive) animator.transitionTo('idle');
  });

  pi.registerCommand('avatar', {
    description: 'Show avatar status, or `/avatar on|off` to toggle the widget for this session.',
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === 'off') {
        unmountWidget(ctx);
        ctx.ui.notify('Avatar hidden for this session', 'info');
        return;
      }
      if (arg === 'on') {
        if (!ctx.hasUI) {
          ctx.ui.notify('Avatar needs an interactive UI', 'warning');
          return;
        }
        loadForModel(ctx.cwd, (ctx.model as ModelInfo | undefined)?.id ?? '');
        mountWidget(ctx);
        animator.transitionTo('idle');
        ctx.ui.notify('Avatar shown', 'info');
        return;
      }
      if (arg.length > 0 && arg !== 'status') {
        ctx.ui.notify('Usage: /avatar [on|off]', 'error');
        return;
      }
      const emoteList = emotions.length > 0 ? emotions.join(', ') : '(none)';
      ctx.ui.notify(
        `avatar: ${widgetActive ? 'on' : 'off'} \u00b7 protocol ${protocol} \u00b7 set "${currentSet}" \u00b7 emotions: ${emoteList}`,
        'info',
      );
    },
  });
}
