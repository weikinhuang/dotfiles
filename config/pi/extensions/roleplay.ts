/**
 * Roleplay extension for pi - a cast-keyed durable store for roleplay
 * scenarios, separate from the coding `memory` extension so it can be
 * disabled wholesale (`PI_ROLEPLAY_DISABLED=1`) without touching the
 * coding-agent surface.
 *
 * Where `memory` keys durable notes on cwd / session, `roleplay` keys on
 * *cast* - a character or ensemble that travels with you across
 * workspaces. Each turn the active cast's index is injected under a
 * `## Roleplay` header so the model sees who's in the scene without a
 * tool call; full character sheets are fetched on demand via
 * `roleplay read <id>`.
 *
 * Phase 1 ships the `character` kind only. Phase 2+ adds `lore`
 * (keyword-triggered World Info injection), depth injection via the
 * `context` event, relationship state, and auto-summarization. See
 * `plans/pi-roleplay-sillytavern.md`.
 *
 * Pure logic lives in `../../../lib/node/pi/roleplay/*.ts` (vitest-
 * testable, no pi imports); this file holds only the pi-coupled glue +
 * disk I/O.
 *
 * Environment:
 *   PI_ROLEPLAY_DISABLED=1               skip the extension entirely.
 *   PI_ROLEPLAY_DISABLE_AUTOINJECT=1     tool still works, skip the
 *                                        before_agent_start block.
 *   PI_ROLEPLAY_DISABLE_LOREBOOK=1       skip keyword-triggered lore
 *                                        injection (cast index still injects).
 *   PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1   skip the context-event depth
 *                                        injection (author's note + depth lore).
 *   PI_ROLEPLAY_DISABLE_SUMMARIZE=1      skip auto-summarization on compaction.
 *   PI_ROLEPLAY_DISABLE_REPETITION=1     skip the multi-turn repetition / anti-slop nudge.
 *   PI_ROLEPLAY_DISABLE_EVENTS=1         disable `/roleplay event` scene complications.
 *   PI_ROLEPLAY_DISABLE_AVATAR=1         stop driving the avatar face from the cast.
 *   PI_ROLEPLAY_DISABLE_SCENEGEN=1       stop mirroring generated images to the
 *                                        avatar scene banner.
 *   PI_ROLEPLAY_MAX_INJECTED_CHARS=N     soft cap on injected block (default 3000).
 *   PI_ROLEPLAY_ROOT=<path>              override `~/.pi/agent/roleplay`.
 *
 * Activation gate: the tool, cast scan, and `## Roleplay` injection are
 * DORMANT unless the active persona declares `roleplay: true` in its
 * frontmatter (optionally with a `cast:` slug). This keeps roleplay off
 * for coding personas and persona-as-subagent uses. `/roleplay cast
 * <name>` overrides the cast within an active roleplay persona.
 */

import { StringEnum, type Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ModelRegistry,
  parseFrontmatter,
  type ResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';

import { cardToRecords, parseCardJson } from '../../../lib/node/pi/card-import/card-to-records.ts';
import { extractCardJson } from '../../../lib/node/pi/card-import/parse-png-chara.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { envTruthy, parseClampedPositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { clearActiveRoleplay, setActiveRoleplay } from '../../../lib/node/pi/roleplay/active.ts';
import { clearAvatarInput, setAvatarInput } from '../../../lib/node/pi/avatar/input.ts';
import { onImageGenerated } from '../../../lib/node/pi/comfyui/events.ts';
import { loadRoleplayConfig } from '../../../lib/node/pi/roleplay/config.ts';
import { selectWithinBudget, type LoreChunk } from '../../../lib/node/pi/roleplay/budget.ts';
import { applyInsertions, buildInsertions, type LoreDepthChunk } from '../../../lib/node/pi/roleplay/inject.ts';
import { matchLore } from '../../../lib/node/pi/roleplay/match.ts';
import { formatLoreBlock } from '../../../lib/node/pi/roleplay/prompt.ts';
import { type MacroContext, substituteMacros } from '../../../lib/node/pi/roleplay/macros.ts';
import { composeSceneBlock } from '../../../lib/node/pi/roleplay/scene.ts';
import { expandRecursive } from '../../../lib/node/pi/roleplay/recursion.ts';
import { applyTiming, type TimingState } from '../../../lib/node/pi/roleplay/timing.ts';
import {
  composeAutoSummaryRecord,
  createSummarizer,
  planSummarization,
  resolveSummarizeSettings,
  type SummarizableMessage,
  type Summarizer,
} from '../../../lib/node/pi/roleplay/summarize.ts';
import {
  acceptRecap,
  applyContextWindowAt,
  applyLayeredWindow,
  computeCutoff,
  DEFAULT_CHARS_PER_TOKEN,
  deriveKeepTurns,
  deriveMaxSpanChars,
  estimateChars,
  injectRecap,
  injectTimeline,
  planRecap,
  updateCharsPerToken,
  type WindowOptions,
} from '../../../lib/node/pi/roleplay/context-window.ts';
import { parseModelSpec } from '../../../lib/node/pi/model-spec.ts';
import {
  buildEventTask,
  createEventGenerator,
  type EventGenerator,
  formatEventDirector,
  pickDeckEvent,
  resolveEventSettings,
} from '../../../lib/node/pi/roleplay/event.ts';
import { buildExcludeSet, detectRepetition, formatRepetitionNudge } from '../../../lib/node/pi/roleplay/repetition.ts';
import { applyContextReminder, type ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import {
  type AgentDef,
  defaultAgentLayers,
  loadAgents,
  makeNodeReadLayer,
} from '../../../lib/node/pi/subagent/loader.ts';
import { createPersistedSubagentSessionManager } from '../../../lib/node/pi/subagent/session-dir.ts';
import { createAgentGateFactory } from '../../../lib/node/pi/subagent/agent-gate.ts';
import { buildFactExtractionTask, parseFactCandidates } from '../../../lib/node/pi/roleplay/capture.ts';
import {
  buildTimelineExtractionTask,
  formatBeatLines,
  parseTimelineBeats,
  renderTimelineBlock,
} from '../../../lib/node/pi/roleplay/timeline.ts';
import { findSimilarMemories } from '../../../lib/node/pi/memory-search.ts';
import { type MemoryEntry, renderMemoryMd, serializeMemory } from '../../../lib/node/pi/memory-reducer.ts';
import {
  fileFor as memoryFileFor,
  indexFileFor as memoryIndexFileFor,
  rebuildMemoryIndex,
  slugifyName as memorySlugifyName,
  uniqueSlug as memoryUniqueSlug,
} from '../../../lib/node/pi/memory-paths.ts';
import { adaptCreateAgentSession, resolveChildModel, runOneShotAgent } from '../../../lib/node/pi/subagent/spawn.ts';
import {
  archiveCarryOver,
  archiveFacts,
  atomicWriteFile,
  castDir,
  factFile,
  fileFor,
  listCasts,
  listFactSidecars,
  portraitPath,
  readEntryBody,
  rebuildCast,
  removeFileIfExists,
  roleplayRoot,
  writeIndex,
} from '../../../lib/node/pi/roleplay/paths.ts';
import {
  castSlug,
  chooseSlug,
  cloneState,
  emptyState,
  emptyLoreMeta,
  emptyRelationshipMeta,
  formatRoleplayBlock,
  formatText,
  type LoreMeta,
  type RelationshipMeta,
  type RoleplayEntry,
  type RoleplayKind,
  type RoleplayState,
  type SecondaryMode,
  removeEntry,
  resolveEntry,
  serializeEntry,
  slugifyName,
  upsertEntry,
} from '../../../lib/node/pi/roleplay/store.ts';
import { ROLEPLAY_USAGE } from '../../../lib/node/pi/roleplay/usage.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

/**
 * Bridge pi's concrete `createAgentSession` (typed with the concrete
 * `ModelRegistry` class) to the pi-free structural `ModelRegistryLike`
 * the `runOneShotAgent` helper consumes. Compatible at runtime; the
 * adapter just casts the registry at the call. Mirrors deep-research.
 */
const piCreateAgentSession = adaptCreateAgentSession<Model<any>, SessionManager, ModelRegistry, ResourceLoader>(
  createAgentSession,
);

// ──────────────────────────────────────────────────────────────────────
// Tool params
// ──────────────────────────────────────────────────────────────────────

const RoleplayParams = Type.Object({
  action: StringEnum(['list', 'read', 'save', 'update', 'remove', 'search'] as const),
  kind: Type.Optional(
    StringEnum(['character', 'lore', 'relationship', 'summary', 'timeline'] as const, {
      description:
        "Record kind. Defaults to `character`. `lore` = keyword-triggered World Info; `relationship` = a pair's affinity/trust state; `summary` / `timeline` = recap and dated-beats notes.",
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: 'Entry slug (for `read` / `update` / `remove`). See ids in `list` or the injected index.',
    }),
  ),
  name: Type.Optional(
    Type.String({ description: 'Human-readable title. Required for `save`; slugifies into the filename.' }),
  ),
  description: Type.Optional(
    Type.String({
      description: 'One-line hook shown in the cast index. Used to decide whether to `read` the full sheet.',
    }),
  ),
  body: Type.Optional(
    Type.String({
      description:
        'Full record content (markdown). For a character: voice, appearance, speech tics, hard constraints, first message, example dialogue. For lore: the world detail injected when triggered.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: 'Case-insensitive search term (for `search`). Matches name, description, id, and body.',
    }),
  ),
  triggers: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Lore only: primary keywords (OR). The entry fires when any appears in the latest message.',
    }),
  ),
  secondaryKeys: Type.Optional(
    Type.Array(Type.String(), { description: 'Lore only: optional secondary keywords gated by `secondaryMode`.' }),
  ),
  secondaryMode: Type.Optional(
    StringEnum(['AND', 'OR', 'NOT'] as const, {
      description: 'Lore only: how `secondaryKeys` combine after a primary hit. Default AND.',
    }),
  ),
  constant: Type.Optional(
    Type.Boolean({ description: 'Lore only: always inject (budget permitting), ignoring triggers. Default false.' }),
  ),
  order: Type.Optional(
    Type.Number({ description: 'Lore only: priority; higher wins when the char budget evicts. Default 0.' }),
  ),
  depth: Type.Optional(
    Type.Number({
      description:
        'Lore only: context-insertion depth (reserved for depth injection; system-prompt-appended until then).',
    }),
  ),
  recurse: Type.Optional(
    Type.Boolean({
      description: 'Lore only: opt in to having this entry body re-scanned to trigger further lore. Default false.',
    }),
  ),
  affinity: Type.Optional(
    Type.Number({ description: 'Relationship only: 0-100 warmth/closeness. Decays toward neutral while idle.' }),
  ),
  trust: Type.Optional(Type.String({ description: 'Relationship only: free-form trust label (e.g. `high`, `wary`).' })),
  lastInteraction: Type.Optional(
    Type.String({ description: 'Relationship only: ISO date (YYYY-MM-DD) of the last shared scene; decay anchor.' }),
  ),
  openThreads: Type.Optional(
    Type.Array(Type.String(), { description: 'Relationship only: dangling threads to resume next scene.' }),
  ),
});

interface RoleplayParamsT {
  action: 'list' | 'read' | 'save' | 'update' | 'remove' | 'search';
  kind?: RoleplayKind;
  id?: string;
  name?: string;
  description?: string;
  body?: string;
  query?: string;
  triggers?: string[];
  secondaryKeys?: string[];
  secondaryMode?: SecondaryMode;
  constant?: boolean;
  order?: number;
  depth?: number;
  recurse?: boolean;
  affinity?: number;
  trust?: string;
  lastInteraction?: string;
  openThreads?: string[];
}

interface RoleplayDetails {
  action: string;
  state: RoleplayState;
  entry?: RoleplayEntry;
  matches?: RoleplayEntry[];
  body?: string;
  error?: string;
}

