/**
 * Pure config defaults + coercion + layering for the `roleplay`
 * extension.
 *
 * The shell reads JSON from disk (user global `~/.pi/agent/roleplay.json`
 * -> project local `<cwd>/.pi/roleplay.json`), feeds each layer through
 * {@link coerceConfigLayer}, then {@link mergeConfigLayers}.
 * {@link loadRoleplayConfig} does the disk wiring so the shell stays
 * thin. A missing / malformed file degrades to an empty layer.
 *
 * Phase 1 exposes only `charBudget` (the injected `## Roleplay` block
 * cap). Phase 2 adds `loreCharBudget` (the fired-lore section cap) and
 * `maxRecursion` (bounded lorebook recursion). Phase 4 adds `scanDepth`
 * (recent messages scanned for depth-injected lore in the `context`
 * event). Phase 7 adds `relationshipDecayPerDay` + `relationshipBaseline`
 * (the toward-baseline affinity-decay convention; see `relationship.ts`),
 * plus `summarizeMinMessages` + `summarizeMaxChars` (the auto-summarization
 * eviction trigger; see `summarize.ts`).
 *
 * No pi imports.
 */

import { readJsonOrUndefined } from '../fs-safe.ts';
import { envTruthy, parseClampedPositiveInt } from '../parse-env.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';
import { MAX_RECURSION_CAP } from './recursion.ts';

export interface RoleplayConfig {
  /** Soft cap on the injected `## Roleplay` cast-index block, in characters. */
  charBudget: number;
  /** Soft cap on the injected fired-lore section, in characters. */
  loreCharBudget: number;
  /** Bounded lorebook recursion passes (0 = off). Clamped to `MAX_RECURSION_CAP`. */
  maxRecursion: number;
  /** Recent messages scanned for depth-injected lore in the `context` event (Phase 4). */
  scanDepth: number;
  /** Affinity points a relationship decays toward `relationshipBaseline` per idle day (Phase 7). */
  relationshipDecayPerDay: number;
  /** Neutral resting affinity that decay converges to, 0-100 (Phase 7). */
  relationshipBaseline: number;
  /** Minimum evicted messages before auto-summarization fires (Phase 7B). */
  summarizeMinMessages: number;
  /** Soft cap on a generated auto-summary record body, in characters (Phase 7B). */
  summarizeMaxChars: number;
  /** Enable the multi-turn repetition / anti-slop nudge (additive `context` injection). */
  repetitionEnabled: boolean;
  /** Word-n-gram length compared across recent assistant replies. */
  repetitionNgram: number;
  /** How many of the most-recent assistant replies the repetition scan covers. */
  repetitionWindow: number;
  /** Occurrences of an n-gram across the window before it is flagged. */
  repetitionMinCount: number;
  /** Fallback complication deck for `/roleplay event` when no model/agent is available. */
  events: string[];
  /** Soft cap on a generated / picked scene event, in characters. */
  eventMaxChars: number;
  /** Offer the cast's relationship `openThreads` to the event generator as escalation seeds. */
  eventSeedThreads: boolean;
  /** Recent user-turns kept verbatim in the rolling context window (`context` hook). */
  keepTurns: number;
  /** Aged messages between rolls: re-recap + advance the drop boundary once this many age out. */
  recapChunk: number;
  /** Char budget for the text of older assistant messages in the condensed boundary zone. */
  windowAssistantChars: number;
  /** Char budget for the text of older user messages in the condensed boundary zone. */
  windowUserChars: number;
  /** Roll cadence in aged messages (re-recap + advance the drop boundary). 0 = follow `recapChunk`. */
  recapStride: number;
  /** Force async (`true`) / sync (`false`) recap; `null` = auto (async only on a distinct recap endpoint). */
  recapAsync: boolean | null;
  /** Deterministic fact capture on the roll -> session-scope `memory` notes (requires recap mode). */
  capture: boolean;
  /** Additive, anti-drift timeline of dated story beats on the roll (requires recap mode). */
  timeline: boolean;
  /** Soft cap on the injected `## Recent timeline` block, in characters. */
  timelineMaxInjectChars: number;
}

/** Shipped defaults - lowest config layer. Parity with memory's 3000-char cap. */
export const DEFAULT_CONFIG: RoleplayConfig = {
  charBudget: 3000,
  loreCharBudget: 3000,
  maxRecursion: 0,
  scanDepth: 10,
  relationshipDecayPerDay: 1,
  relationshipBaseline: 50,
  summarizeMinMessages: 4,
  summarizeMaxChars: 1500,
  repetitionEnabled: true,
  repetitionNgram: 5,
  repetitionWindow: 6,
  repetitionMinCount: 2,
  events: [],
  eventMaxChars: 280,
  eventSeedThreads: true,
  keepTurns: 8,
  recapChunk: 8,
  windowAssistantChars: 200,
  windowUserChars: 400,
  recapStride: 0,
  recapAsync: null,
  capture: false,
  timeline: false,
  timelineMaxInjectChars: 1200,
};

/** Floor for the injected-block budgets so a tiny value can't blank them. */
export const MIN_CHAR_BUDGET = 500;

