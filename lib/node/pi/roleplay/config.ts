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
  const userLayer = coerceConfigLayer(readJsonOrUndefined(piAgentPath('roleplay.json')));
  const projectLayer = coerceConfigLayer(readJsonOrUndefined(piProjectPath(cwd, 'roleplay.json')));
  return mergeConfigLayers(envLayer, userLayer, projectLayer);
}
