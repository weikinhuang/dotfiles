/**
 * `avatar` - a reactive avatar widget for pi.
 *
 * Two things drive the avatar:
 *
 *   1. **Activity (automatic).** Lifecycle events animate sprite states -
 *      `hi` on session start, `idle` (with blink), `think`, `talk`,
 *      `read` / `write` / `tool` / `debug` / `plan` / `fetch` (cycling, by
 *      tool name), `failure`, `compact`.
 *   2. **Emotion (LLM-triggered).** The model emits a self-closing
 *      `[emote:happy]` marker inline in its reply; the marker is stripped
 *      from the visible text (and scrubbed from history) and switches the
 *      avatar to that emotion sprite for `emoteHoldMs`, overriding the
 *      activity animation. This reuses the `color-tags` rewrite/scrub
 *      pattern (`before_agent_start` + `message_update` + `context`).
 *      When an assistant message finalizes (`message_end`) the stripped
 *      emotes are persisted as an `avatar-emote` custom session entry (so
 *      a transcript still shows which emotion a reply carried) AND
 *      published on a cross-extension bus (`lib/node/pi/avatar/
 *      emote-events.ts`) so e.g. a TTS extension can colour speech with
 *      the emotion when its message named none inline. Both are gated by
 *      `PI_AVATAR_DISABLE_EMOTE_EVENTS`.
 *      The system-prompt addendum that teaches the `[emote:]` vocabulary
 *      is only injected under an active `roleplay: true` persona - it is
 *      pure roleplay flavor, so a coding / no-persona session pays no
 *      extra tokens. Activity animation (1) is event-driven and always on.
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
 *   PI_AVATAR_DISABLED=1       skip the extension entirely
 *   PI_AVATAR_NO_PROMPT=1      keep the avatar, drop the [emote:] prompt addendum
 *   PI_AVATAR_RENDER=...       force a protocol (kitty|iterm2|sixel|halfblock|ascii); overrides config
 *   PI_AVATAR_DISABLE_SCRUB=1  debug: leave `[emote:NAME]` markers in the
 *                              visible reply and in history instead of
 *                              stripping/scrubbing them. The avatar still
 *                              reacts to the markers. Same effect as the
 *                              `--avatar-no-scrub` CLI flag.
 *   PI_AVATAR_DISABLE_EMOTE_EVENTS=1  skip persisting the `avatar-emote`
 *                              session entry and emitting the emote bus
 *                              event; the avatar still animates emotions.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { getCellDimensions, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { coerceConfigLayer, mergeConfigLayers } from '../../../lib/node/pi/avatar/config.ts';
import { AVATAR_USAGE } from '../../../lib/node/pi/avatar/usage.ts';
import { getAvatarInput } from '../../../lib/node/pi/avatar/input.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import type { AsciiFrameMap } from '../../../lib/node/pi/avatar/ascii-yaml.ts';
import { mergeAsciiFrameMaps, parseSimpleYaml } from '../../../lib/node/pi/avatar/ascii-yaml.ts';
import { classifyStateDirs, isActivityState, resolveEmoteSet } from '../../../lib/node/pi/avatar/emotes.ts';
import { SixelCache, buildFrameCached } from '../../../lib/node/pi/avatar/cache.ts';
import {
  type TextMeasure,
  buildImageFrame,
  imageRows,
  renderHalfblockFrame,
  renderITermFrame,
  renderKittyFrame,
  renderSceneBanner,
  renderSixelFrame,
  renderTextFrame,
  renderTextFrameCompact,
} from '../../../lib/node/pi/avatar/render.ts';
import {
  appendEmotePrompt,
  buildEmotePromptAddendum,
  parseEmoteMarkers,
  stripEmoteMarkers,
} from '../../../lib/node/pi/avatar/markers.ts';
import {
  AVATAR_EMOTE_CHANNEL,
  AVATAR_EMOTE_ENTRY_TYPE,
  collectLoggedEmotes,
} from '../../../lib/node/pi/avatar/emote-events.ts';
import { readPngDimensions } from '../../../lib/node/pi/avatar/png.ts';
import { isInTmux } from '../../../lib/node/pi/avatar/tmux.ts';
import { resolveProtocol } from '../../../lib/node/pi/avatar/terminal.ts';
import { bashCommandToState, formatToolTally, toolNameToState } from '../../../lib/node/pi/avatar/state.ts';
import type { ActivityState, AvatarConfig, Protocol } from '../../../lib/node/pi/avatar/types.ts';
import {
  type BuiltStore,
  type FrameStore,
  type RenderedFrame,
  asciiFramesToLines,
  lazyImageState,
  readyState,
  wrapIndex,
} from '../../../lib/node/pi/avatar/store.ts';
import { piAgentPath, piProjectPath } from '../../../lib/node/pi/pi-paths.ts';
import { fmtSi } from '../../../lib/node/pi/token-format.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { isModalUiActive, resetModalUi } from '../../../lib/node/pi/ui-activity.ts';

// pi-tui's width helpers injected into the pure text renderers in render.ts.
const textMeasure: TextMeasure = { visibleWidth, truncateToWidth };

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

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

// ── Lazy frame materialisation + per-width sixel cache ───────────────────
// Frames are built (PNG decode + sixel encode, the expensive part) on first
// display, not eagerly for the whole set. Sixel sequences are additionally
// memoised to a per-set, per-width JSON file so /reload and future sessions
// skip encoding entirely. One file per width (dstW) keeps any single file
// bounded and lets a font/DPI change land in a fresh file instead of bloating
// one forever.

// Sixel cache for the currently-loaded set/width. Created in discoverImageStore,
// flushed on session_shutdown (and before any same-process rebuild).
let activeSixelCache: SixelCache | null = null;

function discoverImageStore(setDir: string, protocol: Protocol, cols: number): BuiltStore {
  const cell = getCellDimensions();
  const dstW = Math.max(1, Math.round(cols * cell.widthPx));
  // Flush any previous set's cache (guards same-process reloads), then open the
  // cache for this set/width. Sixel only - it's the sole expensive encoder.
  activeSixelCache?.flush();
  activeSixelCache =
    protocol === 'sixel' ? new SixelCache(setDir, cols, dstW, isInTmux(process.env) ? '-tmux' : '') : null;
  const cache = activeSixelCache;
  const { activities, emotions } = classifyStateDirs(listSubdirs(setDir));
  const store: FrameStore = new Map();
  for (const state of [...activities, ...emotions]) {
    const paths = listPngs(join(setDir, state)).map((file) => join(setDir, state, file));
    // Lazy: nothing is read/decoded/encoded here; frames build on first display.
    if (paths.length > 0) {
      store.set(
        state,
        lazyImageState(paths, (pngPath) => buildFrameCached(pngPath, protocol, cols, cell, cache)),
      );
    }
  }
  return { store, emotions: emotions.filter((name) => store.has(name)) };
}

function discoverAsciiStore(setNames: readonly string[], extEmotesDir: string, cwd: string): BuiltStore {
  // Layer in increasing precedence so opt-in sets' kaomoji (e.g. `mature`,
  // `exusiai`) extend the shared default rather than replacing it: shared
  // default base, then each set name (base `emote-set` first, then overlays in
  // order) as `<shipped>/ascii.yaml` + its resolved `<set-dir>/ascii.yaml`.
  // Later layers win per key, so overlays override the base set.
  const layerPaths = [join(extEmotesDir, 'ascii', 'ascii.yaml')];
  for (const setName of setNames) {
    layerPaths.push(join(extEmotesDir, setName, 'ascii.yaml'));
    layerPaths.push(join(findSetDir(setName, extEmotesDir, cwd), 'ascii.yaml'));
  }
  const seen = new Set<string>();
  const maps: AsciiFrameMap[] = [];
  for (const path of layerPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path)) continue;
    try {
      maps.push(parseSimpleYaml(readFileSync(path, 'utf8')));
    } catch {
      /* skip unreadable layer */
    }
  }

  const store: FrameStore = new Map();
  const emotions: string[] = [];
  if (maps.length === 0) return { store, emotions };

  for (const [state, value] of Object.entries(mergeAsciiFrameMaps(maps))) {
    const texts = asciiFramesToLines(value);
    if (texts.length === 0) continue;
    const frames: RenderedFrame[] = texts.map((frameText) => ({ kind: 'text', lines: frameText.split('\n') }));
    store.set(state, readyState(frames));
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
    return this.store.get(state)?.length ?? 0;
  }

  showIndex(state: string, index: number): boolean {
    // Freeze the frame while a modal is up (a real overlay, or an inline
    // custom-UI component like the /scratchpad notebook - see
    // lib/node/pi/ui-activity.ts). Advancing the frame would re-emit the
    // sprite image (sixel/kitty/iterm2) on every animation tick and scroll the
    // screen under the modal. The animation timers keep ticking as no-ops and
    // resume once the modal closes.
    if (this.tui?.hasOverlay() || isModalUiActive()) {
      return this.current !== null;
    }
    const loaded = this.store.get(state);
    if (!loaded || loaded.length === 0) return false;
    const wrapped = wrapIndex(index, loaded.length);
    const frame = loaded.frameAt(wrapped);
    if (!frame) return false;
    this.current = frame;
    this.tui?.requestRender();
    return true;
  }

  showRandom(state: string): boolean {
    // See showIndex: freeze the frame while a modal is up.
    if (this.tui?.hasOverlay() || isModalUiActive()) {
      return this.current !== null;
    }
    const loaded = this.store.get(state);
    if (!loaded || loaded.length === 0) return false;
    const frame = loaded.frameAt(Math.floor(Math.random() * loaded.length));
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
      case 'debug':
      case 'plan':
      case 'fetch':
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

/**
 * Parse `[emote:NAME]` markers from assistant text parts and return the
 * names found. When `strip` is true the markers are removed from the
 * visible text in place; when false (debug `--avatar-no-scrub`) the raw
 * markers stay in the reply while the avatar still reacts to them.
 */
function applyEmoteMarkers(message: MutableMessage, strip: boolean): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const names: string[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text.length > 0) {
      const parsed = parseEmoteMarkers(part.text);
      if (parsed.emotes.length > 0) {
        if (strip) part.text = parsed.text;
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

// ──────────────────────────────────────────────────────────────────────
// Tool -> activity-state resolution
// ──────────────────────────────────────────────────────────────────────

/** Safely read a `bash` tool's `command` string from the event args. */
function bashCommand(args: unknown): string {
  if (args !== null && typeof args === 'object' && 'command' in args) {
    const command = (args as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  return '';
}

/** Activity state for a starting tool, inspecting bash commands for known helpers. */
function resolveToolState(toolName: string, args: unknown): ActivityState {
  if (toolName === 'bash') {
    const mapped = bashCommandToState(bashCommand(args));
    if (mapped !== null) return mapped;
  }
  return toolNameToState(toolName);
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function avatar(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_AVATAR_DISABLED)) return;
  const promptDisabled = envTruthy(process.env.PI_AVATAR_NO_PROMPT);
  // Persisting the `avatar-emote` session entry + emitting the cross-extension
  // bus event is an independently-toggleable aspect; the avatar still animates
  // emotions when this is off.
  const emoteEventsDisabled = envTruthy(process.env.PI_AVATAR_DISABLE_EMOTE_EVENTS);

  pi.registerFlag('avatar-no-scrub', {
    description: 'Debug: leave [emote:NAME] markers in the reply/history instead of stripping them',
    type: 'boolean',
    default: false,
  });

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
  // When true, skip stripping/scrubbing `[emote:]` markers so they stay
  // visible for debugging. Env sets a baseline; the CLI flag (resolved at
  // session_start) can also turn it on.
  let keepRaw = envTruthy(process.env.PI_AVATAR_DISABLE_SCRUB);
  let lastCwd = process.cwd();
  let lastModelId = '';
  /**
   * The avatar-input slot `emoteSet` the sprite store was last resolved
   * against. Only a *set* change needs the expensive `loadForModel`
   * re-discovery (sixel re-encodes every frame); `image` / `scene` slot
   * updates are resolved lazily in `render()` and must NOT force a sprite
   * reload, or every generated scene banner would stall the next turn.
   */
  let loadedSlotSet: string | undefined;
  let lastCtx: ExtensionContext | null = null;
  const toolCounts = new Map<string, number>();

  // Emote markers stripped from the assistant message currently streaming,
  // accumulated in `message_update` (where the raw markers arrive) and flushed
  // on `message_end`. `msgEmotes` keeps distinct names in first-seen order;
  // `msgPrimary` tracks the most recently named one, matching the overlay the
  // avatar actually shows (it follows the latest marker).
  let msgEmotes: string[] = [];
  let msgPrimary = '';
  function resetMessageEmotes(): void {
    msgEmotes = [];
    msgPrimary = '';
  }
  // Persist this message's emotes as a session entry and publish them on the
  // cross-extension bus, then reset the per-message buffer. No-op when the
  // aspect is disabled or the message named no emotes.
  function flushMessageEmotes(): void {
    if (emoteEventsDisabled || msgEmotes.length === 0) {
      resetMessageEmotes();
      return;
    }
    const signal = {
      emote: msgPrimary || msgEmotes[msgEmotes.length - 1],
      emotes: msgEmotes.slice(),
      at: Date.now(),
    };
    resetMessageEmotes();
    try {
      pi.appendEntry(AVATAR_EMOTE_ENTRY_TYPE, signal);
    } catch {
      // appendEntry can throw before the session is fully bound; never let
      // bookkeeping break the turn.
    }
    // pi's shared bus wraps each subscriber in its own try/catch, so a broken
    // listener can't break the emit - no guard needed here.
    pi.events.emit(AVATAR_EMOTE_CHANNEL, signal);
  }

  // Cached override-image frame (the avatar-input slot's `image`). Building a
  // frame decodes + re-encodes the PNG, so cache by path+width+protocol and
  // only rebuild when the slot points somewhere new.
  let overrideFrame: RenderedFrame | null = null;
  let overrideCols = 0;
  let overrideKey = '';
  function resolveOverrideFrame(): { frame: RenderedFrame; cols: number } | null {
    if (!enabled) return null;
    const img = getAvatarInput().image;
    // ASCII mode can't render a PNG; fall through to the kaomoji sprite.
    if (!img || protocol === 'ascii') {
      overrideFrame = null;
      overrideKey = '';
      return null;
    }
    const cols = img.width && img.width > 0 ? Math.floor(img.width) : config.size;
    const key = `${protocol}:${cols}:${img.path}`;
    if (key !== overrideKey) {
      overrideKey = key;
      overrideCols = cols;
      overrideFrame = buildImageFrame(img.path, protocol, cols, getCellDimensions());
    }
    return overrideFrame ? { frame: overrideFrame, cols: overrideCols } : null;
  }

  // Cached scene-banner frame (the avatar-input slot's `scene`). An additive
  // landscape illustration rendered beside/around the avatar, height-capped to
  // `config.sceneMaxRows` with aspect preserved. Cached by path+cols+rows+protocol.
  let sceneFrame: RenderedFrame | null = null;
  let sceneCols = 0;
  let sceneKey = '';
  function buildSceneFrame(path: string, wantCols: number, maxRows: number): RenderedFrame | null {
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      return null;
    }
    const dims = readPngDimensions(data) ?? { width: 1, height: 1 };
    const cell = getCellDimensions();
    let cols = Math.max(1, wantCols);
    const rowsAtWant = imageRows(dims, cols, cell);
    // rows scale ~linearly with cols, so shrink cols to land within maxRows.
    if (rowsAtWant > maxRows) cols = Math.max(1, Math.floor((cols * maxRows) / rowsAtWant));
    sceneCols = cols;
    return buildImageFrame(path, protocol, cols, cell);
  }
  function resolveSceneFrame(width: number): { frame: RenderedFrame; cols: number } | null {
    if (!enabled) return null;
    const scene = getAvatarInput().scene;
    // ASCII mode can't render a PNG; no banner.
    if (!scene || protocol === 'ascii') {
      sceneFrame = null;
      sceneKey = '';
      return null;
    }
    const avail = Math.max(1, width - 2);
    const want = scene.width && scene.width > 0 ? Math.min(Math.floor(scene.width), avail) : avail;
    const maxRows = Math.max(1, Math.floor(config.sceneMaxRows));
    const key = `${protocol}:${want}:${maxRows}:${scene.path}`;
    if (key !== sceneKey) {
      sceneKey = key;
      sceneFrame = buildSceneFrame(scene.path, want, maxRows);
    }
    return sceneFrame ? { frame: sceneFrame, cols: sceneCols } : null;
  }

  function loadForModel(cwd: string, modelId: string): void {
    lastModelId = modelId;
    config = loadConfig(cwd);
    animator.updateConfig(config);
    const envOverride = process.env.PI_AVATAR_RENDER ?? config.render;
    protocol = resolveProtocol(envOverride, process.env);
    const resolved = resolveEmoteSet(modelId, config.emotes);
    // An external extension (roleplay) can pin a preferred set via the
    // avatar-input slot; it wins over the model-glob resolution. Overlays
    // still come from config. A non-existent set falls back gracefully
    // below (empty store -> ASCII), exactly like a model-glob set with no art.
    const slotSet = getAvatarInput().emoteSet;
    currentSet = slotSet && slotSet.length > 0 ? slotSet : resolved.set;
    loadedSlotSet = slotSet;
    const setDir = findSetDir(currentSet, extEmotesDir, cwd);
    const asciiSetNames = [currentSet, ...resolved.overlays];
    let built =
      protocol === 'ascii'
        ? discoverAsciiStore(asciiSetNames, extEmotesDir, cwd)
        : discoverImageStore(setDir, protocol, config.size);
    // Graceful fallback: a set with no PNG frames (the committed state ships
    // only the kaomoji set) renders as ASCII text regardless of protocol.
    if (built.store.size === 0 && protocol !== 'ascii') {
      built = discoverAsciiStore(asciiSetNames, extEmotesDir, cwd);
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
          const rule = theme.fg('border', '\u2500'.repeat(Math.max(1, width)));
          const sceneRes = resolveSceneFrame(width);
          const sceneLines = sceneRes ? renderSceneBanner(sceneRes.frame, sceneRes.cols) : [];
          // `replace` only hides the avatar while a scene is actually present.
          if (sceneRes && config.scenePlacement === 'replace') return [rule, ...sceneLines];

          const override = resolveOverrideFrame();
          const frame = override?.frame ?? animator.getFrame();
          if (!frame || lastCtx === null) {
            return sceneLines.length > 0 ? [rule, ...sceneLines] : [];
          }
          const drawSize = override ? override.cols : config.size;
          const sep = theme.fg('border', '\u2502');
          let avatarLines: string[];
          if (frame.kind === 'text' && config.compact) {
            avatarLines = renderTextFrameCompact(
              frame,
              config.size,
              formatToolTally(toolCounts),
              sep,
              width,
              textMeasure,
            );
          } else {
            const info = buildInfoLines(width, config, lastCtx, pi, toolCounts, animator.currentState);
            if (frame.kind === 'image') {
              if (frame.style === 'sixel') {
                avatarLines = renderSixelFrame(frame, drawSize, info, sep);
              } else if (frame.style === 'iterm2') {
                avatarLines = renderITermFrame(frame, drawSize, info, sep);
              } else {
                avatarLines = renderKittyFrame(frame, drawSize, info, sep);
              }
            } else if (frame.kind === 'halfblock') {
              avatarLines = renderHalfblockFrame(frame, drawSize, info, sep);
            } else {
              avatarLines = renderTextFrame(frame, drawSize, info, sep, textMeasure);
            }
          }
          if (sceneLines.length === 0) return [rule, ...avatarLines];
          // Divide the scene banner from the reactive face so the generated
          // image reads as a distinct region from the avatar + info column.
          return config.scenePlacement === 'below'
            ? [rule, ...avatarLines, rule, ...sceneLines]
            : [rule, ...sceneLines, rule, ...avatarLines];
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
    // A fresh session (including /reload) has no modal on screen; clear any
    // stuck modal-UI flag so the avatar can't be frozen forever if a producer
    // was torn down mid-modal. See lib/node/pi/ui-activity.ts.
    resetModalUi();
    toolCounts.clear();
    resetMessageEmotes();
    keepRaw = envTruthy(process.env.PI_AVATAR_DISABLE_SCRUB) || pi.getFlag('avatar-no-scrub') === true;
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
    activeSixelCache?.flush();
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

  pi.on('before_agent_start', (event, ctx) => {
    if (!enabled) return undefined;
    // Re-resolve the sprite set when an external extension (roleplay) has
    // changed the avatar-input slot since our last load - e.g. a persona /
    // active-character switch repointing the avatar at a new face.
    if (getAvatarInput().emoteSet !== loadedSlotSet) {
      loadForModel(lastCwd, lastModelId);
    }
    if (promptDisabled) return undefined;
    // Emotion overlays (the `[emote:NAME]` vocabulary) are only useful while
    // roleplaying, and the addendum that teaches them is the sole system-prompt
    // cost this extension adds. Gate it on the active `roleplay: true` persona
    // so a coding / no-persona session pays zero extra tokens; activity
    // animation is event-driven and stays on regardless.
    if (!getActivePersona()?.roleplay) return undefined;
    const base = event.systemPrompt.length > 0 ? event.systemPrompt : ctx.getSystemPrompt();
    return { systemPrompt: appendEmotePrompt(base, buildEmotePromptAddendum({ emotions })) };
  });

  pi.on('agent_start', () => {
    // A new turn releases any emotion held from the previous response and
    // clears any half-accumulated emote buffer (defensive - message_end
    // normally flushes it).
    resetMessageEmotes();
    if (!widgetActive) return;
    animator.releaseEmotion();
    animator.transitionTo('wait');
  });

  pi.on('message_update', (event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    const message = event.message as MutableMessage;
    const names = applyEmoteMarkers(message, !keepRaw);
    if (names.length > 0 && !emoteEventsDisabled) {
      for (const name of names) {
        if (!msgEmotes.includes(name)) msgEmotes.push(name);
      }
      msgPrimary = names[names.length - 1];
    }
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

  pi.on('message_end', (event) => {
    if (!enabled) return;
    // Only assistant messages carry emote markers; ignore user / tool-result
    // ends. Persist + publish whatever this message named, then reset.
    if ((event.message as MutableMessage)?.role === 'assistant') flushMessageEmotes();
  });

  pi.on('context', (event) => {
    if (!enabled || keepRaw) return undefined;
    const result = scrubContextMessages(event.messages as unknown as MutableMessage[]);
    return result ? { messages: result.messages as never } : undefined;
  });

  pi.on('tool_execution_start', (event) => {
    toolCounts.set(event.toolName, (toolCounts.get(event.toolName) ?? 0) + 1);
    if (widgetActive) animator.transitionTo(resolveToolState(event.toolName, event.args));
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
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        on: { description: 'Mount the avatar widget for this session' },
        off: { description: 'Hide the avatar widget for this session' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(AVATAR_USAGE, 'info');
        return;
      }
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
      let logged = 0;
      try {
        logged = collectLoggedEmotes(ctx.sessionManager.getEntries() as never).length;
      } catch {
        /* session entries unavailable - omit the count */
      }
      ctx.ui.notify(
        `avatar: ${widgetActive ? 'on' : 'off'} \u00b7 protocol ${protocol} \u00b7 set "${currentSet}" \u00b7 emotions: ${emoteList} \u00b7 logged: ${logged}`,
        'info',
      );
    },
  });
}