/** Upper bound on `scanDepth` so a stray config can't scan an unbounded history. */
export const MAX_SCAN_DEPTH = 100;

/** Floor for the auto-summary output cap so a tiny value can't blank a recap. */
export const MIN_SUMMARY_CHARS = 200;

/** Bounds on the repetition n-gram length (too short = noise, too long = never fires). */
export const MIN_REPETITION_NGRAM = 2;
export const MAX_REPETITION_NGRAM = 12;

/** Upper bound on the repetition scan window so a stray config can't scan everything. */
export const MAX_REPETITION_WINDOW = 50;

/** Hard floor on the repetition flag threshold (a single occurrence is never a repeat). */
export const MIN_REPETITION_COUNT = 2;

/** Floor for the event output cap so a tiny value can't blank an event. */
export const MIN_EVENT_CHARS = 40;

/** Bounds on the rolling-window dials so a stray config can't blank or explode them. */
export const MIN_KEEP_TURNS = 1;
export const MAX_KEEP_TURNS = 200;
export const MIN_RECAP_CHUNK = 1;
export const MAX_RECAP_CHUNK = 500;
/** Floor on the per-message condense budget so condensing can't produce a stub. */
export const MIN_WINDOW_CHARS = 40;

/** Floor for the injected timeline block so a tiny value can't blank it. */
export const MIN_TIMELINE_INJECT_CHARS = 200;

/** Validate an untrusted JSON layer into a `Partial<RoleplayConfig>`. */
export function coerceConfigLayer(raw: unknown): Partial<RoleplayConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const v = raw as Record<string, unknown>;
  const out: Partial<RoleplayConfig> = {};
  if (typeof v.charBudget === 'number' && Number.isFinite(v.charBudget)) {
    out.charBudget = Math.max(MIN_CHAR_BUDGET, Math.floor(v.charBudget));
  }
  if (typeof v.loreCharBudget === 'number' && Number.isFinite(v.loreCharBudget)) {
    out.loreCharBudget = Math.max(MIN_CHAR_BUDGET, Math.floor(v.loreCharBudget));
  }
  if (typeof v.maxRecursion === 'number' && Number.isFinite(v.maxRecursion)) {
    out.maxRecursion = Math.max(0, Math.min(MAX_RECURSION_CAP, Math.floor(v.maxRecursion)));
  }
  if (typeof v.scanDepth === 'number' && Number.isFinite(v.scanDepth)) {
    out.scanDepth = Math.max(1, Math.min(MAX_SCAN_DEPTH, Math.floor(v.scanDepth)));
  }
  if (typeof v.relationshipDecayPerDay === 'number' && Number.isFinite(v.relationshipDecayPerDay)) {
    out.relationshipDecayPerDay = Math.max(0, v.relationshipDecayPerDay);
  }
  if (typeof v.relationshipBaseline === 'number' && Number.isFinite(v.relationshipBaseline)) {
    out.relationshipBaseline = Math.max(0, Math.min(100, Math.floor(v.relationshipBaseline)));
  }
  if (typeof v.summarizeMinMessages === 'number' && Number.isFinite(v.summarizeMinMessages)) {
    out.summarizeMinMessages = Math.max(1, Math.floor(v.summarizeMinMessages));
  }
  if (typeof v.summarizeMaxChars === 'number' && Number.isFinite(v.summarizeMaxChars)) {
    out.summarizeMaxChars = Math.max(MIN_SUMMARY_CHARS, Math.floor(v.summarizeMaxChars));
  }
  if (typeof v.repetitionEnabled === 'boolean') {
    out.repetitionEnabled = v.repetitionEnabled;
  }
  if (typeof v.repetitionNgram === 'number' && Number.isFinite(v.repetitionNgram)) {
    out.repetitionNgram = Math.max(MIN_REPETITION_NGRAM, Math.min(MAX_REPETITION_NGRAM, Math.floor(v.repetitionNgram)));
  }
  if (typeof v.repetitionWindow === 'number' && Number.isFinite(v.repetitionWindow)) {
    out.repetitionWindow = Math.max(1, Math.min(MAX_REPETITION_WINDOW, Math.floor(v.repetitionWindow)));
  }
  if (typeof v.repetitionMinCount === 'number' && Number.isFinite(v.repetitionMinCount)) {
    out.repetitionMinCount = Math.max(MIN_REPETITION_COUNT, Math.floor(v.repetitionMinCount));
  }
  if (Array.isArray(v.events)) {
    out.events = v.events
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  }
  if (typeof v.eventMaxChars === 'number' && Number.isFinite(v.eventMaxChars)) {
    out.eventMaxChars = Math.max(MIN_EVENT_CHARS, Math.floor(v.eventMaxChars));
  }
  if (typeof v.eventSeedThreads === 'boolean') {
    out.eventSeedThreads = v.eventSeedThreads;
  }
  if (typeof v.keepTurns === 'number' && Number.isFinite(v.keepTurns)) {
    out.keepTurns = Math.max(MIN_KEEP_TURNS, Math.min(MAX_KEEP_TURNS, Math.floor(v.keepTurns)));
  }
  if (typeof v.recapChunk === 'number' && Number.isFinite(v.recapChunk)) {
    out.recapChunk = Math.max(MIN_RECAP_CHUNK, Math.min(MAX_RECAP_CHUNK, Math.floor(v.recapChunk)));
  }
  if (typeof v.windowAssistantChars === 'number' && Number.isFinite(v.windowAssistantChars)) {
    out.windowAssistantChars = Math.max(MIN_WINDOW_CHARS, Math.floor(v.windowAssistantChars));
  }
  if (typeof v.windowUserChars === 'number' && Number.isFinite(v.windowUserChars)) {
    out.windowUserChars = Math.max(MIN_WINDOW_CHARS, Math.floor(v.windowUserChars));
  }
  if (typeof v.recapStride === 'number' && Number.isFinite(v.recapStride)) {
    out.recapStride = Math.max(0, Math.min(MAX_RECAP_CHUNK, Math.floor(v.recapStride)));
  }
  if (typeof v.recapAsync === 'boolean') {
    out.recapAsync = v.recapAsync;
  }
  if (typeof v.capture === 'boolean') {
    out.capture = v.capture;
  }
  if (typeof v.timeline === 'boolean') {
    out.timeline = v.timeline;
  }
  if (typeof v.timelineMaxInjectChars === 'number' && Number.isFinite(v.timelineMaxInjectChars)) {
    out.timelineMaxInjectChars = Math.max(MIN_TIMELINE_INJECT_CHARS, Math.floor(v.timelineMaxInjectChars));
  }
  return out;
}