interface ActionOut {
  content: string;
  details: RoleplayDetails;
  isError?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function roleplayExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_ROLEPLAY_DISABLED)) return;

  const autoInjectEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_AUTOINJECT);
  const lorebookEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_LOREBOOK);
  const depthInjectEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_DEPTH_INJECT);
  const summarizeEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_SUMMARIZE);
  const repetitionEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_REPETITION);
  const eventsEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_EVENTS);
  const avatarDriveEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_AVATAR);
  const sceneGenEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_SCENEGEN);
  const envCharBudget = parseClampedPositiveInt(process.env.PI_ROLEPLAY_MAX_INJECTED_CHARS, 0, 1) || undefined;

  // Rolling context-window management. `contextWindowEnabled` runs the
  // per-turn in-context reduction (drop/condense) in the `context` hook.
  // `recapMode` = bounded mode: the summarizer folds the aged prefix into
  // the `summary/auto` recap and the recap-covered prefix is DROPPED
  // (O(1)). Recap requires the window; when either is off we degrade to the
  // condense-only floor. Owning pi's threshold auto-compaction is only safe
  // in recap (size-bounded) mode - the floor keeps every message.
  const contextWindowEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW);
  const recapMode = summarizeEnabled && contextWindowEnabled;
  const ownCompaction = recapMode;
  const contextWindowDebug = envTruthy(process.env.PI_ROLEPLAY_CONTEXT_DEBUG);
  // Deterministic fact capture on the roll -> session-scope `memory` notes.
  // Default OFF (config `capture` / `PI_ROLEPLAY_CAPTURE`): a novel model-call
  // path whose extraction quality is validated in the rp-test small-window
  // smoke before it goes on by default. Requires recap mode (it runs on the
  // roll) + a session id. Gate is read lazily below (near `strideValue`) so a
  // project `roleplay.json` picked up after cwd settles still applies.

  let cwd: string = process.cwd();
  let state: RoleplayState = emptyState();
  /** Explicit cast override set by `/roleplay cast <name>` (only honoured under a roleplay persona). */
  let castOverride: string | null = null;
  /** Last cast we scanned for, or null when dormant. Lets before_agent_start skip redundant disk scans. */
  let syncedCast: string | null = null;
  /** Signature of the last warn-dropped scene-character set, to dedupe the notice. */
  let lastSceneMissingSig = '';
  /** Monotonic per-turn counter driving lorebook timing (`delay` / `sticky` / `cooldown`). */
  let turnCount = 0;
  /** Per-entry lorebook timing state, keyed by entry id. Reset on cast switch. */
  let timingState: Record<string, TimingState> = {};
  /** Unsubscribe handle for the comfyui image-generated bus (cleared on shutdown). */
  let unsubscribeImageEvents: (() => void) | null = null;
  const surfacedWarnings = new Set<string>();
  /** Queued one-shot scene complication from `/roleplay event`; injected for the next reply only. */
  let pendingEvent: string | null = null;
  /** Set once `pendingEvent` has been injected; the next turn boundary clears the event. */
  let eventConsumed = false;
  /** Most-recent `context` message array, captured so `/roleplay event` can read the scene. */
  let lastMessages: readonly unknown[] = [];
  /** Memoized character-sheet n-gram exclusion set for repetition detection; rebuilt on state change. */
  let excludeCache: { cast: string; ngram: number; set: Set<string> } | null = null;
  // ── Rolling context-window state (per process; reset on lifecycle) ──
  /** Cumulative scene memory injected as a prefix (mirrors the `summary/auto` record). */
  let recapText = '';
  /** Cumulative append-log of dated story beats injected as a prefix (mirrors the `timeline/auto` record). */
  let timelineText = '';
  /** FROZEN condense boundary; messages[0..committedCutoff) are the aged prefix. Advances only on a roll. */
  let committedCutoff = 0;
  /** How much of the aged prefix the recap covers; messages[0..recapCutoff) are DROPPED in recap mode. */
  let recapCutoff = 0;
  /** One-shot hydrate of `recapText` from the durable record per (re)load. */
  let recapHydrated = false;
  /** Generation counter; invalidates an in-flight async recap after a reset / branch change. */
  let recapGen = 0;
  let recapInFlight = false;
  let recapAbort: AbortController | null = null;
  /** Calibrated chars-per-token (blended toward the last turn's reported usage). */
  let charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  /** Estimated chars of the prompt we sent last turn, for usage calibration next turn. */
  let lastSentEstChars = 0;
  /** Lowercased fact names captured this process, to skip re-writing the same fact. */
  const capturedFacts = new Set<string>();
  /** Lazy `roleplay-fact-extractor` runner + one-shot init guard. */
  let factExtractor: ((ctx: ExtensionContext, task: string) => Promise<string | null>) | null = null;
  let factExtractorInit = false;
  /** Lazy `roleplay-timeline-extractor` runner + one-shot init guard. */
  let timelineExtractor: ((ctx: ExtensionContext, task: string) => Promise<string | null>) | null = null;
  let timelineExtractorInit = false;
  const resetWindowState = (): void => {
    recapText = '';
    timelineText = '';
    committedCutoff = 0;
    recapCutoff = 0;
    recapHydrated = false;
    recapGen += 1;
    recapInFlight = false;
    lastSentEstChars = 0;
    capturedFacts.clear();
    if (recapAbort) {
      try {
        recapAbort.abort();
      } catch {
        /* ignore */
      }
      recapAbort = null;
    }
  };

  /**
   * The active roleplay cast, or `null` when the feature is dormant.
   * Dormant unless the active persona declared `roleplay: true` - this is
   * the master gate so coding personas / persona-as-subagent never
   * trigger the roleplay tool, cast scan, or `## Roleplay` injection.
   */
  const activeCast = (): string | null => {
    const persona = getActivePersona();
    if (!persona?.roleplay) return null;
    if (castOverride) return castOverride;
    if (persona.cast && persona.cast.trim().length > 0) return castSlug(persona.cast);
    return castSlug(persona.name);
  };

  /**
   * Slug of the character whose face the avatar should show, or `null`
   * when dormant. Prefers the first non-POV character (the one the user
   * is talking to), then the first listed character, then the cast slug;
   * the slug maps to an avatar sprite-set dir (`avatar/emotes/<slug>/`).
   * A slug with no sprite art falls back gracefully on the avatar side.
   */
  const activeFaceSlug = (): string | null => {
    const persona = getActivePersona();
    if (!persona?.roleplay) return null;
    const chars = persona.characters ?? [];
    const povSlug = persona.pov ? slugifyName(persona.pov) : '';
    const nonPov = chars.find((c) => slugifyName(c) !== povSlug);
    const pick = nonPov ?? chars[0];
    if (pick) return slugifyName(pick);
    return state.cast.length > 0 ? state.cast : null;
  };

  /** Display name of the primary (face) character, for `{{char}}` substitution. */
  const primaryCharName = (): string | undefined => {
    const persona = getActivePersona();
    if (!persona?.roleplay) return undefined;
    const chars = persona.characters ?? [];
    const povSlug = persona.pov ? slugifyName(persona.pov) : '';
    const nonPov = chars.find((c) => slugifyName(c) !== povSlug);
    return nonPov ?? chars[0];
  };

  /**
   * Macro-substitution context for injected text. `{{user}}` resolves to
   * the persona POV (player character); `{{char}}` to `charName` when
   * given (a folded character sheet uses that character) else the primary
   * face character.
   */
  const macroCtx = (charName?: string): MacroContext => ({
    user: getActivePersona()?.pov,
    char: charName ?? primaryCharName(),
  });

  /** Re-scan disk for `cast` (or go dormant when null) and publish the active-cast singleton. */
  const applyCast = (cast: string | null, ctx?: ExtensionContext): void => {
    // A cast switch resets lorebook timing (sticky windows / cooldowns / turn count).
    turnCount = 0;
    timingState = {};
    excludeCache = null;
    if (cast === null) {
      state = emptyState();
      syncedCast = null;
      clearActiveRoleplay();
      if (avatarDriveEnabled) clearAvatarInput();
      return;
    }
    const { state: next, warnings } = rebuildCast(cast);
    state = next;
    syncedCast = cast;
    for (const w of warnings) {
      if (surfacedWarnings.has(w)) continue;
      surfacedWarnings.add(w);
      ctx?.ui.notify(`roleplay: ${w}`, 'warning');
    }
    setActiveRoleplay({ cast });
    if (avatarDriveEnabled) {
      const face = activeFaceSlug();
      const portrait = face ? portraitPath(state.cast, face) : '';
      setAvatarInput({
        emoteSet: face ?? '',
        image: portrait && existsSync(portrait) ? { path: portrait } : undefined,
      });
    }
  };

  /**
   * Tool-visibility gate. The `roleplay` tool must only be offered to the
   * model under an active `roleplay: true` persona that allowlisted it -
   * never in a coding session, a no-persona session, or a persona that left
   * `roleplay` out of its `tools:`. persona.ts owns *adding* the tool (it
   * calls setActiveTools with the persona's allowlist), so we only ever
   * REMOVE it when dormant; we never add it back.
   *
   * Crucially this runs at `session_start` / `session_tree` (via `resync`),
   * not only at `before_agent_start`. setActiveTools rebuilds the base system
   * prompt, but a removal done inside `before_agent_start` is clobbered: the
   * runner seeds that turn's prompt from a snapshot taken *before* the
   * handlers run, and other autoinject extensions (memory / scratchpad /
   * todo) compose their additions off that pre-removal snapshot - so the
   * roleplay `promptSnippet` (Available tools) + `promptGuidelines`
   * (Guidelines) would leak into the FIRST turn's prompt and only clear from
   * turn 2 on. Gating at session lifecycle time means the base prompt is
   * already roleplay-free before turn 1's snapshot is taken. Runs regardless
   * of PI_ROLEPLAY_DISABLE_AUTOINJECT so the tool stays hidden even when the
   * `## Roleplay` injection is turned off.
   */
  const gateRoleplayTool = (): void => {
    if (activeCast() !== null) return;
    const tools = pi.getActiveTools();
    if (tools.includes('roleplay')) pi.setActiveTools(tools.filter((t) => t !== 'roleplay'));
  };

  /** Force a re-resolve + scan (session lifecycle hooks). */
  const resync = (ctx: ExtensionContext): void => {
    cwd = ctx.cwd;
    resetWindowState();
    applyCast(activeCast(), ctx);
    gateRoleplayTool();
  };

  /** Cheap re-resolve: only re-scan disk when the resolved cast actually changed. */
  const resyncIfChanged = (ctx?: ExtensionContext): void => {
    if (ctx?.cwd && ctx.cwd !== cwd) cwd = ctx.cwd;
    const cast = activeCast();
    if (cast === syncedCast) return;
    applyCast(cast, ctx);
  };

  const charBudget = (): number => loadRoleplayConfig(cwd, envCharBudget).charBudget;

  /** Build lore metadata from tool params, layered over an optional base (for updates). */
  const buildLoreMeta = (params: RoleplayParamsT, base?: LoreMeta): LoreMeta => {
    const meta: LoreMeta = base
      ? { ...base, triggers: [...base.triggers], secondaryKeys: [...base.secondaryKeys] }
      : emptyLoreMeta();
    const clean = (xs: string[]): string[] => xs.map((x) => x.trim()).filter((x) => x.length > 0);
    if (params.triggers !== undefined) meta.triggers = clean(params.triggers);
    if (params.secondaryKeys !== undefined) meta.secondaryKeys = clean(params.secondaryKeys);
    if (params.secondaryMode !== undefined) meta.secondaryMode = params.secondaryMode;
    if (params.constant !== undefined) meta.constant = params.constant;
    if (params.order !== undefined) meta.order = Math.floor(params.order);
    if (params.recurse !== undefined) meta.recurse = params.recurse;
    if (params.depth !== undefined) {
      const d = Math.floor(params.depth);
      if (d >= 0) meta.depth = d;
      else delete meta.depth;
    }
    return meta;
  };

  /** Build relationship metadata from tool params, layered over an optional base (for updates). */
  const buildRelationshipMeta = (params: RoleplayParamsT, base?: RelationshipMeta): RelationshipMeta => {
    const meta: RelationshipMeta = base ? { ...base, openThreads: [...base.openThreads] } : emptyRelationshipMeta();
    const clean = (xs: string[]): string[] => xs.map((x) => x.trim()).filter((x) => x.length > 0);
    if (params.affinity !== undefined) meta.affinity = Math.min(100, Math.max(0, Math.floor(params.affinity)));
    if (params.trust !== undefined) meta.trust = params.trust.trim();
    if (params.lastInteraction !== undefined) {
      const v = params.lastInteraction.trim();
      if (v.length > 0) meta.lastInteraction = v;
      else delete meta.lastInteraction;
    }
    if (params.openThreads !== undefined) meta.openThreads = clean(params.openThreads);
    return meta;
  };

  /**
   * Fold the active persona's scene characters (`characters: [...]`) + POV
   * (`pov:`) full sheets into a `## Roleplay scene` block, above the
   * lightweight cast index. Returns `null` when the persona declares
   * neither. Missing character names are warn-dropped (deduped so the
   * notice fires only when the unresolved set changes).
   */
  const buildSceneBlock = (ctx: ExtensionContext): string | null => {
    const persona = getActivePersona();
    if (!persona?.roleplay) return null;
    if ((persona.characters?.length ?? 0) === 0 && !persona.pov) return null;
    const bodyCache = new Map<string, string>();
    const bodyOf = (entry: RoleplayEntry): string => {
      const cached = bodyCache.get(entry.id);
      if (cached !== undefined) return cached;
      const body = substituteMacros(readEntryBody(state.cast, entry) ?? '', macroCtx(entry.name));
      bodyCache.set(entry.id, body);
      return body;
    };
    const { block, missing } = composeSceneBlock(state, bodyOf, {
      characters: persona.characters,
      pov: persona.pov,
      maxChars: charBudget(),
    });
    const sig = missing.join('\u0000');
    if (missing.length > 0 && sig !== lastSceneMissingSig) {
      ctx.ui.notify(`roleplay: scene character(s) not in cast "${state.cast}": ${missing.join(', ')}`, 'warning');
    }
    lastSceneMissingSig = sig;
    return block;
  };

  /**
   * Build the fired-lore section for `scanText` (the latest user prompt in
   * Phase 2). Returns `null` when the lorebook is disabled or nothing
   * fires. Bodies are loaded from disk for fired entries only.
   */
  const buildLoreInjection = (scanText: string): string | null => {
    if (!lorebookEnabled) return null;
    // Depth-tagged lore is injected at depth via the `context` event, not here.
    const lore = state.entries.filter((e) => e.kind === 'lore' && e.lore?.depth === undefined);
    if (lore.length === 0) return null;
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    // Keyword matching decides candidates; the timing pass (delay / probability /
    // sticky / cooldown / inclusion-group) decides what actually fires this turn.
    const matchedIds = new Set(matchLore(lore, scanText).map((e) => e.id));
    const timed = applyTiming(
      lore.map((e) => ({ id: e.id, meta: e.lore ?? emptyLoreMeta(), matched: matchedIds.has(e.id) })),
      turnCount,
      timingState,
      Math.random,
    );
    timingState = timed.nextState;
    const firedSet = new Set(timed.fired);
    const initial = lore.filter((e) => firedSet.has(e.id));
    if (initial.length === 0) return null;
    const bodyCache = new Map<string, string>();
    const bodyOf = (entry: RoleplayEntry): string => {
      const cached = bodyCache.get(entry.id);
      if (cached !== undefined) return cached;
      const body = substituteMacros(readEntryBody(state.cast, entry) ?? '', macroCtx());
      bodyCache.set(entry.id, body);
      return body;
    };
    const fired = expandRecursive(initial, lore, { bodyOf, maxRecursion: cfg.maxRecursion });
    if (fired.length === 0) return null;
    const chunks: LoreChunk[] = fired
      .map((entry) => ({ entry, body: bodyOf(entry).trim() }))
      .filter((c) => c.body.length > 0);
    if (chunks.length === 0) return null;
    return formatLoreBlock(selectWithinBudget(chunks, cfg.loreCharBudget));
  };

  pi.on('session_start', (_event, ctx) => resync(ctx));
  pi.on('session_tree', (_event, ctx) => resync(ctx));

  pi.on('before_agent_start', (event, ctx) => {
    // A persona may have been activated since session_start; re-resolve.
    resyncIfChanged(ctx);

    // Backstop the session-lifecycle gate for a mid-session persona switch
    // (a `/persona` change between turns). Per setActiveTools' "takes effect
    // next turn" contract this clears the leak from the following turn; the
    // turn the switch happens on is already covered because the base prompt
    // was rebuilt when the previous gate ran. See gateRoleplayTool for why
    // the primary gate lives in resync rather than here.
    if (activeCast() === null) {
      gateRoleplayTool();
      return undefined;
    }

    // Consume-once boundary: an event injected during the previous turn's
    // `context` calls is cleared here so it colors exactly one reply.
    if (eventsEnabled && eventConsumed) {
      pendingEvent = null;
      eventConsumed = false;
    }

    if (!autoInjectEnabled) return undefined;
    turnCount += 1;
    const scene = buildSceneBlock(ctx);
    const index = formatRoleplayBlock(state, { maxChars: charBudget() });
    const lore = buildLoreInjection(event.prompt ?? '');
    const additions = [scene, index, lore].filter((s): s is string => Boolean(s));
    if (additions.length === 0) return undefined;
    return { systemPrompt: [event.systemPrompt, ...additions].join('\n\n') };
  });

  /** Concatenate the text content of the last `n` messages for depth-lore scanning. */
  const recentText = (messages: readonly unknown[], n: number): string => {
    const parts: string[] = [];
    for (const m of messages.slice(-Math.max(1, n))) {
      const content = (m as { content?: unknown }).content;
      if (typeof content === 'string') {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
            const text = (part as { text?: unknown }).text;
            if (typeof text === 'string') parts.push(text);
          }
        }
      }
    }
    return parts.join('\n');
  };

  /** Depth-tagged fired lore for the current turn, budgeted, as inject chunks. */
  const buildDepthLore = (scanText: string): LoreDepthChunk[] => {
    if (!lorebookEnabled) return [];
    const depthLore = state.entries.filter((e) => e.kind === 'lore' && e.lore?.depth !== undefined);
    if (depthLore.length === 0) return [];
    const fired = matchLore(depthLore, scanText);
    if (fired.length === 0) return [];
    const chunks: LoreChunk[] = fired
      .map((entry) => ({ entry, body: substituteMacros(readEntryBody(state.cast, entry) ?? '', macroCtx()).trim() }))
      .filter((c) => c.body.length > 0);
    const { kept } = selectWithinBudget(chunks, loadRoleplayConfig(cwd, envCharBudget).loreCharBudget);
    return kept.map((c) => ({ name: c.entry.name, body: c.body, depth: c.entry.lore?.depth ?? 0 }));
  };

  /** The most-recent assistant replies (text only), last `window` of them, for repetition scanning. */
  const collectAssistantTexts = (messages: readonly unknown[], window: number): string[] => {
    const texts: string[] = [];
    for (const m of messages) {
      if ((m as { role?: unknown }).role !== 'assistant') continue;
      const content = (m as { content?: unknown }).content;
      if (typeof content === 'string') {
        if (content.trim().length > 0) texts.push(content);
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
          if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
            const text = (part as { text?: unknown }).text;
            if (typeof text === 'string') parts.push(text);
          }
        }
        if (parts.length > 0) texts.push(parts.join('\n'));
      }
    }
    return texts.slice(-Math.max(1, window));
  };

  /** N-gram exclusion set built from the cast's character bodies (signature phrases are never flagged). */
  const sheetExcludeSet = (ngram: number): Set<string> => {
    if (excludeCache && excludeCache.cast === state.cast && excludeCache.ngram === ngram) return excludeCache.set;
    const bodies: string[] = [];
    for (const e of state.entries) {
      if (e.kind !== 'character') continue;
      const body = readEntryBody(state.cast, e);
      if (body) bodies.push(body);
    }
    const set = buildExcludeSet(bodies, ngram);
    excludeCache = { cast: state.cast, ngram, set };
    return set;
  };

  /** Repetition / anti-slop nudge body for the current scene, or `null` when nothing repeats. */
  const buildRepetitionNudge = (messages: readonly unknown[]): string | null => {
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    if (!cfg.repetitionEnabled) return null;
    const texts = collectAssistantTexts(messages, cfg.repetitionWindow);
    if (texts.length === 0) return null;
    const phrases = detectRepetition(texts, sheetExcludeSet(cfg.repetitionNgram), {
      ngram: cfg.repetitionNgram,
      window: cfg.repetitionWindow,
      minCount: cfg.repetitionMinCount,
    });
    return formatRepetitionNudge(phrases);
  };

  /** One-line cast descriptors for the event generator. */
  const characterSummaries = (): string[] =>
    state.entries.filter((e) => e.kind === 'character').map((e) => `${e.name}: ${e.description}`);

  /** All dangling relationship threads across the cast, for event seeding. */
  const openThreadsForCast = (): string[] => {
    const threads: string[] = [];
    for (const e of state.entries) {
      if (e.kind === 'relationship' && e.relationship) threads.push(...e.relationship.openThreads);
    }
    return threads;
  };

  // ── Summarizer infrastructure (shared by the roll + the compaction side-write) ─
  const extDir = dirname(fileURLToPath(import.meta.url));
  const readLayer = makeNodeReadLayer();
  let summarizer: Summarizer<Model<any>> | null = null;
  let summarizerInit = false;

  /** Persisted child-session manager, falling back to in-memory when the parent is untracked (`--no-session`). */
  const summarizerSessionManager = (ctx: ExtensionContext, childCwd: string): SessionManager => {
    try {
      return createPersistedSubagentSessionManager<SessionManager>({
        parentSessionManager: ctx.sessionManager,
        extensionLabel: 'roleplay-summarize',
        cwd: childCwd,
        SessionManager,
      });
    } catch {
      // Non-load-bearing: an untracked parent session must not block the
      // side-write. We lose the child transcript, not the summary.
      return SessionManager.inMemory(childCwd);
    }
  };

  /** Build the summarizer once (settings + agent resolution), then reuse it. */
  const getSummarizer = (ctx: ExtensionContext): Summarizer<Model<any>> | null => {
    if (summarizerInit) return summarizer;
    summarizerInit = true;
    try {
      const settings = resolveSummarizeSettings({ cwd });
      let agent: AgentDef | null = null;
      try {
        const layers = defaultAgentLayers({ extensionDir: extDir, cwd });
        const load = loadAgents({
          layers,
          knownToolNames: new Set(pi.getAllTools().map((t) => t.name)),
          fs: readLayer,
          parseFrontmatter,
        });
        agent = load.agents.get('roleplay-summarizer') ?? null;
      } catch {
        agent = null;
      }
      summarizer = createSummarizer<Model<any>>({
        settings,
        summarizerAgent: agent,
        maxOutputChars: loadRoleplayConfig(cwd, envCharBudget).summarizeMaxChars,
        runOneShot: async (args) => {
          // Pin the summarizer's neutral sampler (frontmatter `requestOptions`)
          // onto the child's provider request. runOneShotAgent loads the child
          // with noExtensions, so the only way the recap sampler is applied is
          // an inline gate factory here - the persona's before_provider_request
          // never fires in the child (no leak), so this is the pin, not a fight
          // against the persona merge.
          const gateFactory = args.agent.requestOptions
            ? createAgentGateFactory({
                config: {
                  name: args.agent.name,
                  bashAllow: [],
                  bashDeny: [],
                  resolvedWriteRoots: [],
                  requestOptions: args.agent.requestOptions,
                },
                enforceWriteRoots: false,
                resolveAbsolute: (_cwd, p) => p,
              })
            : null;
          const result = await runOneShotAgent({
            deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
            cwd: args.cwd,
            agent: args.agent,
            model: args.model,
            task: args.task,
            modelRegistry: args.modelRegistry,
            agentDir: getAgentDir(),
            sessionManager: summarizerSessionManager(ctx, args.cwd),
            ...(gateFactory ? { extensionFactories: [gateFactory as never] } : {}),
            ...(args.signal ? { signal: args.signal } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return {
            finalText: result.finalText,
            stopReason: result.stopReason,
            ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          };
        },
        log: (level, message) => {
          try {
            ctx.ui.notify(`roleplay summarize: ${message}`, level === 'warn' ? 'warning' : 'info');
          } catch {
            /* notify is best-effort */
          }
        },
      });
    } catch {
      summarizer = null;
    }
    return summarizer;
  };

  /** Flatten an `AgentMessage` into a `{role, text}` pair for the summarizer (drops non-text parts). */
  const toSummarizable = (m: unknown): SummarizableMessage => {
    const role = typeof (m as { role?: unknown }).role === 'string' ? (m as { role: string }).role : 'unknown';
    const content = (m as { content?: unknown }).content;
    const parts: string[] = [];
    if (typeof content === 'string') {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') parts.push(text);
        }
      }
    }
    return { role, text: parts.join('\n') };
  };

  // ── Rolling context-window helpers (bounded recap mode + condense floor) ─
  const windowOptions = (): WindowOptions => {
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    return { keepTurns: cfg.keepTurns, assistantChars: cfg.windowAssistantChars, userChars: cfg.windowUserChars };
  };
  /** Roll cadence: config `recapStride` when >0 (env-foldable), else `recapChunk` (aged messages per roll). */
  const strideValue = (): number => {
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    return cfg.recapStride > 0 ? cfg.recapStride : cfg.recapChunk;
  };
  /** Async recap tri-state (config `recapAsync` / env): `null` = auto by endpoint distinctness. */
  const recapAsyncForced = (): boolean | null => loadRoleplayConfig(cwd, envCharBudget).recapAsync;
  /** Fact-capture gate: recap mode + config `capture` (env-foldable). Read lazily so project config applies. */
  const captureEnabled = (): boolean => recapMode && loadRoleplayConfig(cwd, envCharBudget).capture;
  const timelineEnabled = (): boolean => recapMode && loadRoleplayConfig(cwd, envCharBudget).timeline;

  interface RecapModelInfo {
    model: { id?: string; provider?: string; contextWindow?: number } | undefined;
    /** True when the recap runs on a DISTINCT endpoint from the session model (=> async-safe). */
    distinct: boolean;
  }
  /**
   * Resolve the model the summarizer will run on (its window sizes
   * `maxSpanChars`) and whether it is a distinct endpoint from the session
   * model (a separate endpoint can run the recap concurrently => async).
   */
  const resolveRecapModelInfo = (ctx: ExtensionContext): RecapModelInfo => {
    const sm = ctx.model as { id?: string; provider?: string; contextWindow?: number } | undefined;
    let spec: string | undefined;
    try {
      spec = resolveSummarizeSettings({ cwd })?.summarizeModel;
    } catch {
      spec = undefined;
    }
    if (!spec) return { model: sm, distinct: false };
    const parsed = parseModelSpec(spec);
    const reg = ctx.modelRegistry as unknown as { find?: (p: string, id: string) => unknown };
    let m: unknown;
    try {
      m = parsed && reg.find ? reg.find(parsed.provider, parsed.modelId) : undefined;
    } catch {
      m = undefined;
    }
    const mm = m as { id?: string; provider?: string; contextWindow?: number } | undefined;
    // Distinct = a genuinely separate endpoint that can serve the recap and
    // the main turn concurrently. Key on PROVIDER only: the endpoint boundary
    // is the provider prefix (e.g. `llama-cpp/` vs `local/`), not the model
    // id. Two different ids under one provider share a single instance, so an
    // id-based check would wrongly pick async and collide on that instance.
    const distinct = !!mm && mm.provider !== sm?.provider;
    return { model: mm ?? sm, distinct };
  };

  interface RecapResult {
    next: string | null;
    applied: boolean;
    spanLen: number;
    priorLen: number;
    startedAt: number;
  }
  /**
   * One recap pass over the aged span: derive the span cap from the recap
   * model's window (fixes the historic 8000-char silent-loss bug), render +
   * summarize via the roleplay-summarizer subagent, and apply the
   * `acceptRecap` collapse guard. Pure w.r.t. extension state - the caller
   * commits `recapText` / `recapCutoff` (gen-guarded on the async path).
   */
  const doRecap = async (
    ctx: ExtensionContext,
    span: SummarizableMessage[],
    prior: string,
    info: RecapModelInfo,
    signal: AbortSignal | undefined,
  ): Promise<RecapResult> => {
    const startedAt = Date.now();
    const priorLen = prior.length;
    const sum = getSummarizer(ctx);
    if (!sum?.isEnabled()) return { next: null, applied: false, spanLen: 0, priorLen, startedAt };
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    const maxSpanChars = deriveMaxSpanChars({
      contextWindowTokens: info.model?.contextWindow,
      priorRecapChars: priorLen,
      charsPerToken,
    });
    const plan = planSummarization(span, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
    if (!plan) return { next: null, applied: false, spanLen: 0, priorLen, startedAt };
    let next: string | null = null;
    try {
      next = await sum.summarize(
        { cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never, signal },
        plan.spanText,
        prior.trim() ? prior : undefined,
      );
    } catch {
      next = null;
    }
    return { next, applied: acceptRecap(prior, next), spanLen: plan.messageCount, priorLen, startedAt };
  };

  /** Snapshot the current session id (`null` under `--no-session`). Read at call sites, never inside an async `.then`. */
  const currentSessionId = (ctx: ExtensionContext): string | null => {
    try {
      return ctx.sessionManager?.getSessionId() ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Persist an accepted recap. The within-session / resume / fork store is now
   * the SESSION BRANCH (the `roleplay-context-recap` audit entry written on
   * every roll - see {@link writeRecapAudit}), so this only refreshes the
   * per-cast CARRY-OVER (`summary/auto.md`), the cross-session seed a genuinely
   * new tree inherits (decision 1). Last-writer-wins / lossy by design. The
   * `sid` is unused now that the redundant `sessions/<sid>.md` live tier is
   * retired; it is kept in the signature for call-site symmetry.
   */
  const writeRecapRecord = (recap: string, _sid: string | null): void => {
    const rec = composeAutoSummaryRecord(recap);
    const serialized = serializeEntry({
      name: rec.name,
      description: rec.description,
      kind: 'summary',
      body: rec.body,
    });
    try {
      atomicWriteFile(fileFor(state.cast, 'summary', rec.id), serialized);
    } catch {
      /* durable write is best-effort; the in-memory recap still carries the turn */
    }
  };

  /** Auditable per-recap log entry (custom entry, never sent to the LLM). Runs on both sync + async paths. */
  const writeRecapAudit = (o: {
    result: RecapResult;
    model: RecapModelInfo['model'];
    spanFrom: number;
    spanTo: number;
    mode: 'sync' | 'async';
  }): void => {
    try {
      pi.appendEntry('roleplay-context-recap', {
        ts: o.result.startedAt,
        durationMs: Date.now() - o.result.startedAt,
        model: o.model?.id ?? null,
        coveredFrom: o.spanFrom,
        coveredTo: o.spanTo,
        spanMessages: o.result.spanLen,
        priorChars: o.result.priorLen,
        mode: o.mode,
        ok: o.result.next !== null,
        applied: o.result.applied,
        candidateChars: o.result.next?.length ?? 0,
        recapChars: recapText.length,
        // The actual recap text, so drift is inspectable from the audit log
        // itself (its stated purpose) without opening `summary/auto.md`.
        // `candidate` is this roll's raw generation; `recap` is the effective
        // recap now in force (prior one held when a generation is rejected).
        candidate: o.result.next ?? null,
        recap: recapText,
      });
    } catch {
      /* audit write is best-effort */
    }
  };

  /**
   * Build a lazy extractor runner for one of the roleplay extractor agents
   * (`roleplay-fact-extractor` / `roleplay-timeline-extractor`). Returns a
   * runner that takes a task and returns the raw response text, or `null`
   * when the agent is not installed. Mirrors the summarizer wiring; the
   * frontmatter `requestOptions` (low temp) is pinned via the same inline
   * agent-gate factory (the child loads with noExtensions).
   */
  const buildExtractorRunner = (
    agentName: string,
  ): ((ctx: ExtensionContext, task: string) => Promise<string | null>) | null => {
    let agent: AgentDef | null = null;
    try {
      const layers = defaultAgentLayers({ extensionDir: extDir, cwd });
      const load = loadAgents({
        layers,
        knownToolNames: new Set(pi.getAllTools().map((t) => t.name)),
        fs: readLayer,
        parseFrontmatter,
      });
      agent = load.agents.get(agentName) ?? null;
    } catch {
      agent = null;
    }
    if (!agent) return null;
    const settings = (() => {
      try {
        return resolveSummarizeSettings({ cwd });
      } catch {
        return null;
      }
    })();
    const theAgent = agent;
    return async (rctx, task) => {
      const resolution = resolveChildModel({
        override: settings?.summarizeModel,
        agent: theAgent,
        parent: rctx.model,
        modelRegistry: rctx.modelRegistry as never,
      });
      if (!resolution.ok) return null;
      const gateFactory = theAgent.requestOptions
        ? createAgentGateFactory({
            config: {
              name: theAgent.name,
              bashAllow: [],
              bashDeny: [],
              resolvedWriteRoots: [],
              requestOptions: theAgent.requestOptions,
            },
            enforceWriteRoots: false,
            resolveAbsolute: (_cwd, p) => p,
          })
        : null;
      try {
        const result = await runOneShotAgent({
          deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
          cwd,
          agent: theAgent,
          model: resolution.model,
          task,
          modelRegistry: rctx.modelRegistry as never,
          agentDir: getAgentDir(),
          sessionManager: summarizerSessionManager(rctx, cwd),
          ...(gateFactory ? { extensionFactories: [gateFactory as never] } : {}),
          ...(rctx.signal ? { signal: rctx.signal } : {}),
          timeoutMs: 60000,
        });
        return result.stopReason === 'completed' ? result.finalText : null;
      } catch {
        return null;
      }
    };
  };

  /**
   * Lazily load + wire the `roleplay-fact-extractor` subagent. Returns a
   * runner that takes a task and returns the raw response text, or `null`
   * when the agent is not installed. Mirrors the summarizer wiring; the
   * frontmatter `requestOptions` (low temp) is pinned via the same inline
   * agent-gate factory (the child loads with noExtensions).
   */
  const getFactExtractor = (
    _ctx: ExtensionContext,
  ): ((ctx: ExtensionContext, task: string) => Promise<string | null>) | null => {
    if (factExtractorInit) return factExtractor;
    factExtractorInit = true;
    factExtractor = buildExtractorRunner('roleplay-fact-extractor');
    return factExtractor;
  };

  /**
   * Lazily load + wire the `roleplay-timeline-extractor` subagent (C3). Same
   * wiring as {@link getFactExtractor} - a distinct agent name, the same
   * low-temp gate + recap-endpoint model resolution - so both extractors run
   * on the summarize endpoint.
   */
  const getTimelineExtractor = (
    _ctx: ExtensionContext,
  ): ((ctx: ExtensionContext, task: string) => Promise<string | null>) | null => {
    if (timelineExtractorInit) return timelineExtractor;
    timelineExtractorInit = true;
    timelineExtractor = buildExtractorRunner('roleplay-timeline-extractor');
    return timelineExtractor;
  };

  /**
   * Deterministic fact capture on the roll: extract durable facts from the
   * aged span with the `roleplay-fact-extractor` subagent and pin them to
   * `memory`'s SESSION (`note`) tier (header-carried name + description).
   * Default-OFF (`PI_ROLEPLAY_CAPTURE`) - a novel model-call path whose
   * extraction quality is validated in the rp-test small-window smoke; it
   * degrades to a no-op with no session id (`--no-session`) or when disabled.
   * De-dups against session notes already on disk + those written this
   * process. Best-effort; never throws.
   */
  /**
   * Write facts to memory's SESSION note tier, de-duping against notes
   * already on disk (fuzzy name match) + those captured this process.
   * Rebuilds the session `MEMORY.md` when anything landed. Returns the facts
   * ACTUALLY written, so the caller can mirror just those to the per-cast
   * carry-over sidecar. `sid` must be non-null. Best-effort; never throws.
   */
  const writeFactsToSessionMemory = (
    sid: string,
    facts: readonly { name: string; description: string }[],
  ): { name: string; description: string }[] => {
    const written: { name: string; description: string }[] = [];
    try {
      const { state: memState } = rebuildMemoryIndex(cwd, sid);
      const sessionEntries = [...memState.index.session];
      const taken = new Set(sessionEntries.map((e) => e.id));
      const isDup = (name: string, description: string): boolean => {
        if (capturedFacts.has(name.toLowerCase())) return true;
        return findSimilarMemories({ name, description, body: description }, sessionEntries, () => null).length > 0;
      };
      const now = new Date().toISOString();
      for (const fact of facts) {
        if (isDup(fact.name, fact.description)) {
          capturedFacts.add(fact.name.toLowerCase());
          continue;
        }
        const slug = memoryUniqueSlug(memorySlugifyName(fact.name), taken);
        taken.add(slug);
        const entry: MemoryEntry = {
          id: slug,
          scope: 'session',
          type: 'note',
          name: fact.name,
          description: fact.description,
          created: now,
          updated: now,
        };
        atomicWriteFile(
          memoryFileFor('session', 'note', slug, cwd, sid),
          serializeMemory({
            name: fact.name,
            description: fact.description,
            type: 'note',
            body: fact.description,
            created: now,
            updated: now,
          }),
        );
        sessionEntries.push(entry);
        capturedFacts.add(fact.name.toLowerCase());
        written.push({ name: fact.name, description: fact.description });
      }
      if (written.length > 0) {
        // Rebuild the session MEMORY.md so a resume (memory rescans on
        // session_start) picks the facts up. NOTE: memory.ts injects from its
        // cached index within a live session, so newly-captured notes surface
        // in the injected index only after memory rebuilds (next session / a
        // memory tool call), not necessarily the same turn.
        try {
          atomicWriteFile(memoryIndexFileFor('session', cwd, sid), renderMemoryMd(sessionEntries, 'session'));
        } catch {
          /* index rebuild is best-effort */
        }
      }
    } catch {
      /* memory write must never break a turn */
    }
    return written;
  };

  /**
   * Mirror captured facts to the per-cast carry-over sidecar
   * (`facts/<slug>.md`), de-duping against sidecars already on disk (B1).
   * The sidecar is the durable per-cast seed a future session hydrates from;
   * the session note tier stays the session-isolated live layer.
   */
  const mirrorFactsToCarryOver = (facts: readonly { name: string; description: string }[]): void => {
    if (facts.length === 0) return;
    try {
      const sidecars = listFactSidecars(state.cast);
      const takenSidecar = new Set(sidecars.map((f) => f.slug));
      const sidecarEntries: MemoryEntry[] = sidecars.map((f) => ({
        id: f.slug,
        scope: 'session',
        type: 'note',
        name: f.name,
        description: f.description,
        created: '',
        updated: '',
      }));
      for (const fact of facts) {
        const dup =
          findSimilarMemories(
            { name: fact.name, description: fact.description, body: fact.description },
            sidecarEntries,
            () => null,
          ).length > 0;
        if (dup) continue;
        const slug = memoryUniqueSlug(memorySlugifyName(fact.name), takenSidecar);
        takenSidecar.add(slug);
        sidecarEntries.push({
          id: slug,
          scope: 'session',
          type: 'note',
          name: fact.name,
          description: fact.description,
          created: '',
          updated: '',
        });
        atomicWriteFile(
          factFile(state.cast, slug),
          serializeEntry({ name: fact.name, description: fact.description, kind: 'summary', body: '' }),
        );
      }
    } catch {
      /* carry-over sidecar is best-effort */
    }
  };

  /**
   * One-shot seed of the per-cast carry-over facts (`facts/*.md`) into this
   * session's memory note tier, so a fresh session inherits the pinned
   * specifics alongside the recap seed (B2). Runs only on a NON-resume load
   * (`sceneSeeded`) with a real session id, and only once per load.
   */
  const seedCarryOverFacts = (sid: string): void => {
    const facts = listFactSidecars(state.cast).map((f) => ({ name: f.name, description: f.description }));
    if (facts.length === 0) return;
    writeFactsToSessionMemory(sid, facts);
  };

  /**
   * Append new beats to the two-tier timeline append-logs: the live
   * `timeline/sessions/<sid>.md` (this session's beats) and the carry-over
   * `timeline/auto.md` (per-cast seed, interleaves all sessions). APPEND-ONLY
   * (never rewrite), so concurrent same-cast sessions just add distinct lines
   * with no clobber. Also folds the new lines into the in-memory
   * `timelineText` used for injection. Best-effort; never throws.
   */
  const appendTimelineBeats = (lines: string): void => {
    if (lines.trim().length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    const compose = (body: string): string =>
      serializeEntry({
        name: 'Auto timeline',
        description: `Chronological scene beats, auto-updated ${date}`,
        kind: 'timeline',
        body,
      });
    const appended = (existing: string): string => (existing.trim() ? `${existing.trimEnd()}\n${lines}` : lines);
    // Carry-over append-log (cross-session seed for future sessions). The
    // within-session / resume / fork store is the SESSION BRANCH (the
    // `roleplay-timeline` audit entry stamps the cumulative timeline every
    // roll - see captureTimeline), so the redundant `sessions/<sid>.md` live
    // tier is retired; this only refreshes the per-cast carry-over.
    try {
      const existing = readEntryBody(state.cast, { id: 'auto', kind: 'timeline', name: '', description: '' }) ?? '';
      atomicWriteFile(fileFor(state.cast, 'timeline', 'auto'), compose(appended(existing)));
    } catch {
      /* carry-over append best-effort */
    }
    // Keep the injected timeline current in-memory too.
    timelineText = timelineText.trim() ? `${timelineText.trimEnd()}\n${lines}` : lines;
  };

  /**
   * Additive, anti-drift timeline capture on the roll: extract dated story
   * beats from the aged span with the `roleplay-timeline-extractor` subagent
   * and APPEND them to the two-tier timeline logs. Runs on the SAME span as
   * the recap + capture, AFTER the recap resolves (shares the recap endpoint,
   * so it must not run concurrently) and is AWAITED (never fire-and-forget).
   * Default-OFF (`PI_ROLEPLAY_TIMELINE`); best-effort, never throws.
   */
  const captureTimeline = async (
    ctx: ExtensionContext,
    span: SummarizableMessage[],
    sid: string | null,
  ): Promise<void> => {
    if (!timelineEnabled()) return;
    const audit = {
      sessionId: sid !== null,
      extractor: false,
      planned: false,
      rawChars: 0,
      parsed: 0,
      wrote: 0,
      skip: '' as string,
      // Cumulative active-branch timeline text, so a resume/fork can
      // rehydrate the timeline from the session log (branch-primary store)
      // instead of the branch-blind carry-over. Empty on skip paths.
      timeline: '' as string,
    };
    const emit = (): void => {
      try {
        pi.appendEntry('roleplay-timeline', { ts: Date.now(), ...audit });
      } catch {
        /* audit write is best-effort */
      }
    };
    try {
      const extractor = getTimelineExtractor(ctx);
      if (!extractor) {
        audit.skip = 'no-extractor';
        emit();
        return;
      }
      audit.extractor = true;
      const cfg = loadRoleplayConfig(cwd, envCharBudget);
      const info = resolveRecapModelInfo(ctx);
      const maxSpanChars = deriveMaxSpanChars({
        contextWindowTokens: info.model?.contextWindow,
        charsPerToken,
      });
      const plan = planSummarization(span, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
      if (!plan) {
        audit.skip = 'no-plan';
        emit();
        return;
      }
      audit.planned = true;
      const raw = await extractor(ctx, buildTimelineExtractionTask(plan.spanText));
      if (raw === null) {
        audit.skip = 'extractor-null';
        emit();
        return;
      }
      audit.rawChars = raw.length;
      const beats = parseTimelineBeats(raw);
      audit.parsed = beats.length;
      if (beats.length === 0) {
        audit.skip = 'no-beats';
        emit();
        return;
      }
      appendTimelineBeats(formatBeatLines(beats));
      audit.wrote = beats.length;
      // Snapshot the now-current cumulative timeline into the audit entry so
      // it doubles as the branch-primary timeline store (see
      // hydrateTimelineFromBranch).
      audit.timeline = timelineText;
      emit();
    } catch {
      audit.skip = 'error';
      emit();
    }
  };

  const captureFacts = async (ctx: ExtensionContext, span: SummarizableMessage[]): Promise<void> => {
    if (!captureEnabled()) return;
    // Auditable outcome (custom entry, never sent to the LLM). Emitted on
    // every return path so a zero-write run is debuggable: which gate hit.
    const audit = {
      sessionId: false,
      extractor: false,
      planned: false,
      rawChars: 0,
      parsed: 0,
      wrote: 0,
      skip: '' as string,
    };
    const emit = (): void => {
      try {
        pi.appendEntry('roleplay-capture', { ts: Date.now(), ...audit });
      } catch {
        /* audit write is best-effort */
      }
    };
    let sessionId: string | null = null;
    try {
      sessionId = ctx.sessionManager?.getSessionId() ?? null;
    } catch {
      sessionId = null;
    }
    if (!sessionId) {
      audit.skip = 'no-session'; // --no-session: capture is a silent no-op
      emit();
      return;
    }
    audit.sessionId = true;
    try {
      const extractor = getFactExtractor(ctx);
      if (!extractor) {
        audit.skip = 'no-extractor';
        emit();
        return;
      }
      audit.extractor = true;
      const cfg = loadRoleplayConfig(cwd, envCharBudget);
      const info = resolveRecapModelInfo(ctx);
      const maxSpanChars = deriveMaxSpanChars({
        contextWindowTokens: info.model?.contextWindow,
        charsPerToken,
      });
      const plan = planSummarization(span, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
      if (!plan) {
        audit.skip = 'no-plan';
        emit();
        return;
      }
      audit.planned = true;
      const raw = await extractor(ctx, buildFactExtractionTask(plan.spanText));
      if (raw === null) {
        audit.skip = 'extractor-null';
        emit();
        return;
      }
      audit.rawChars = raw.length;
      const candidates = parseFactCandidates(raw);
      audit.parsed = candidates.length;
      if (candidates.length === 0) {
        audit.skip = 'no-candidates';
        emit();
        return;
      }

      // Write to the session note tier (live layer) + mirror to the per-cast
      // carry-over sidecar (durable seed for future sessions).
      const written = writeFactsToSessionMemory(sessionId, candidates);
      mirrorFactsToCarryOver(written);
      const wrote = written.length;
      audit.wrote = wrote;
      if (wrote > 0) {
        try {
          ctx.ui.notify(`roleplay: captured ${wrote} durable fact(s) to session memory.`, 'info');
        } catch {
          /* notify is best-effort */
        }
      } else {
        audit.skip = 'all-duplicates';
      }
      emit();
    } catch {
      // Capture must never break a turn.
      audit.skip = 'error';
      emit();
    }
  };

  if (contextWindowEnabled || depthInjectEnabled || repetitionEnabled || eventsEnabled) {
    // Recover a running recap from the SESSION BRANCH (custom recap-audit
    // entries), which travels with pi's session tree and carries the exact
    // coverage boundary. This is the authoritative resume source when the
    // file store has no record for this session - e.g. a session first managed
    // by the retired `rp-context-window` experiment (entries named
    // `rp-context-recap`), or one whose `summary/` files were lost. Without it,
    // resuming a long pre-file-store session cold-starts at recapCutoff 0 and
    // the drop boundary never engages (observed: a 1674-message scene overflowed
    // the model window). Scans newest-first for the last applied recap.
    const hydrateRecapFromBranch = (
      c: { sessionManager?: unknown },
      natural: number,
    ): { recap: string; coveredTo: number } | null => {
      let entries: Record<string, unknown>[] | undefined;
      try {
        entries = (c.sessionManager as { getBranch?: () => Record<string, unknown>[] } | undefined)?.getBranch?.();
      } catch {
        entries = undefined;
      }
      if (!Array.isArray(entries)) return null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.type !== 'custom') continue;
        const ct = e.customType;
        if (ct !== 'roleplay-context-recap' && ct !== 'rp-context-recap') continue;
        const data = e.data as { recap?: unknown; coveredTo?: unknown; applied?: unknown } | undefined;
        if (data?.applied === false) continue;
        const text = typeof data?.recap === 'string' ? data.recap.trim() : '';
        if (!text) continue;
        const coveredTo = typeof data?.coveredTo === 'number' ? data.coveredTo : 0;
        return { recap: text, coveredTo: Math.max(0, Math.min(coveredTo, natural)) };
      }
      return null;
    };

    // Recover this branch's cumulative timeline from the SESSION BRANCH.
    // `captureTimeline` stamps the full cumulative timeline text into each
    // `roleplay-timeline` audit entry, and `getBranch()` only returns entries
    // on the active root-to-leaf path, so a resume/fork rehydrates the
    // timeline that belongs to ITS path - not a sibling branch's or the
    // branch-blind carry-over. Scans newest-first for the latest non-empty
    // timeline snapshot. Mirrors `hydrateRecapFromBranch`.
    const hydrateTimelineFromBranch = (c: { sessionManager?: unknown }): string | null => {
      let entries: Record<string, unknown>[] | undefined;
      try {
        entries = (c.sessionManager as { getBranch?: () => Record<string, unknown>[] } | undefined)?.getBranch?.();
      } catch {
        entries = undefined;
      }
      if (!Array.isArray(entries)) return null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.type !== 'custom') continue;
        if (e.customType !== 'roleplay-timeline') continue;
        const data = e.data as { timeline?: unknown } | undefined;
        const text = typeof data?.timeline === 'string' ? data.timeline.trim() : '';
        if (text) return text;
      }
      return null;
    };

    pi.on('context', async (event, ctx) => {
      if (activeCast() === null) return undefined;
      // Capture the live scene so the `/roleplay event` command (which runs
      // between turns, without message access) can read recent context.
      lastMessages = event.messages;

      let messages = event.messages as unknown as readonly Record<string, unknown>[];
      let changed = false;

      // Rolling window: bounded recap drop (recap mode) or condense-only
      // floor. Runs first so depth-inject / reminders below operate on the
      // already-reduced list (they are tail-oriented, unaffected by the drop).
      if (contextWindowEnabled) {
        const opts = windowOptions();
        const natural = computeCutoff(messages, opts.keepTurns);
        // Fresh / shorter conversation (new run, branch switch, resume): drop stale state.
        if (natural < committedCutoff) resetWindowState();

        // Calibrate chars/token against the PREVIOUS turn's reported usage
        // (ground truth) so the span-budget math is measured, not guessed.
        try {
          const usage = ctx.getContextUsage?.();
          if (usage && typeof usage.tokens === 'number' && usage.tokens > 0 && lastSentEstChars > 0) {
            charsPerToken = updateCharsPerToken(charsPerToken, lastSentEstChars, usage.tokens);
          }
        } catch {
          /* usage is best-effort */
        }

        // Lazily hydrate the recap from the durable summary/auto record once
        // per (re)load, so a resume continues the memory instead of rebuilding
        // it. Assume the record covers everything currently aged (the record
        // does not store its cutoff index); new turns roll forward normally.
        if (!recapHydrated) {
          recapHydrated = true;
          if (recapMode) {
            const sid = currentSessionId(ctx);
            // 1. PRIMARY: recover this branch's recap from the SESSION LOG.
            //    Every roll appends a `roleplay-context-recap` custom entry
            //    carrying the recap + exact coverage boundary, and
            //    `getBranch()` only returns entries on the active root-to-leaf
            //    path. So this is fork-correct by construction: an edited /
            //    regenerated / forked branch continues ITS own recap, never a
            //    stale sibling's, and it carries the exact `coveredTo` instead
            //    of guessing. A resume (branch continuity) -> NO fact reseed.
            const branchRecap = hydrateRecapFromBranch(ctx, natural);
            if (branchRecap) {
              recapText = branchRecap.recap;
              recapCutoff = branchRecap.coveredTo;
              committedCutoff = branchRecap.coveredTo;
              // Timeline: prefer this branch's cumulative timeline (same
              // active-path guarantee); fall back to the per-cast carry-over
              // log when the branch carries no timeline entry.
              const branchTimeline = hydrateTimelineFromBranch(ctx);
              const priorTimeline =
                branchTimeline ??
                readEntryBody(state.cast, { id: 'auto', kind: 'timeline', name: '', description: '' }) ??
                '';
              if (priorTimeline.trim()) timelineText = priorTimeline.trim();
            } else {
              // 2. New tree (genuinely fresh session, or a fork with no recap
              //    on its path yet): `getBranch()` has nothing to hydrate, so
              //    seed continuity from the per-cast carry-over. `recapCutoff =
              //    natural` is an accepted approximation here (the seed is
              //    narrative continuity; the floor + first roll re-anchor the
              //    coverage boundary). 3. Cold start: no carry-over -> recapText
              //    stays ''. Either way this load is a non-resume, so the
              //    one-shot facts seed (B2) may run.
              const priorEntry = state.entries.find((e) => e.kind === 'summary' && e.id === 'auto');
              const prior = priorEntry ? (readEntryBody(state.cast, priorEntry) ?? '') : '';
              if (prior.trim()) {
                recapText = prior.trim();
                recapCutoff = natural;
                committedCutoff = natural;
              }
              // Seed the timeline from the per-cast carry-over log (C5).
              const priorTimeline =
                readEntryBody(state.cast, { id: 'auto', kind: 'timeline', name: '', description: '' }) ?? '';
              if (priorTimeline.trim()) timelineText = priorTimeline.trim();
              // B2: seed the per-cast carry-over facts (facts/*.md) into this
              // session's memory note tier so a fresh session inherits the
              // pinned specifics alongside the recap seed - not just the
              // narrative. Gated by capture (the whole facts machinery is).
              if (sid && captureEnabled()) seedCarryOverFacts(sid);
            }
          }
        }

        // Roll only when the frozen boundary has advanced by at least `stride`
        // aged messages. Between rolls the condensed prefix + recap are frozen
        // (byte-identical), so the prompt-prefix cache is reused.
        if (planRecap(natural, committedCutoff, strideValue())) {
          if (recapMode) {
            const info = resolveRecapModelInfo(ctx);
            const wantAsync = recapAsyncForced() ?? info.distinct;
            // Snapshot the session id at roll-plan time (decision a): the async
            // path must not read it inside its `.then` (the manager may be gone).
            const sid = currentSessionId(ctx);
            const spanFrom = recapCutoff;
            const spanTo = natural;
            const span = messages.slice(spanFrom, spanTo).map(toSummarizable);
            if (wantAsync) {
              // Non-blocking: at most one background recap; return on the PRIOR
              // recap. The floor keeps the not-yet-covered span present until
              // the result lands, so nothing is lost; the drop boundary just
              // advances a turn or two later. gen-guarded against a
              // reset / branch change clobbering the current recap after the fact.
              if (!recapInFlight) {
                recapInFlight = true;
                const gen = recapGen;
                const prior = recapText;
                recapAbort = new AbortController();
                void doRecap(ctx, span, prior, info, recapAbort.signal)
                  .then(async (result) => {
                    if (gen !== recapGen) return; // stale (reset / branch change): discard
                    if (result.applied && result.next) {
                      recapText = result.next;
                      recapCutoff = spanTo;
                      writeRecapRecord(result.next, sid);
                    }
                    writeRecapAudit({ result, model: info.model, spanFrom, spanTo, mode: 'async' });
                    if (result.applied && result.next) {
                      // Capture runs SEQUENTIALLY after the recap, and is
                      // AWAITED inside the chain so `recapInFlight` stays set
                      // until it finishes. Both matter: the fact-extractor
                      // shares the recap endpoint, so awaiting stops the next
                      // roll from starting a concurrent recap on that single
                      // instance, and keeps capture from being orphaned as a
                      // fire-and-forget promise when the turn returns.
                      await captureFacts(ctx, span);
                      // Timeline runs AFTER capture, sequential + awaited, for
                      // the same single-endpoint reason (C4).
                      await captureTimeline(ctx, span, sid);
                    }
                  })
                  .catch(() => {
                    /* keep prior recap + floor; retried on the next roll */
                  })
                  .finally(() => {
                    if (gen === recapGen) {
                      recapInFlight = false;
                      recapAbort = null;
                    }
                  });
              }
            } else {
              // Blocking (inherited / same endpoint): one llama.cpp instance
              // cannot serve the recap and the main turn concurrently.
              const result = await doRecap(ctx, span, recapText, info, ctx.signal);
              if (result.applied && result.next) {
                recapText = result.next;
                recapCutoff = spanTo;
                writeRecapRecord(result.next, sid);
                await captureFacts(ctx, span);
                await captureTimeline(ctx, span, sid);
              }
              writeRecapAudit({ result, model: info.model, spanFrom, spanTo, mode: 'sync' });
            }
          }
          committedCutoff = natural;
        }

        // Hard safety floor: guarantee the reduced prompt fits the session
        // model's context window even when the recap drop boundary cannot
        // advance - an empty/stale recap after a cold resume, or a dead recap
        // endpoint. Without it, recapCutoff can sit at 0 and condense-only
        // cannot bound a thousand-message scene, so the request overflows the
        // server window (observed: a 1674-message session resumed with an empty
        // recap hit 130k > 57k and the model rejected it). We drop oldest whole
        // user-turns beyond the token budget; when the floor outruns the recap
        // coverage this drops uncovered scene memory, but a bounded prompt that
        // still runs beats a hard 400. In healthy operation floorCutoff is 0
        // (everything fits) or <= recapCutoff (the recap already dropped enough),
        // so dropCutoff == recapCutoff and there is no behavior change.
        let floorCutoff = 0;
        const windowTokens = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
        if (typeof windowTokens === 'number' && windowTokens > 0) {
          const cpt = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
          const sysChars = (typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '')?.length ?? 0;
          const injectChars = recapText.length + timelineText.length;
          // Reserve for the model's own output plus injection/formatting slack.
          const RESERVE_TOKENS = 3072;
          const convBudget = windowTokens - Math.round((sysChars + injectChars) / cpt) - RESERVE_TOKENS;
          const fitTurns = convBudget > 0 ? deriveKeepTurns(messages, convBudget, cpt, 1, 100000) : 1;
          floorCutoff = computeCutoff(messages, fitTurns);
        }
        const dropCutoff = Math.max(recapCutoff, floorCutoff);

        // Apply the window: layered drop+condense+inject (recap mode) or the
        // condense-only floor (recap off / summarize disabled).
        if (recapMode) {
          const layered = applyLayeredWindow(messages, dropCutoff, Math.max(dropCutoff, committedCutoff), opts);
          if (layered.dropped > 0 || layered.condensed > 0) {
            messages = layered.messages;
            changed = true;
          }
          if (recapText) {
            messages = injectRecap(messages, recapText);
            changed = true;
          }
          if (timelineText) {
            const block = renderTimelineBlock(timelineText, {
              maxChars: loadRoleplayConfig(cwd, envCharBudget).timelineMaxInjectChars,
            });
            if (block) {
              messages = injectTimeline(messages, block);
              changed = true;
            }
          }
        } else if (floorCutoff > 0) {
          // Non-recap mode but over the window budget: hard-drop oldest turns.
          const layered = applyLayeredWindow(messages, floorCutoff, committedCutoff, opts);
          if (layered.dropped > 0 || layered.condensed > 0) {
            messages = layered.messages;
            changed = true;
          }
        } else {
          const floor = applyContextWindowAt(messages, committedCutoff, opts);
          if (floor.condensed > 0) {
            messages = floor.messages;
            changed = true;
          }
        }

        // Opt-in per-turn composition audit (custom log entry, never sent to
        // the LLM) so the savings + token sawtooth are measurable.
        if (contextWindowDebug) {
          try {
            const sysChars = (typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '')?.length ?? 0;
            const fullChars = estimateChars(event.messages as unknown as readonly Record<string, unknown>[]);
            const sentChars = estimateChars(messages);
            const cpt = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
            pi.appendEntry('roleplay-context-window-debug', {
              ts: Date.now(),
              messagesIn: event.messages.length,
              messagesOut: messages.length,
              natural,
              committedCutoff,
              recapCutoff,
              floorCutoff,
              dropCutoff,
              recapMode,
              recapChars: recapText.length,
              charsPerToken: Math.round(cpt * 100) / 100,
              estSystemTokens: Math.round(sysChars / cpt),
              estFullPromptTokens: Math.round((sysChars + fullChars) / cpt),
              estSentPromptTokens: Math.round((sysChars + sentChars) / cpt),
              estSavedTokens: Math.round((fullChars - sentChars) / cpt),
            });
          } catch {
            /* best-effort */
          }
        }

        // Track what we sent so next turn can calibrate against its usage.
        try {
          const sysChars = (typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '')?.length ?? 0;
          lastSentEstChars = sysChars + estimateChars(messages);
        } catch {
          lastSentEstChars = 0;
        }
      }

      // Depth injection (author's note + depth-tagged lore) splices content
      // at depth; reminders below append ephemerally to the trailing message.
      if (depthInjectEnabled) {
        const persona = getActivePersona();
        const scanDepth = loadRoleplayConfig(cwd, envCharBudget).scanDepth;
        const insertions = buildInsertions({
          authorNote: persona?.authorNote ? substituteMacros(persona.authorNote, macroCtx()) : undefined,
          authorNoteDepth: persona?.authorNoteDepth,
          lore: buildDepthLore(recentText(messages as unknown as readonly unknown[], scanDepth)),
        });
        if (insertions.length > 0) {
          messages = applyInsertions(messages, insertions, (text) => ({
            role: 'user' as const,
            content: text,
            timestamp: Date.now(),
          }));
          changed = true;
        }
      }

      // Ephemeral, cache-friendly reminders: the repetition nudge and the
      // queued scene event, each under a stable id so re-applying is a
      // fixpoint and stale blocks are stripped when they no longer fire.
      const reminders: { id: string; body: string | null }[] = [];
      if (repetitionEnabled)
        reminders.push({
          id: 'roleplay-repetition',
          body: buildRepetitionNudge(messages as unknown as readonly unknown[]),
        });
      if (eventsEnabled) {
        reminders.push({ id: 'roleplay-event', body: pendingEvent ? formatEventDirector(pendingEvent) : null });
        if (pendingEvent) eventConsumed = true;
      }
      if (reminders.length > 0) {
        let rm = messages as unknown as ReminderMessage[];
        for (const spec of reminders) rm = applyContextReminder(rm, spec);
        if (reminders.some((r) => r.body)) {
          messages = rm as unknown as readonly Record<string, unknown>[];
          changed = true;
        }
      }

      return changed ? { messages: messages as unknown as typeof event.messages } : undefined;
    });
  }

  // ── Compaction side-write (manual / overflow) ───────────────────────
  //
  // The rolling window (context hook) owns the common path; this handler
  // only cancels pi's THRESHOLD auto-compaction and, on the manual /
  // overflow safety-net paths, folds the evicted span into `summary/auto`
  // (a strict side-write that never breaks compaction). Summarizer infra
  // (extDir / getSummarizer / toSummarizable) is defined above.
  if (summarizeEnabled) {
    pi.on('session_before_compact', async (event, ctx) => {
      const reason = (event as unknown as { reason?: string }).reason;
      // Own context management: cancel pi's THRESHOLD auto-compaction so the
      // rolling window is the sole manager and the see-saw stops. Only in
      // recap (size-bounded) mode; manual `/compact` and genuine overflow
      // recovery always run (belt-and-suspenders safety net).
      if (ownCompaction && reason === 'threshold') return { cancel: true };
      // Manual / overflow (or threshold when not owning): fold the evicted
      // span into the durable recap so continuity survives the compaction.
      try {
        if (activeCast() === null) return undefined;
        resyncIfChanged(ctx);
        if (state.cast.length === 0) return undefined;
        const cfg = loadRoleplayConfig(cwd, envCharBudget);
        const priorEntry = state.entries.find((e) => e.kind === 'summary' && e.id === 'auto');
        const prior = priorEntry ? (readEntryBody(state.cast, priorEntry) ?? undefined) : undefined;
        const info = resolveRecapModelInfo(ctx);
        const maxSpanChars = deriveMaxSpanChars({
          contextWindowTokens: info.model?.contextWindow,
          priorRecapChars: prior?.length ?? 0,
          charsPerToken,
        });
        const messages = (event.preparation?.messagesToSummarize ?? []).map(toSummarizable);
        const plan = planSummarization(messages, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
        if (!plan) return undefined;
        const sum = getSummarizer(ctx);
        if (!sum?.isEnabled()) return undefined;
        const recap = await sum.summarize(
          { cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never, signal: event.signal },
          plan.spanText,
          prior,
        );
        // Collapse guard: never let a degenerate recap clobber a longer prior.
        if (recap === null || !acceptRecap(prior ?? '', recap)) return undefined;
        // Two-tier: live per-session record + carry-over auto.md (A4).
        writeRecapRecord(recap, currentSessionId(ctx));
        // Re-scan so the index + in-memory state reflect the new record; a
        // subsequent context turn re-hydrates recapText from it.
        applyCast(state.cast, ctx);
        ctx.ui.notify(`roleplay: folded ${plan.messageCount} evicted message(s) into the auto recap.`, 'info');
      } catch {
        // Side-write must never break compaction.
      }
      return undefined;
    });
  }

  // ── Scene events (/roleplay event) ──────────────────────────────────
  //
  // `/roleplay event [hint]` queues a one-shot complication, generated by
  // the `roleplay-event` agent (default; always when a hint is given) and
  // falling back to the user's `events` deck. The generator mirrors the
  // summarizer wiring but, unlike it, stays enabled without an explicit
  // model (it inherits the parent session model) - only a missing agent
  // disables it.
  let eventGen: EventGenerator<Model<any>> | null = null;
  let eventGenInit = false;

  const eventSessionManager = (ctx: ExtensionContext, childCwd: string): SessionManager => {
    try {
      return createPersistedSubagentSessionManager<SessionManager>({
        parentSessionManager: ctx.sessionManager,
        extensionLabel: 'roleplay-event',
        cwd: childCwd,
        SessionManager,
      });
    } catch {
      return SessionManager.inMemory(childCwd);
    }
  };

  const getEventGenerator = (ctx: ExtensionContext): EventGenerator<Model<any>> | null => {
    if (eventGenInit) return eventGen;
    eventGenInit = true;
    try {
      const settings = resolveEventSettings({ cwd });
      let agent: AgentDef | null = null;
      try {
        const layers = defaultAgentLayers({ extensionDir: extDir, cwd });
        const load = loadAgents({
          layers,
          knownToolNames: new Set(pi.getAllTools().map((t) => t.name)),
          fs: readLayer,
          parseFrontmatter,
        });
        agent = load.agents.get('roleplay-event') ?? null;
      } catch {
        agent = null;
      }
      eventGen = createEventGenerator<Model<any>>({
        settings,
        eventAgent: agent,
        maxOutputChars: loadRoleplayConfig(cwd, envCharBudget).eventMaxChars,
        runOneShot: async (args) => {
          const result = await runOneShotAgent({
            deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
            cwd: args.cwd,
            agent: args.agent,
            model: args.model,
            task: args.task,
            modelRegistry: args.modelRegistry,
            agentDir: getAgentDir(),
            sessionManager: eventSessionManager(ctx, args.cwd),
            ...(args.signal ? { signal: args.signal } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return {
            finalText: result.finalText,
            stopReason: result.stopReason,
            ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          };
        },
        log: (level, message) => {
          try {
            ctx.ui.notify(`roleplay event: ${message}`, level === 'warn' ? 'warning' : 'info');
          } catch {
            /* notify is best-effort */
          }
        },
      });
    } catch {
      eventGen = null;
    }
    return eventGen;
  };

  // Mirror generated scene images into the avatar's `scene` banner. comfyui
  // EMITS on the neutral image bus when any `generate_image` render lands on
  // disk; we CONSUME it here (comfyui knows nothing about roleplay or the
  // avatar). Only while a roleplay scene is active, and only when both avatar
  // drive + scenegen are enabled, so a non-roleplay coding session that renders
  // an image never hijacks the widget.
  if (avatarDriveEnabled && sceneGenEnabled) {
    unsubscribeImageEvents = onImageGenerated((event) => {
      try {
        if (activeCast() === null) return;
        const path = event.savedPaths.at(-1);
        if (path) setAvatarInput({ scene: { path } });
      } catch {
        // a consumer must never break image generation
      }
    });
  }

  pi.on('session_shutdown', () => {
    try {
      clearActiveRoleplay();
      if (avatarDriveEnabled) clearAvatarInput();
      if (unsubscribeImageEvents) {
        unsubscribeImageEvents();
        unsubscribeImageEvents = null;
      }
    } catch {
      // teardown must never throw
    }
    state = emptyState();
    castOverride = null;
    syncedCast = null;
    pendingEvent = null;
    eventConsumed = false;
    excludeCache = null;
    resetWindowState();
  });

  // ── Actions ─────────────────────────────────────────────────────────

  const actList = (): ActionOut => ({
    content: formatText(state),
    details: { action: 'list', state: cloneState(state) },
  });

  const actRead = (params: RoleplayParamsT): ActionOut => {
    const resolved = resolveEntry(state, params);
    if ('error' in resolved) {
      return {
        content: `Error: ${resolved.error}`,
        details: { action: 'read', state: cloneState(state), error: resolved.error },
        isError: true,
      };
    }
    const body = readEntryBody(state.cast, resolved);
    if (body == null) {
      const error = `entry "${resolved.id}" not readable on disk`;
      return {
        content: `Error: ${error}`,
        details: { action: 'read', state: cloneState(state), error },
        isError: true,
      };
    }
    const header = `[${state.cast}/${resolved.kind}] ${resolved.id} - ${resolved.name}\n${resolved.description}\n`;
    return {
      content: `${header}\n${body.trim()}\n`,
      details: { action: 'read', state: cloneState(state), entry: { ...resolved }, body },
    };
  };

  const fail = (action: string, error: string): ActionOut => ({
    content: `Error: ${error}`,
    details: { action, state: cloneState(state), error },
    isError: true,
  });

  const persist = (): void => {
    writeIndex(state);
    excludeCache = null;
  };

  const actSave = (params: RoleplayParamsT): ActionOut => {
    const kind: RoleplayKind = params.kind ?? 'character';
    if (!params.name || params.name.trim().length === 0) return fail('save', '`name` is required for `save`');
    const description = (params.description ?? '').trim();
    if (description.length === 0) return fail('save', '`description` is required for `save` (one-line index hook)');
    const body = (params.body ?? '').trim();
    if (body.length === 0) return fail('save', '`body` is required for `save`');

    const slug = chooseSlug(state.entries, params.name);
    const lore = kind === 'lore' ? buildLoreMeta(params) : undefined;
    const relationship = kind === 'relationship' ? buildRelationshipMeta(params) : undefined;
    atomicWriteFile(
      fileFor(state.cast, kind, slug),
      serializeEntry({ name: params.name.trim(), description, kind, body, lore, relationship }),
    );
    const entry: RoleplayEntry = {
      id: slug,
      kind,
      name: params.name.trim(),
      description,
      ...(lore ? { lore } : {}),
      ...(relationship ? { relationship } : {}),
    };
    state = { cast: state.cast, entries: upsertEntry(state.entries, entry) };
    persist();
    return {
      content: `Saved [${state.cast}/${kind}] ${slug} - ${entry.name}\n\n${formatText(state)}`,
      details: { action: 'save', state: cloneState(state), entry },
    };
  };

  const actUpdate = (params: RoleplayParamsT): ActionOut => {
    const resolved = resolveEntry(state, params);
    if ('error' in resolved) return fail('update', resolved.error);
    const loreParamGiven =
      params.triggers !== undefined ||
      params.secondaryKeys !== undefined ||
      params.secondaryMode !== undefined ||
      params.constant !== undefined ||
      params.order !== undefined ||
      params.depth !== undefined ||
      params.recurse !== undefined;
    const loreOnly = resolved.kind === 'lore' && loreParamGiven;
    const relationshipParamGiven =
      params.affinity !== undefined ||
      params.trust !== undefined ||
      params.lastInteraction !== undefined ||
      params.openThreads !== undefined;
    const relationshipOnly = resolved.kind === 'relationship' && relationshipParamGiven;
    if (
      params.name === undefined &&
      params.description === undefined &&
      params.body === undefined &&
      !loreOnly &&
      !relationshipOnly
    ) {
      return fail(
        'update',
        '`update` requires at least one of `name`, `description`, `body` (or kind-specific fields for a lore/relationship entry)',
      );
    }
    const nextName = params.name !== undefined ? params.name.trim() : resolved.name;
    if (nextName.length === 0) return fail('update', '`name` may not be empty');
    const nextDescription = params.description !== undefined ? params.description.trim() : resolved.description;

    let nextBody: string;
    if (params.body !== undefined) {
      nextBody = params.body.trim();
      if (nextBody.length === 0) return fail('update', '`body` may not be empty - use `remove` to delete the entry');
    } else {
      const existing = readEntryBody(state.cast, resolved);
      if (existing === null)
        return fail('update', `cannot preserve body: "${resolved.id}" not readable - pass \`body\` explicitly`);
      nextBody = existing.trim();
      if (nextBody.length === 0)
        return fail('update', `existing body for "${resolved.id}" is empty - pass \`body\` explicitly`);
    }

    const renamed = params.name !== undefined && slugifyName(params.name) !== resolved.id;
    let entries = state.entries;
    let nextId = resolved.id;
    if (renamed) {
      entries = removeEntry(entries, resolved.id);
      nextId = chooseSlug(entries, params.name!);
      removeFileIfExists(fileFor(state.cast, resolved.kind, resolved.id));
    }
    const lore = resolved.kind === 'lore' ? buildLoreMeta(params, resolved.lore ?? emptyLoreMeta()) : undefined;
    const relationship =
      resolved.kind === 'relationship'
        ? buildRelationshipMeta(params, resolved.relationship ?? emptyRelationshipMeta())
        : undefined;
    atomicWriteFile(
      fileFor(state.cast, resolved.kind, nextId),
      serializeEntry({
        name: nextName,
        description: nextDescription,
        kind: resolved.kind,
        body: nextBody,
        lore,
        relationship,
      }),
    );
    const entry: RoleplayEntry = {
      id: nextId,
      kind: resolved.kind,
      name: nextName,
      description: nextDescription,
      ...(lore ? { lore } : {}),
      ...(relationship ? { relationship } : {}),
    };
    state = { cast: state.cast, entries: upsertEntry(entries, entry) };
    persist();
    return {
      content: `Updated [${state.cast}/${entry.kind}] ${entry.id} - ${entry.name}\n\n${formatText(state)}`,
      details: { action: 'update', state: cloneState(state), entry },
    };
  };

  const actRemove = (params: RoleplayParamsT): ActionOut => {
    const resolved = resolveEntry(state, params);
    if ('error' in resolved) return fail('remove', resolved.error);
    removeFileIfExists(fileFor(state.cast, resolved.kind, resolved.id));
    state = { cast: state.cast, entries: removeEntry(state.entries, resolved.id) };
    persist();
    return {
      content: `Removed [${state.cast}/${resolved.kind}] ${resolved.id}\n\n${formatText(state)}`,
      details: { action: 'remove', state: cloneState(state), entry: resolved },
    };
  };

  const actSearch = (params: RoleplayParamsT): ActionOut => {
    const q = (params.query ?? '').trim();
    if (q.length === 0) return fail('search', '`query` is required for `search`');
    const needle = q.toLowerCase();
    const matches: RoleplayEntry[] = [];
    for (const e of state.entries) {
      const hay = [e.name, e.description, e.id].join(' ').toLowerCase();
      if (hay.includes(needle)) {
        matches.push(e);
        continue;
      }
      const body = readEntryBody(state.cast, e);
      if (body?.toLowerCase().includes(needle)) matches.push(e);
    }
    if (matches.length === 0) {
      return {
        content: `No entries in cast "${state.cast}" match "${q}".`,
        details: { action: 'search', state: cloneState(state), matches: [] },
      };
    }
    const lines = matches.map((e) => `  [${e.kind}] ${e.id} - ${e.name}: ${e.description}`);
    return {
      content: `Matches for "${q}" (${matches.length}):\n${lines.join('\n')}`,
      details: { action: 'search', state: cloneState(state), matches },
    };
  };

  // ── Card import (/roleplay import) ──────────────────────────────────
  /**
   * Import a SillyTavern character card (`.json` V1/V2/V3 or `.png` with a
   * `chara`/`ccv3` chunk) into the active cast: writes one `character`
   * record plus a `lore` record per enabled `character_book` entry, then
   * rebuilds `INDEX.md`. Returns a human summary or an error string.
   */
  const importCardFile = (rawPath: string): { ok: true; summary: string } | { ok: false; error: string } => {
    const path = rawPath.trim();
    if (path.length === 0) return { ok: false, error: 'usage: /roleplay import <path.json|.png>' };

    let json: string | null;
    try {
      if (/\.png$/i.test(path)) {
        json = extractCardJson(readFileSync(path));
        if (json === null) return { ok: false, error: `no character-card chunk (chara/ccv3) found in PNG: ${path}` };
      } else {
        json = readFileSync(path, 'utf8');
      }
    } catch (err) {
      return { ok: false, error: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }

    const card = parseCardJson(json);
    if ('error' in card) return { ok: false, error: `card parse failed: ${card.error}` };
    const plan = cardToRecords(card);

    let entries = state.entries;
    const written: string[] = [];
    for (const rec of plan.records) {
      const slug = chooseSlug(entries, rec.name);
      atomicWriteFile(
        fileFor(state.cast, rec.kind, slug),
        serializeEntry({
          name: rec.name,
          description: rec.description,
          kind: rec.kind,
          body: rec.body,
          lore: rec.lore,
        }),
      );
      const entry: RoleplayEntry = {
        id: slug,
        kind: rec.kind,
        name: rec.name,
        description: rec.description,
        ...(rec.lore ? { lore: rec.lore } : {}),
      };
      entries = upsertEntry(entries, entry);
      written.push(`  [${rec.kind}] ${slug} - ${rec.name}`);
    }
    state = { cast: state.cast, entries };
    writeIndex(state);
    excludeCache = null;

    const lines = [
      `Imported "${plan.characterName}" into cast "${state.cast}": ${plan.records.length} record(s).`,
      ...written,
    ];
    if (plan.warnings.length > 0) lines.push('', 'Warnings:', ...plan.warnings.map((w) => `  - ${w}`));
    return { ok: true, summary: lines.join('\n') };
  };

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: 'roleplay',
    label: 'Roleplay',
    description:
      'Cast-keyed durable store for roleplay scenarios, separate from coding `memory`. Holds character sheets that survive across sessions and workspaces; the active cast is injected each turn under `## Roleplay`. Actions: list, read (id), save ({name, description, body, kind?}), update (id, {name?, description?, body?}), remove (id), search (query).',
    promptSnippet:
      'Durable cast-keyed roleplay store: character sheets for the active scenario, injected each turn and fetched in full on demand.',
    promptGuidelines: [
      'Save a `character` (roleplay action `save`) for a recurring character: voice, appearance, speech tics, hard constraints, first message, example dialogue.',
      'The active cast is derived from the active persona (or `PI_ROLEPLAY_CAST`); switch it with `/roleplay cast <name>`.',
      'Keep scene-level one-off detail in `scratchpad` / drafts; promote only durable cast facts here.',
    ],
    parameters: RoleplayParams,

    async execute(_toolCallId, params: RoleplayParamsT, _signal, _onUpdate, ctx) {
      resyncIfChanged(ctx);
      if (activeCast() === null) {
        const error =
          'roleplay is inactive: activate a persona with `roleplay: true` in its frontmatter (e.g. /persona roleplay) to use this tool.';
        return {
          content: [{ type: 'text', text: `Error: ${error}` }],
          details: { action: params.action, state: cloneState(state), error },
          isError: true,
        };
      }
      let out: ActionOut;
      switch (params.action) {
        case 'list':
          out = actList();
          break;
        case 'read':
          out = actRead(params);
          break;
        case 'save':
          out = actSave(params);
          break;
        case 'update':
          out = actUpdate(params);
          break;
        case 'remove':
          out = actRemove(params);
          break;
        case 'search':
          out = actSearch(params);
          break;
      }
      return { content: [{ type: 'text', text: out.content }], details: out.details, isError: out.isError };
    },

    renderCall(args, theme, _context) {
      const a = args as RoleplayParamsT;
      let text = theme.fg('toolTitle', theme.bold('roleplay ')) + theme.fg('muted', a.action);
      if (a.kind) text += ` ${theme.fg('dim', a.kind)}`;
      if (a.id) text += ` ${theme.fg('accent', a.id)}`;
      if (a.name) text += ` ${theme.fg('dim', `"${truncate(a.name, 40)}"`)}`;
      if (a.query) text += ` ${theme.fg('dim', `?"${truncate(a.query, 30)}"`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<RoleplayDetails>;
      if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
      if (details.action === 'read' && details.entry && details.body !== undefined) {
        const e = details.entry;
        const header = theme.fg('muted', `[${e.kind}] `) + theme.fg('accent', e.id);
        const body = expanded ? details.body : truncate(details.body.trim(), 200);
        return new Text(`${header}\n${theme.fg('text', body)}`, 0, 0);
      }
      if (details.action === 'search') {
        const matches = details.matches ?? [];
        if (matches.length === 0) return new Text(theme.fg('dim', '(no matches)'), 0, 0);
        const display = expanded ? matches : matches.slice(0, 8);
        const parts = [theme.fg('muted', `${matches.length} match(es)`)];
        for (const e of display)
          parts.push(`  ${theme.fg('accent', e.id)} ${theme.fg('dim', `[${e.kind}]`)} ${e.name}`);
        if (!expanded && matches.length > display.length)
          parts.push(theme.fg('dim', `  … ${matches.length - display.length} more`));
        return new Text(parts.join('\n'), 0, 0);
      }
      const s = details.state ?? emptyState();
      const entries = s.entries ?? [];
      if (entries.length === 0) return new Text(theme.fg('dim', `(cast "${s.cast || '(none)'}" empty)`), 0, 0);
      const show = expanded ? entries : entries.slice(0, 8);
      const parts = [theme.fg('muted', `cast ${s.cast} · ${entries.length} entr(ies)`)];
      for (const e of show)
        parts.push(`  ${theme.fg('accent', e.id)} ${theme.fg('dim', `[${e.kind}]`)} ${truncate(e.name, 60)}`);
      if (!expanded && entries.length > show.length)
        parts.push(theme.fg('dim', `  … ${entries.length - show.length} more`));
      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /roleplay command ───────────────────────────────────────────────
  pi.registerCommand('roleplay', {
    description: 'Inspect or switch the active roleplay cast',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        list: { description: 'List the active cast' },
        cast: { description: 'Switch / set the active cast', args: () => listCasts().map((c) => ({ label: c })) },
        import: { description: 'Import a SillyTavern card (.json/.png) into the active cast' },
        event: { description: 'Queue a one-shot scene complication (LLM-generated, or from the deck)' },
        newscene: { description: 'Start a fresh scene: archive + clear the recap / timeline / fact carry-overs' },
        dir: { description: 'Print the roleplay store dir' },
        rescan: { description: 'Rescan the active cast from disk' },
        casts: { description: 'List every cast on disk' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(ROLEPLAY_USAGE, 'info');
        return;
      }
      const raw = (args ?? '').trim();
      const [sub, ...rest] = raw.split(/\s+/);
      const verb = (sub ?? '').toLowerCase();

      const dormant = activeCast() === null;
      const dormantNote =
        'Roleplay is dormant: no active persona declares `roleplay: true`. Run /persona <a roleplay persona> first.';

      if (verb === '' || verb === 'list') {
        resyncIfChanged(ctx);
        ctx.ui.notify(dormant ? dormantNote : formatText(state), 'info');
        return;
      }
      if (verb === 'cast') {
        const name = rest.join(' ').trim();
        if (name.length === 0) {
          ctx.ui.notify(`Active cast: ${state.cast || '(none)'}\nUsage: /roleplay cast <name>`, 'info');
          return;
        }
        castOverride = castSlug(name);
        resync(ctx);
        ctx.ui.notify(
          dormant
            ? `Cast override set to "${castOverride}" - takes effect once a \`roleplay: true\` persona is active.`
            : `Active cast set to "${state.cast}".\n\n${formatText(state)}`,
          'info',
        );
        return;
      }
      if (verb === 'import') {
        if (dormant) {
          ctx.ui.notify(dormantNote, 'warning');
          return;
        }
        const target = rest.join(' ').trim();
        if (target.length === 0) {
          ctx.ui.notify('Usage: /roleplay import <path.json|.png>', 'info');
          return;
        }
        const result = importCardFile(target);
        if (!result.ok) {
          ctx.ui.notify(`roleplay import: ${result.error}`, 'error');
          return;
        }
        ctx.ui.notify(result.summary, 'info');
        return;
      }
      if (verb === 'event') {
        if (dormant) {
          ctx.ui.notify(dormantNote, 'warning');
          return;
        }
        if (!eventsEnabled) {
          ctx.ui.notify('Roleplay events are disabled (PI_ROLEPLAY_DISABLE_EVENTS).', 'warning');
          return;
        }
        resyncIfChanged(ctx);
        const cfg = loadRoleplayConfig(cwd, envCharBudget);
        const hint = rest.join(' ').trim();
        let queued: string | null = null;
        const gen = getEventGenerator(ctx);
        if (gen?.isEnabled()) {
          const task = buildEventTask({
            recentScene: recentText(lastMessages, cfg.scanDepth),
            sheets: characterSummaries(),
            openThreads: openThreadsForCast(),
            ...(hint ? { hint } : {}),
            seedThreads: cfg.eventSeedThreads,
          });
          queued = await gen.generate({ cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never }, task);
        }
        if (queued === null) {
          const deckPick = pickDeckEvent(cfg.events);
          if (deckPick !== undefined) queued = deckPick;
        }
        if (queued === null) {
          ctx.ui.notify(
            'roleplay event: no event available (no event model/agent resolved and the `events` deck is empty).',
            'warning',
          );
          return;
        }
        pendingEvent = queued;
        eventConsumed = false;
        ctx.ui.notify(`Queued scene event for your next reply:\n${queued}`, 'info');
        return;
      }
      if (verb === 'newscene') {
        if (dormant) {
          ctx.ui.notify(dormantNote, 'warning');
          return;
        }
        resyncIfChanged(ctx);
        const ts = new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z');
        // Archive the per-cast carry-overs (recap + timeline + captured facts).
        const archivedSummary = archiveCarryOver(state.cast, 'summary', ts);
        const archivedTimeline = archiveCarryOver(state.cast, 'timeline', ts);
        const archivedFacts = archiveFacts(state.cast, ts);
        // No per-session live records to drop anymore: the within-session
        // store is the branch, and the NEW scene runs on a fresh tree whose
        // `getBranch()` carries no recap - so branch hydration finds nothing
        // and the cleared carry-over below decides continuity (cold start).
        // Clear in-memory scene state; the next context turn cold-starts.
        resetWindowState();
        ctx.ui.notify(
          [
            `New scene started for cast "${state.cast}".`,
            `Archived carry-overs -> recap: ${archivedSummary ? 'yes' : 'none'}, ` +
              `timeline: ${archivedTimeline ? 'yes' : 'none'}, facts: ${archivedFacts}.`,
            'The recap, timeline, and captured-fact carry-overs are cleared; the scene starts fresh on your next turn.',
          ].join('\n'),
          'info',
        );
        return;
      }
      if (verb === 'dir') {
        const root = roleplayRoot();
        ctx.ui.notify(
          `Roleplay root: ${root}\nActive cast: ${state.cast || '(none)'}\nCast dir: ${castDir(state.cast, root)}`,
          'info',
        );
        return;
      }
      if (verb === 'rescan') {
        resync(ctx);
        ctx.ui.notify(dormant ? dormantNote : `Rescanned cast "${state.cast}".\n\n${formatText(state)}`, 'info');
        return;
      }
      if (verb === 'casts') {
        const casts = listCasts();
        ctx.ui.notify(
          casts.length === 0
            ? '(no casts on disk yet)'
            : `Casts (${casts.length}):\n${casts.map((c) => `  ${c}${c === state.cast ? ' *' : ''}`).join('\n')}`,
          'info',
        );
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${verb}. ${ROLEPLAY_USAGE}`, 'warning');
    },
  });
}