/** Merge config layers low-to-high precedence (later wins). */
export function mergeConfigLayers(...layers: Partial<RoleplayConfig>[]): RoleplayConfig {
  return Object.assign({ ...DEFAULT_CONFIG }, ...layers) as RoleplayConfig;
}

/**
 * Load the effective config: shipped defaults <- user global <- project.
 * `envCharBudget` (from `PI_ROLEPLAY_MAX_INJECTED_CHARS`) sits between the
 * defaults and the file layers so a committed project config still wins
 * over a stray shell export.
 */
export function loadRoleplayConfig(cwd: string, envCharBudget?: number): RoleplayConfig {
  const envLayer: Partial<RoleplayConfig> =
    typeof envCharBudget === 'number' ? { charBudget: Math.max(MIN_CHAR_BUDGET, envCharBudget) } : {};
  // Rolling-window dials: env sits below the config files (a committed
  // project config still wins over a stray shell export). Only fold a knob
  // in when its env var is actually set, so an unset environment leaves the
  // shipped defaults untouched.
  const env = process.env;
  if (env.PI_ROLEPLAY_CONTEXT_TURNS !== undefined) {
    envLayer.keepTurns = parseClampedPositiveInt(
      env.PI_ROLEPLAY_CONTEXT_TURNS,
      DEFAULT_CONFIG.keepTurns,
      MIN_KEEP_TURNS,
    );
  }
  if (env.PI_ROLEPLAY_RECAP_CHUNK !== undefined) {
    envLayer.recapChunk = parseClampedPositiveInt(
      env.PI_ROLEPLAY_RECAP_CHUNK,
      DEFAULT_CONFIG.recapChunk,
      MIN_RECAP_CHUNK,
    );
  }
  if (env.PI_ROLEPLAY_CONTEXT_ASSISTANT_CHARS !== undefined) {
    envLayer.windowAssistantChars = parseClampedPositiveInt(
      env.PI_ROLEPLAY_CONTEXT_ASSISTANT_CHARS,
      DEFAULT_CONFIG.windowAssistantChars,
      MIN_WINDOW_CHARS,
    );
  }
  if (env.PI_ROLEPLAY_CONTEXT_USER_CHARS !== undefined) {
    envLayer.windowUserChars = parseClampedPositiveInt(
      env.PI_ROLEPLAY_CONTEXT_USER_CHARS,
      DEFAULT_CONFIG.windowUserChars,
      MIN_WINDOW_CHARS,
    );
  }
  if (env.PI_ROLEPLAY_RECAP_STRIDE !== undefined) {
    envLayer.recapStride = parseClampedPositiveInt(env.PI_ROLEPLAY_RECAP_STRIDE, DEFAULT_CONFIG.recapStride, 1);
  }
  if (env.PI_ROLEPLAY_RECAP_ASYNC !== undefined) {
    envLayer.recapAsync = envTruthy(env.PI_ROLEPLAY_RECAP_ASYNC);
  }
  if (env.PI_ROLEPLAY_CAPTURE !== undefined) {
    envLayer.capture = envTruthy(env.PI_ROLEPLAY_CAPTURE);
  }
  if (env.PI_ROLEPLAY_TIMELINE !== undefined) {
    envLayer.timeline = envTruthy(env.PI_ROLEPLAY_TIMELINE);
  }
  const userLayer = coerceConfigLayer(readJsonOrUndefined(piAgentPath('roleplay.json')));
  const projectLayer = coerceConfigLayer(readJsonOrUndefined(piProjectPath(cwd, 'roleplay.json')));
  return mergeConfigLayers(envLayer, userLayer, projectLayer);
}
