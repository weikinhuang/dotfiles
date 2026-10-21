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
 * (keyword-triggered World Info injection), turn-anchored depth placement,
 * relationship state, and auto-summarization. See
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
 *   PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1   skip depth-tagged lore and author notes.
 *   PI_ROLEPLAY_DISABLE_SUMMARIZE=1      skip auto-summarization on compaction.
 *   PI_ROLEPLAY_DISABLE_REPETITION=1     skip the multi-turn repetition / anti-slop nudge.
 *   PI_ROLEPLAY_DISABLE_EVENTS=1         disable `/roleplay event` scene complications.
 *   PI_ROLEPLAY_DISABLE_AVATAR=1         stop driving the avatar face from the cast.
 *   PI_ROLEPLAY_DISABLE_SCENEGEN=1       stop mirroring generated images to the
 *                                        avatar scene banner.
 *   PI_ROLEPLAY_MAX_INJECTED_CHARS=N     soft cap on injected block (default 3000).
 *   PI_ROLEPLAY_LORE_BUNDLES=a,b          activate optional lore bundles
 *                                        (`lore/<name>/*.md`), ascending
 *                                        precedence; each overrides base
 *                                        lore on an id clash.
 *   PI_ROLEPLAY_ROOT=<path>              override `~/.pi/agent/roleplay`.
 *
 * Activation gate: the tool, cast scan, and `## Roleplay` injection are
 * DORMANT unless the active persona declares `roleplay: true` in its
 * frontmatter (optionally with a `cast:` slug). This keeps roleplay off
 * for coding personas and persona-as-subagent uses. `/roleplay cast
 * <name>` overrides the cast within an active roleplay persona.
 */

import { StringEnum, type Model } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';

import { cardToRecords, parseCardJson } from '../../../lib/node/pi/card-import/card-to-records.ts';
import { extractCardJson } from '../../../lib/node/pi/card-import/parse-png-chara.ts';
import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { envTruthy, parseClampedPositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { clearActiveRoleplay, setActiveRoleplay } from '../../../lib/node/pi/roleplay/active.ts';
import {
  type BranchRecap,
  scanBranchForRecap,
  scanBranchForTimeline,
} from '../../../lib/node/pi/roleplay/branch-hydration.ts';
import {
  type ContextWindowReadoutSnapshot,
  formatContextWindowReadout,
} from '../../../lib/node/pi/roleplay/context-readout.ts';
import { clearAvatarInput, setAvatarInput } from '../../../lib/node/pi/avatar/input.ts';
import { COMFYUI_IMAGE_CHANNEL, isImageGeneratedEvent } from '../../../lib/node/pi/comfyui/events.ts';
import { loadRoleplayConfig } from '../../../lib/node/pi/roleplay/config.ts';
import {
  getRoleplayImageModeOverride,
  isRoleplayImageMode,
  replaceRoleplayImageTools,
  restoreRoleplayImageMode,
  ROLEPLAY_IMAGE_MODE_ENTRY,
  selectRoleplayImageTools,
  setRoleplayImageModeOverride,
} from '../../../lib/node/pi/roleplay/image-tools.ts';
import { buildVisualContext, extractVisualIdentities } from '../../../lib/node/pi/roleplay/visual-identity.ts';
import { extractSceneContext, type SceneMessage } from '../../../lib/node/pi/comfyui/scene-context.ts';
import { getComfyuiGenerator } from '../../../lib/node/pi/ext/comfyui/service.ts';
import { renderGenerateCall, renderGenerateResult } from '../../../lib/node/pi/ext/comfyui/render.ts';
import type { GenerateDetails } from '../../../lib/node/pi/ext/comfyui/details.ts';
import type { GenerateToolResult } from '../../../lib/node/pi/ext/comfyui/generate.ts';
import { selectWithinBudget, type LoreChunk } from '../../../lib/node/pi/roleplay/budget.ts';
import {
  buildInsertions,
  isNarrativeRoleplayStart,
  planDepthTailMerge,
  type LoreDepthChunk,
} from '../../../lib/node/pi/roleplay/inject.ts';
import { matchLore } from '../../../lib/node/pi/roleplay/match.ts';
import { formatLoreBlock } from '../../../lib/node/pi/roleplay/prompt.ts';
import { type MacroContext, seededRng, substituteMacros } from '../../../lib/node/pi/roleplay/macros.ts';
import { composeSceneBlock, composeSceneFoldBlock, resolveCharacter } from '../../../lib/node/pi/roleplay/scene.ts';
import { planCharacterFold, selectFoldDeliveries } from '../../../lib/node/pi/roleplay/scene-fold.ts';
import { expandMatchedRecursive } from '../../../lib/node/pi/roleplay/recursion.ts';
import { applyTiming } from '../../../lib/node/pi/roleplay/timing.ts';
import {
  createCastTimingState,
  resetCastTiming,
  resetSceneFoldDelivery,
} from '../../../lib/node/pi/roleplay/cast-timing.ts';
import {
  clampSummary,
  composeAutoSummaryRecord,
  createSummarizer,
  planSummarization,
  resolveSummarizeSettings,
  type SummarizableMessage,
  type Summarizer,
} from '../../../lib/node/pi/roleplay/summarize.ts';
import {
  acceptRecap,
  boundRollSpanTo,
  computeCutoff,
  DEFAULT_CHARS_PER_TOKEN,
  deriveMaxSpanChars,
  estimateChars,
  shouldForceRecap,
  updateCharsPerToken,
  type WindowOptions,
} from '../../../lib/node/pi/roleplay/context-window.ts';
import { applyWindowPass, planWindowFloor } from '../../../lib/node/pi/roleplay/window-pass.ts';
import {
  armForcedRecap,
  createWindowState,
  planRoll,
  resetWindowCoverage,
  resetWindowState as resetWindowStateFields,
  settleForcedRecap,
} from '../../../lib/node/pi/roleplay/window-state.ts';
import {
  createLoreSelection,
  formatLoreReadout,
  recordDepthSelection,
  recordKeywordSelection,
  type LoreSelectionSnapshot,
} from '../../../lib/node/pi/roleplay/lore-readout.ts';
import { formatRecapReadout, recapUnavailableReason } from '../../../lib/node/pi/roleplay/recap-readout.ts';
import { formatRelationshipsReadout } from '../../../lib/node/pi/roleplay/relationship-readout.ts';
import { recordsToCard } from '../../../lib/node/pi/card-import/records-to-card.ts';
import { parseModelSpec } from '../../../lib/node/pi/model-spec.ts';
import {
  buildEventTask,
  createEventGenerator,
  type EventGenerator,
  formatEventDirector,
  isCurrentEventCapture,
  pickDeckEvent,
  resolveEventSettings,
} from '../../../lib/node/pi/roleplay/event.ts';
import { buildExcludeSet, detectRepetition, formatRepetitionNudge } from '../../../lib/node/pi/roleplay/repetition.ts';
import {
  applyContextReminder,
  contextRemindersEnabled,
  type ReminderMessage,
} from '../../../lib/node/pi/context-reminder.ts';
import {
  REMINDER_CAPABILITIES,
  REMINDER_LIMIT,
  REMINDER_PROJECTED,
  type ReminderSnapshot,
  type ReminderCapabilities,
  type ReminderLimitRequest,
  type ReminderProjectedRequest,
} from '../../../lib/node/pi/reminder-lifecycle.ts';
import { ensureReminderIdentities } from '../../../lib/node/pi/reminder-identity.ts';
import { limitReminderContext, reminderRequestChars } from '../../../lib/node/pi/reminder-budget.ts';
import { type AgentDef, makeNodeReadLayer } from '../../../lib/node/pi/subagent/loader.ts';
import { loadRoleplayAgent, runRoleplayChild } from '../../../lib/node/pi/ext/roleplay-child-session.ts';
import { buildFactExtractionTask, parseFactCandidates } from '../../../lib/node/pi/roleplay/capture.ts';
import {
  appendBeatBody,
  buildTimelineExtractionTask,
  capBeatLog,
  dedupeNewBeats,
  formatBeatLines,
  parseTimelineBeats,
  renderTimelineBlock,
} from '../../../lib/node/pi/roleplay/timeline.ts';
import { resolvePromptGuidance } from '../../../lib/node/pi/roleplay/prompt-override.ts';
import { findSimilarMemories } from '../../../lib/node/pi/memory-search.ts';
import { type MemoryEntry, renderMemoryMd, serializeMemory } from '../../../lib/node/pi/memory-reducer.ts';
import {
  fileFor as memoryFileFor,
  indexFileFor as memoryIndexFileFor,
  rebuildMemoryIndex,
  slugifyName as memorySlugifyName,
  uniqueSlug as memoryUniqueSlug,
} from '../../../lib/node/pi/memory-paths.ts';
import { resolveChildModel } from '../../../lib/node/pi/subagent/spawn.ts';
import {
  appendTimelineCarryOver,
  archiveCarryOver,
  archiveFacts,
  atomicWriteFile,
  castDir,
  factFile,
  fileFor,
  listCasts,
  listFactSidecars,
  parseLoreBundleSelection,
  portraitPath,
  readEntryBody,
  rebuildCast,
  removeFileIfExists,
  resolveImportPath,
  roleplayRoot,
  writeIndex,
} from '../../../lib/node/pi/roleplay/paths.ts';
import {
  castSlug,
  chooseSlug,
  cloneState,
  emptyState,
  emptyLoreMeta,
  formatRoleplayBlock,
  formatText,
  SECONDARY_MODES,
  type RoleplayEntry,
  type RoleplayState,
  resolveEntry,
  serializeEntry,
  slugifyName,
  upsertEntry,
} from '../../../lib/node/pi/roleplay/store.ts';
import { ROLEPLAY_USAGE, roleplaySubverbs } from '../../../lib/node/pi/roleplay/usage.ts';
import { type RoleplayToolParams } from '../../../lib/node/pi/roleplay/tool-params.ts';
import {
  type ActionPlan,
  planRemove,
  planSave,
  planSearch,
  planUpdate,
} from '../../../lib/node/pi/roleplay/actions.ts';
import { normalizeInjectedBody } from '../../../lib/node/pi/roleplay/text.ts';
import {
  collectRoleMessageTexts,
  concatRecentMessageText,
  messageContentToText,
} from '../../../lib/node/pi/message-text.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

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
      description:
        'Lore + character: extra keywords (OR). Lore fires / a character sheet folds when any appears in the recent window. A character always keys on its own `name` + `aliases`; `triggers` add titles/nicknames.',
    }),
  ),
  secondaryKeys: Type.Optional(
    Type.Array(Type.String(), { description: 'Lore only: optional secondary keywords gated by `secondaryMode`.' }),
  ),
  secondaryMode: Type.Optional(
    StringEnum(SECONDARY_MODES, {
      description:
        'Lore only: how `secondaryKeys` combine after a primary hit: AND (all present), OR (any), NOT (none), NOT_ALL (not every one). Default AND.',
    }),
  ),
  constant: Type.Optional(
    Type.Boolean({ description: 'Lore only: always inject (budget permitting), ignoring triggers. Default false.' }),
  ),
  order: Type.Optional(
    Type.Number({ description: 'Lore + character: priority; higher wins when the char budget evicts. Default 0.' }),
  ),
  depth: Type.Optional(
    Type.Number({
      description: 'Lore only: messages from the end at the narrative boundary; placement stays fixed during tools.',
    }),
  ),
  recurse: Type.Optional(
    Type.Boolean({
      description: 'Lore only: opt in to having this entry body re-scanned to trigger further lore. Default false.',
    }),
  ),
  aliases: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Character only: extra names/nicknames the scene fold keys on (the entry `name` is always an implicit key).',
    }),
  ),
  pinned: Type.Optional(
    Type.Boolean({
      description:
        'Character only: always fold this sheet into the `## Roleplay scene` block (budget permitting), like a `constant` lore entry. Default false.',
    }),
  ),
  affinity: Type.Optional(
    Type.Number({ description: 'Relationship only: 0-100 warmth/closeness. Decays toward neutral while idle.' }),
  ),
  trust: Type.Optional(Type.String({ description: 'Relationship only: free-form trust label (e.g. `high`, `wary`).' })),
  lastInteraction: Type.Optional(
    Type.String({
      description: 'Relationship only: ISO date (YYYY-MM-DD) of the last shared scene; decay anchor. "" clears it.',
    }),
  ),
  openThreads: Type.Optional(
    Type.Array(Type.String(), { description: 'Relationship only: dangling threads to resume next scene.' }),
  ),
});

type RoleplayParamsT = RoleplayToolParams;

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
  const remindersEnabled = contextRemindersEnabled(process.env);
  const lorebookEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_LOREBOOK) && remindersEnabled;
  const depthInjectEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_DEPTH_INJECT) && remindersEnabled;
  const summarizeEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_SUMMARIZE);
  const repetitionEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_REPETITION) && remindersEnabled;
  const eventsEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_EVENTS) && remindersEnabled;
  const avatarDriveEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_AVATAR);
  const sceneGenEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_SCENEGEN);
  const envCharBudget = parseClampedPositiveInt(process.env.PI_ROLEPLAY_MAX_INJECTED_CHARS, 0, 1) || undefined;

  // Activated lore bundles, resolved once at load from the env contract
  // (`PI_ROLEPLAY_LORE_BUNDLES=nameA,nameB`, ascending precedence). The
  // scanner stays env-agnostic - it takes the parsed selection.
  const loreBundles = parseLoreBundleSelection(process.env.PI_ROLEPLAY_LORE_BUNDLES);

  // Rolling context-window management. `contextWindowEnabled` runs the
  // per-turn in-context reduction (drop/condense) in the `context` hook.
  // `recapMode` = bounded mode: the summarizer folds the aged prefix into
  // the `summary/auto` recap and the recap-covered prefix is DROPPED
  // (O(1)). Recap requires the window; when either is off we degrade to the
  // condense-only floor. Owning pi's threshold auto-compaction is only safe
  // in recap (size-bounded) mode - the floor keeps every message - and only
  // while a summarizer resolves (checked lazily in `session_before_compact`).
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
  /** Lorebook + scene-fold timing (turn counter, sticky/cooldown, fold delivery). Reset on cast switch. */
  const timing = createCastTimingState();
  /**
   * Per-run slot for name-triggered character sheets, delivered as the
   * `<system-reminder id="roleplay-scene-fold">` block (same lifecycle as
   * `pendingLore`) so NPCs entering / leaving the sticky window never rewrite
   * the cached system prompt. `ids` are committed to `sceneFoldDelivered`
   * only when the block is actually emitted.
   */
  let pendingSceneFold: { body: string; ids: string[]; turn: number } | null = null;
  /** Session-frozen clock for macros in system-prompt (head) text, so `{{time}}` etc. stay byte-stable. */
  let frozenMacroNow: Date | null = null;
  /** Unsubscribe handle for the comfyui image-generated bus (cleared on shutdown). */
  let unsubscribeImageEvents: (() => void) | null = null;
  let unsubscribeReminderSnapshots: (() => void) | null = null;
  const unsubscribePipeline: (() => void)[] = [];
  const surfacedWarnings = new Set<string>();
  /** Queued one-shot scene complication from `/roleplay event`; injected for the next reply only. */
  let pendingEvent: string | null = null;
  let pendingEventGeneration = 0;
  /** Set only after snapshot capture; the next narrative boundary clears the event. */
  let eventConsumed = false;
  /**
   * Per-turn slot for the keyword-fired lore block. Computed ONCE in
   * `before_agent_start` (so the timing pass - sticky / cooldown /
   * probability / delay - advances exactly once per turn) and injected as an
   * `<system-reminder id="roleplay-lore">` block by the first narrative
   * `context` request. The coordinator replays it during tool continuations. Kept off the
   * system prompt: fired-lore membership shifts topic-to-topic, so on the
   * cached prefix it would bust the prompt-prefix cache every topic change
   * (a whole re-prefill on llama.cpp). `null` when nothing fires. Mirrors
   * the `pendingEvent` slot pattern. */
  let pendingLore: string | null = null;
  /** Only the first request of an eligible narrative run may emit new roleplay reminders. */
  let roleplayRemindersPending = false;
  /** Recent-window scan frozen at the narrative boundary, never extended with this run's tool output. */
  let pendingDepthScan: string | null = null;
  let pendingEventForRun: string | null = null;
  let pendingEventGenerationForRun: number | null = null;
  /** Operational runs preserve the previous narrative head without advancing scene timing. */
  let lastSceneBlock: string | null = null;
  /** Last narrative turn's lore selection (kept / dropped), for `/roleplay lore`. Reset on cast switch. */
  let lastLoreSelection: LoreSelectionSnapshot | null = null;
  /** Only lore actually selected for this turn may contribute visual identity. */
  let keywordVisualLore: readonly LoreChunk[] = [];
  let depthVisualLore: readonly LoreChunk[] = [];
  /** Most-recent `context` message array, captured so `/roleplay event` can read the scene. */
  let lastMessages: readonly unknown[] = [];
  /** Memoized character-sheet n-gram exclusion set for repetition detection; rebuilt on state change. */
  let excludeCache: { cast: string; ngram: number; set: Set<string> } | null = null;
  /**
   * Memoized ids of lore entries whose stored body is empty after
   * injection-normalization. Rebuilt on state change. Empty / whitespace-only
   * lore is dropped BEFORE the match + timing pass so it can never win an
   * inclusion group (and starve a real sibling) only to be discarded for
   * having nothing to render.
   */
  let loreEmptyCache: { cast: string; ids: Set<string> } | null = null;
  // ── Rolling context-window state (per process; reset on lifecycle) ──
  /** Recap / timeline text, frozen cutoffs, async-recap generation + calibration (see roleplay/window-state.ts). */
  const win = createWindowState();
  /** Snapshot of the last context-window pass, for `/roleplay context`. Null until the first turn is processed. */
  let lastWindowSnapshot: ContextWindowReadoutSnapshot | null = null;
  /** Lowercased fact names captured this process, to skip re-writing the same fact. */
  const capturedFacts = new Set<string>();
  /** Lazy `roleplay-fact-extractor` runner + one-shot init guard. */
  let factExtractor: ((ctx: ExtensionContext, task: string, signal?: AbortSignal) => Promise<string | null>) | null =
    null;
  let factExtractorInit = false;
  /** Lazy `roleplay-timeline-extractor` runner + one-shot init guard. */
  let timelineExtractor:
    | ((ctx: ExtensionContext, task: string, signal?: AbortSignal) => Promise<string | null>)
    | null = null;
  let timelineExtractorInit = false;
  const resetWindowState = (): void => {
    resetWindowStateFields(win);
    capturedFacts.clear();
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
   * when dormant. Precedence: an explicit persona `avatarSet` wins (it
   * decouples the avatar face from the cast slug); otherwise the first
   * non-POV character (the one the user is talking to), then the first
   * listed character, then the cast slug. The slug maps to an avatar
   * sprite-set dir (`avatar/emotes/<slug>/`); a slug with no sprite art
   * falls back gracefully on the avatar side.
   */
  const activeFaceSlug = (): string | null => {
    const persona = getActivePersona();
    if (!persona?.roleplay) return null;
    if (persona.avatarSet) return slugifyName(persona.avatarSet);
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
    resetCastTiming(timing);
    lastLoreSelection = null;
    pendingSceneFold = null;
    keywordVisualLore = [];
    depthVisualLore = [];
    pendingLore = null;
    pendingDepthScan = null;
    pendingEventForRun = null;
    pendingEventGenerationForRun = null;
    roleplayRemindersPending = false;
    lastSceneBlock = null;
    excludeCache = null;
    loreEmptyCache = null;
    if (cast === null) {
      state = emptyState();
      syncedCast = null;
      clearActiveRoleplay();
      if (avatarDriveEnabled) clearAvatarInput();
      return;
    }
    const { state: next, warnings } = rebuildCast(cast, roleplayRoot(), { loreBundles });
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
    const persona = getActivePersona();
    const tools = pi.getActiveTools();
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const selected = selectRoleplayImageTools(
      // An omitted allowlist is unrestricted, even after off mode removed every active image tool.
      persona?.tools ?? (activeCast() !== null ? [...registered] : tools),
      registered,
      activeCast() !== null,
      getRoleplayImageModeOverride() ?? loadRoleplayConfig(cwd).imageMode,
    );
    let next = replaceRoleplayImageTools(tools, selected);
    if (activeCast() === null) next = next.filter((tool) => tool !== 'roleplay');
    if (next.join('\u0000') !== tools.join('\u0000')) pi.setActiveTools(next);
  };

  /** Force a re-resolve + scan (session lifecycle hooks). */
  const resync = (ctx: ExtensionContext): void => {
    cwd = ctx.cwd;
    // Captured once per session (cleared on shutdown) so head macros never tick.
    frozenMacroNow ??= new Date();
    resetWindowState();
    keywordVisualLore = [];
    depthVisualLore = [];
    lastMessages = [];
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

  /**
   * Fold the scene's character sheets into a `## Roleplay scene` block,
   * above the lightweight cast index. Three fold sources, in precedence
   * order (`pov` > `pinned` > name-triggered > index-only):
   *   - the active persona's declared `characters: [...]` (author's scene
   *     list) and `pov:` (player character, folded last + never evicted),
   *   - any `pinned` character (always folds, budget permitting),
   *   - any character whose name / alias / trigger appears in `scanText`
   *     (the recent-message + current-prompt window), kept alive by its
   *     sticky window via {@link planCharacterFold}.
   *
   * Delivery (`sceneFoldDelivery`): in `reminder` mode (default) only the
   * STABLE folds (persona-declared, `pinned`, POV) go into the returned
   * system-prompt block; name-triggered sheets are rendered separately into
   * `pendingSceneFold` (emitted as `roleplay-scene-fold` by the first
   * narrative `context` request) so NPC churn never rewrites the cached
   * prefix. A sheet is (re)sent only when it (re)enters the active set or
   * its last delivery is `sceneFoldRefreshTurns` old. `system` mode, or
   * globally suppressed reminders, folds everything into the head (legacy).
   *
   * Head sheets resolve macros against a session-frozen clock and a
   * (session, entry)-seeded rng so `{{time}}` / `{{random}}` / `{{roll}}`
   * stay byte-stable across turns; reminder sheets keep live macros.
   *
   * Returns `null` when nothing folds into the head. Missing declared names
   * are warn-dropped (deduped so the notice fires only when the set changes).
   */
  const buildSceneBlock = (ctx: ExtensionContext, scanText: string): string | null => {
    pendingSceneFold = null;
    const persona = getActivePersona();
    if (!persona?.roleplay) return null;
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    // Never let folds silently vanish: suppressed reminders fall back to the head.
    const foldToReminder = cfg.sceneFoldDelivery === 'reminder' && remindersEnabled;
    const foldPlan = planCharacterFold(state.entries, {
      scanText,
      turn: timing.turnCount,
      priorTiming: timing.sceneTimingState,
      rng: Math.random,
    });
    timing.sceneTimingState = foldPlan.nextTiming;
    const byId = new Map(state.entries.map((e) => [e.id, e]));
    const nameOf = (id: string): string | undefined => byId.get(id)?.name;
    const pinnedSet = new Set(foldPlan.pinnedIds);
    const pinnedNames = foldPlan.pinnedIds.map(nameOf).filter((n): n is string => Boolean(n));
    const triggeredIds = foldPlan.firedIds.filter((id) => !pinnedSet.has(id));
    let sid = 'nosession';
    try {
      sid = ctx.sessionManager?.getSessionId() ?? 'nosession';
    } catch {
      /* --no-session */
    }
    frozenMacroNow ??= new Date();
    const headNow = frozenMacroNow;
    const headBodies = new Map<string, string>();
    const headBodyOf = (entry: RoleplayEntry): string => {
      const cached = headBodies.get(entry.id);
      if (cached !== undefined) return cached;
      const body = substituteMacros(readEntryBody(state.cast, entry) ?? '', {
        ...macroCtx(entry.name),
        now: headNow,
        rng: seededRng(`${sid}\u0000${entry.id}`),
      });
      headBodies.set(entry.id, body);
      return body;
    };

    let headTriggered: string[] = [];
    if (foldToReminder) {
      // Head-resident ids (declared / pov / pinned) never double-deliver.
      const headIds = new Set<string>(pinnedSet);
      for (const name of [...(persona.characters ?? []), ...(persona.pov ? [persona.pov] : [])]) {
        const resolved = resolveCharacter(state, name);
        if (resolved) headIds.add(resolved.id);
      }
      const active = triggeredIds.filter((id) => !headIds.has(id));
      const deliver = selectFoldDeliveries({
        activeIds: active,
        priorActiveIds: timing.sceneFoldPriorActive,
        lastDelivered: timing.sceneFoldDelivered,
        turn: timing.turnCount,
        refreshTurns: cfg.sceneFoldRefreshTurns,
      });
      timing.sceneFoldPriorActive = new Set(active);
      if (deliver.length > 0) {
        const fold = composeSceneFoldBlock(
          state,
          (entry) => substituteMacros(readEntryBody(state.cast, entry) ?? '', macroCtx(entry.name)),
          { characters: deliver, maxChars: cfg.charBudget },
        );
        if (fold.block) pendingSceneFold = { body: fold.block, ids: fold.keptIds, turn: timing.turnCount };
      }
    } else {
      timing.sceneFoldPriorActive = new Set();
      headTriggered = triggeredIds.map(nameOf).filter((n): n is string => Boolean(n));
    }

    // Precedence order: persona-declared (author's listed order), then pinned,
    // then (legacy mode only) name-triggered; the pinned / triggered tiers are
    // pre-ranked by character `order` (planCharacterFold). composeSceneBlock
    // dedups by resolved id and evicts from the tail, so the lowest-precedence
    // sheets drop first.
    const characters = [...(persona.characters ?? []), ...pinnedNames, ...headTriggered];
    if (characters.length === 0 && !persona.pov) return null;
    const { block, missing } = composeSceneBlock(state, headBodyOf, {
      characters,
      pov: persona.pov,
      maxChars: cfg.charBudget,
    });
    const sig = missing.join('\u0000');
    if (missing.length > 0 && sig !== lastSceneMissingSig) {
      ctx.ui.notify(`roleplay: scene character(s) not in cast "${state.cast}": ${missing.join(', ')}`, 'warning');
    }
    lastSceneMissingSig = sig;
    return block;
  };

  /** Ids of lore entries with an empty (injection-normalized) body, memoized per cast. */
  const emptyLoreIds = (): Set<string> => {
    if (loreEmptyCache && loreEmptyCache.cast === state.cast) return loreEmptyCache.ids;
    const ids = new Set<string>();
    for (const e of state.entries) {
      if (e.kind !== 'lore') continue;
      // Emptiness is a property of the authored body, so check pre-macro:
      // a body that is only `{{newline}}` etc. is intentional content, not empty.
      if (normalizeInjectedBody(readEntryBody(state.cast, e) ?? '').length === 0) ids.add(e.id);
    }
    loreEmptyCache = { cast: state.cast, ids };
    return ids;
  };

  /**
   * Build the fired-lore section for `scanText` (the recent-message scan
   * window). Returns `null` when the lorebook is disabled or nothing
   * fires. Bodies are loaded from disk lazily (matched recursion sources
   * and fired entries only).
   */
  const buildLoreInjection = (scanText: string): string | null => {
    keywordVisualLore = [];
    if (!lorebookEnabled) return null;
    // Empty-bodied lore is dropped up front so it never consumes a timing slot.
    const empties = emptyLoreIds();
    const lore = state.entries.filter((e) => e.kind === 'lore' && e.lore?.depth === undefined && !empties.has(e.id));
    if (lore.length === 0) return null;
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    const bodyCache = new Map<string, string>();
    const bodyOf = (entry: RoleplayEntry): string => {
      const cached = bodyCache.get(entry.id);
      if (cached !== undefined) return cached;
      const body = normalizeInjectedBody(substituteMacros(readEntryBody(state.cast, entry) ?? '', macroCtx()));
      bodyCache.set(entry.id, body);
      return body;
    };
    // Keyword matching (plus opt-in recursion over matched bodies) decides
    // candidates; the timing pass (delay / probability / sticky / cooldown /
    // inclusion-group) then decides what actually fires this turn, so
    // recursive hits go through timing exactly like keyword hits.
    const matchedIds = expandMatchedRecursive(matchLore(lore, scanText), lore, {
      bodyOf,
      maxRecursion: cfg.maxRecursion,
    });
    const timed = applyTiming(
      lore.map((e) => ({ id: e.id, meta: e.lore ?? emptyLoreMeta(), matched: matchedIds.has(e.id) })),
      timing.turnCount,
      timing.timingState,
      Math.random,
    );
    timing.timingState = timed.nextState;
    const firedSet = new Set(timed.fired);
    const fired = lore.filter((e) => firedSet.has(e.id));
    if (fired.length === 0) return null;
    const chunks: LoreChunk[] = fired
      .map((entry) => ({ entry, body: bodyOf(entry).trim() }))
      .filter((c) => c.body.length > 0);
    if (chunks.length === 0) return null;
    const selected = selectWithinBudget(chunks, cfg.loreCharBudget);
    if (lastLoreSelection) recordKeywordSelection(lastLoreSelection, selected);
    keywordVisualLore = selected.kept;
    return formatLoreBlock(selected);
  };

  const restoreImageMode = (ctx: ExtensionContext): void => {
    setRoleplayImageModeOverride(restoreRoleplayImageMode(ctx.sessionManager.getBranch()));
    resync(ctx);
  };
  pi.on('session_start', (_event, ctx) => restoreImageMode(ctx));
  pi.on('session_tree', (_event, ctx) => restoreImageMode(ctx));

  pi.on('before_agent_start', (event, ctx) => {
    // A persona may have been activated since session_start; re-resolve.
    resyncIfChanged(ctx);
    gateRoleplayTool();
    pendingLore = null;
    pendingSceneFold = null;
    pendingDepthScan = null;
    pendingEventForRun = null;
    pendingEventGenerationForRun = null;
    roleplayRemindersPending = false;

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

    if (!isNarrativeRoleplayStart(event)) {
      keywordVisualLore = [];
      depthVisualLore = [];
      if (!autoInjectEnabled) return undefined;
      const additions = [lastSceneBlock, formatRoleplayBlock(state, { maxChars: charBudget() })].filter(
        (s): s is string => Boolean(s),
      );
      return additions.length > 0 ? { systemPrompt: [event.systemPrompt, ...additions].join('\n\n') } : undefined;
    }

    // Clear an acknowledged scene event only at the next narrative boundary.
    if (eventsEnabled && eventConsumed) {
      pendingEvent = null;
      eventConsumed = false;
    }

    roleplayRemindersPending = true;
    pendingEventForRun = eventsEnabled && pendingEvent ? formatEventDirector(pendingEvent) : null;
    pendingEventGenerationForRun = pendingEventForRun ? pendingEventGeneration : null;
    const prompt = event.messageType === 'user' ? event.prompt : messageContentToText(event.message.content);
    // Character folds and depth lore use the window frozen before this run's tools.
    const sceneScanDepth = loadRoleplayConfig(cwd, envCharBudget).scanDepth;
    const sceneScanText = `${concatRecentMessageText(lastMessages, sceneScanDepth)}\n${prompt}`;
    pendingDepthScan = depthInjectEnabled ? sceneScanText : null;
    if (!autoInjectEnabled) {
      keywordVisualLore = [];
      return undefined;
    }
    timing.turnCount += 1;
    lastLoreSelection = createLoreSelection(timing.turnCount);
    const scene = buildSceneBlock(ctx, sceneScanText);
    lastSceneBlock = scene;
    const index = formatRoleplayBlock(state, { maxChars: charBudget() });
    // Keyword-fired lore is VOLATILE per-turn state (membership shifts on
    // every topic change), so it does NOT go in the system prompt - it would
    // bust the prompt-prefix cache on each shift. Compute it here (the timing
    // pass advances `timingState` exactly once per turn) and stash it in
    // `pendingLore`; the `context` hook injects it as an ephemeral
    // `<system-reminder id="roleplay-lore">` on the tail. Only the stable
    // POV/pinned `scene` block and the cast `index` stay at the head.
    pendingLore = buildLoreInjection(prompt);
    const additions = [scene, index].filter((s): s is string => Boolean(s));
    if (additions.length === 0) return undefined;
    return { systemPrompt: [event.systemPrompt, ...additions].join('\n\n') };
  });

  /** Depth-tagged lore is selected and rendered once for the frozen narrative window. */
  const buildDepthLore = (scanText: string): LoreDepthChunk[] => {
    depthVisualLore = [];
    if (!lorebookEnabled) return [];
    const empties = emptyLoreIds();
    const lore = state.entries.filter(
      (entry) => entry.kind === 'lore' && entry.lore?.depth !== undefined && !empties.has(entry.id),
    );
    const chunks: LoreChunk[] = matchLore(lore, scanText)
      .map((entry) => ({
        entry,
        body: normalizeInjectedBody(substituteMacros(readEntryBody(state.cast, entry) ?? '', macroCtx())),
      }))
      .filter((chunk) => chunk.body.length > 0);
    const selected = selectWithinBudget(chunks, loadRoleplayConfig(cwd, envCharBudget).loreCharBudget);
    if (lastLoreSelection) recordDepthSelection(lastLoreSelection, selected);
    const { kept } = selected;
    depthVisualLore = kept;
    return kept.map((chunk) => ({ name: chunk.entry.name, body: chunk.body, depth: chunk.entry.lore?.depth ?? 0 }));
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
    const texts = collectRoleMessageTexts(messages, { role: 'assistant', window: cfg.repetitionWindow });
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

  /** Resolve a roleplay child agent by name from the default agent layers. */
  const loadAgent = (name: string): AgentDef | null =>
    loadRoleplayAgent({
      name,
      extensionDir: extDir,
      cwd,
      knownToolNames: new Set(pi.getAllTools().map((t) => t.name)),
      fs: readLayer,
    });

  /** Build the summarizer once (settings + agent resolution), then reuse it. */
  const getSummarizer = (ctx: ExtensionContext): Summarizer<Model<any>> | null => {
    if (summarizerInit) return summarizer;
    summarizerInit = true;
    try {
      const settings = resolveSummarizeSettings({ cwd });
      summarizer = createSummarizer<Model<any>>({
        settings,
        summarizerAgent: loadAgent('roleplay-summarizer'),
        maxOutputChars: loadRoleplayConfig(cwd, envCharBudget).summarizeMaxChars,
        // Pin the summarizer's neutral sampler (frontmatter `requestOptions`)
        // onto the child's provider request: the child loads with
        // noExtensions, so the persona's before_provider_request never fires
        // there (no leak) and the inline gate is the pin.
        runOneShot: (args) =>
          runRoleplayChild({
            ...args,
            extensionLabel: 'roleplay-summarize',
            parentSessionManager: ctx.sessionManager,
            pinRequestOptions: true,
          }),
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
    return { role, text: messageContentToText((m as { content?: unknown }).content, '\n') };
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
    /**
     * Raw trimmed model text before the over-cap discard - `next` is `null`
     * when the candidate exceeded the char cap, but `raw` preserves it so the
     * forced path can salvage it via {@link clampSummary}. `null` on a
     * spawn/stop failure or an empty / `null`-sentinel response.
     */
    raw: string | null;
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
    if (!sum?.isEnabled()) return { next: null, raw: null, applied: false, spanLen: 0, priorLen, startedAt };
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    const maxSpanChars = deriveMaxSpanChars({
      contextWindowTokens: info.model?.contextWindow,
      priorRecapChars: priorLen,
      charsPerToken: win.charsPerToken,
    });
    const plan = planSummarization(span, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
    if (!plan) return { next: null, raw: null, applied: false, spanLen: 0, priorLen, startedAt };
    let next: string | null = null;
    let raw: string | null = null;
    try {
      const detailed = await sum.summarizeDetailed(
        { cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never, signal },
        plan.spanText,
        prior.trim() ? prior : undefined,
        resolvePromptGuidance('summary', { cwd }),
      );
      next = detailed.recap;
      raw = detailed.raw;
    } catch {
      next = null;
      raw = null;
    }
    return { next, raw, applied: acceptRecap(prior, next), spanLen: plan.messageCount, priorLen, startedAt };
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
    mode: 'sync' | 'async' | 'compact';
    forced?: boolean;
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
        forced: o.forced ?? false,
        candidateChars: o.result.next?.length ?? 0,
        recapChars: win.recapText.length,
        // The actual recap text, so drift is inspectable from the audit log
        // itself (its stated purpose) without opening `summary/auto.md`.
        // `candidate` is this roll's raw generation; `recap` is the effective
        // recap now in force (prior one held when a generation is rejected).
        candidate: o.result.next ?? null,
        recap: win.recapText,
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
  ): ((ctx: ExtensionContext, task: string, signal?: AbortSignal) => Promise<string | null>) | null => {
    const theAgent = loadAgent(agentName);
    if (!theAgent) return null;
    const settings = (() => {
      try {
        return resolveSummarizeSettings({ cwd });
      } catch {
        return null;
      }
    })();
    return async (rctx, task, signal) => {
      const resolution = resolveChildModel({
        override: settings?.summarizeModel,
        agent: theAgent,
        parent: rctx.model,
        modelRegistry: rctx.modelRegistry as never,
      });
      if (!resolution.ok) return null;
      try {
        const result = await runRoleplayChild({
          extensionLabel: 'roleplay-summarize',
          parentSessionManager: rctx.sessionManager,
          cwd,
          agent: theAgent,
          model: resolution.model,
          task,
          modelRegistry: rctx.modelRegistry as never,
          pinRequestOptions: true,
          // The caller's explicit signal (the recap's AbortController on the
          // async path, the turn signal on the sync path), never the turn's
          // `rctx.signal` implicitly: a background capture must be cancellable
          // by resetWindowState and must not die with an unrelated turn abort.
          ...(signal ? { signal } : {}),
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
  ): ((ctx: ExtensionContext, task: string, signal?: AbortSignal) => Promise<string | null>) | null => {
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
  ): ((ctx: ExtensionContext, task: string, signal?: AbortSignal) => Promise<string | null>) | null => {
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
   * Append new beats to the per-cast carry-over `timeline/auto.md` (a TRUE
   * append via {@link appendTimelineCarryOver}: concurrent same-cast sessions
   * interleave lines instead of clobbering; the file rotates its older half
   * into `timeline/archive/` past `timelineFileMaxChars`). Also folds the
   * new lines into the in-memory `timelineText` (capped to
   * `timelineMemoryMaxChars` of whole beat lines). Returns the lines newly
   * added to `timelineText` (the v2 branch-entry delta). Best-effort; never
   * throws.
   */
  const appendTimelineBeats = (lines: string): string => {
    if (lines.trim().length === 0) return '';
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    // De-dup on append: overlapping span coverage across rolls (or a
    // resume/fork replay) re-extracts identical beats, which the append-only
    // log would otherwise stack verbatim. `dedupeNewBeats` drops any
    // candidate line already present in the target store (exact match on
    // normalized text) and collapses repeats within the batch; distinct
    // wording of a genuine recurrence still survives.
    //
    // The within-session / resume / fork store is the SESSION BRANCH (the
    // `roleplay-timeline` audit entry carries each roll's delta - see
    // captureTimeline); this only refreshes the cross-session carry-over.
    try {
      const now = new Date();
      appendTimelineCarryOver(state.cast, lines, {
        maxChars: cfg.timelineFileMaxChars,
        ts: now
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z'),
        description: `Chronological scene beats, auto-updated ${now.toISOString().slice(0, 10)}`,
      });
    } catch {
      /* carry-over append best-effort */
    }
    // Keep the injected timeline current in-memory too (de-duped against it).
    const freshMem = dedupeNewBeats(lines, win.timelineText);
    if (freshMem.length > 0) {
      win.timelineText = capBeatLog(appendBeatBody(win.timelineText, freshMem), cfg.timelineMemoryMaxChars);
    }
    return freshMem;
  };

  /**
   * Additive, anti-drift timeline capture on the roll: extract dated story
   * beats from the aged span with the `roleplay-timeline-extractor` subagent
   * and APPEND them to the two-tier timeline logs. Runs on the SAME span as
   * the recap + capture, AFTER the recap resolves (shares the recap endpoint,
   * so it must not run concurrently) and is AWAITED (never fire-and-forget).
   * Default-OFF (`PI_ROLEPLAY_TIMELINE`); best-effort, never throws.
   *
   * `signal` cancels the extractor (the recap's AbortController on the async
   * path). `isCurrent` is re-checked after the extractor resolves: when a
   * reset / branch change invalidated this roll meanwhile, the beats are
   * discarded before mutating `timelineText` or appending a branch entry.
   */
  const captureTimeline = async (
    ctx: ExtensionContext,
    span: SummarizableMessage[],
    sid: string | null,
    signal: AbortSignal | undefined,
    isCurrent: () => boolean,
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
      // v2: only this roll's NEW beat lines (a delta, not the cumulative
      // log) so the session JSONL grows linearly. Hydration rebuilds the
      // timeline from the latest legacy snapshot + every later delta (see
      // scanBranchForTimeline). Empty on skip paths.
      version: 2 as const,
      beats: '' as string,
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
        charsPerToken: win.charsPerToken,
      });
      const plan = planSummarization(span, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
      if (!plan) {
        audit.skip = 'no-plan';
        emit();
        return;
      }
      audit.planned = true;
      const raw = await extractor(
        ctx,
        buildTimelineExtractionTask(plan.spanText, resolvePromptGuidance('timeline', { cwd })),
        signal,
      );
      // Stale (reset / branch change while extracting): discard silently -
      // no in-memory mutation and no entry on the (now different) branch.
      if (!isCurrent()) return;
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
      // Stamp the delta into the audit entry so it doubles as the
      // branch-primary timeline store (see hydrateTimelineFromBranch).
      audit.beats = appendTimelineBeats(formatBeatLines(beats));
      audit.wrote = beats.length;
      emit();
    } catch {
      audit.skip = 'error';
      emit();
    }
  };

  const captureFacts = async (
    ctx: ExtensionContext,
    span: SummarizableMessage[],
    sid: string | null,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
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
    // `sid` is snapshotted by the caller at roll-plan time: the async path
    // must not read the session manager inside its `.then`.
    const sessionId = sid;
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
        charsPerToken: win.charsPerToken,
      });
      const plan = planSummarization(span, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
      if (!plan) {
        audit.skip = 'no-plan';
        emit();
        return;
      }
      audit.planned = true;
      const raw = await extractor(
        ctx,
        buildFactExtractionTask(plan.spanText, resolvePromptGuidance('facts', { cwd })),
        signal,
      );
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

  // `remindersEnabled && autoInjectEnabled` covers the `roleplay-scene-fold` producer.
  if (
    contextWindowEnabled ||
    lorebookEnabled ||
    depthInjectEnabled ||
    repetitionEnabled ||
    eventsEnabled ||
    (remindersEnabled && autoInjectEnabled)
  ) {
    // Recover a running recap from the SESSION BRANCH (custom recap-audit
    // entries), which travels with pi's session tree and carries the exact
    // coverage boundary. This is the authoritative resume source when the
    // file store has no record for this session - e.g. a session first managed
    // by the retired `rp-context-window` experiment (entries named
    // `rp-context-recap`), or one whose `summary/` files were lost. Without it,
    // resuming a long pre-file-store session cold-starts at recapCutoff 0 and
    // the drop boundary never engages (observed: a 1674-message scene overflowed
    // the model window). Scans newest-first for the last applied recap.
    // Materialise the active branch entries (`getBranch()` returns only the
    // active root-to-leaf path). The pure newest-first scans live in
    // `roleplay/branch-hydration.ts`; this glue owns just the pi call + guard.
    const getBranchEntries = (c: { sessionManager?: unknown }): Record<string, unknown>[] | null => {
      let entries: Record<string, unknown>[] | undefined;
      try {
        entries = (c.sessionManager as { getBranch?: () => Record<string, unknown>[] } | undefined)?.getBranch?.();
      } catch {
        entries = undefined;
      }
      return Array.isArray(entries) ? entries : null;
    };

    const hydrateRecapFromBranch = (c: { sessionManager?: unknown }, natural: number): BranchRecap | null => {
      const entries = getBranchEntries(c);
      return entries ? scanBranchForRecap(entries, natural) : null;
    };

    const hydrateTimelineFromBranch = (c: { sessionManager?: unknown }): string | null => {
      const entries = getBranchEntries(c);
      return entries ? scanBranchForTimeline(entries) : null;
    };

    pi.on('context', async (event, ctx) => {
      if (activeCast() === null) return undefined;
      // Capture the live scene so the `/roleplay event` command (which runs
      // between turns, without message access) can read recent context.
      const identified = ensureReminderIdentities(
        event.messages as unknown as ReminderMessage[],
        ctx.sessionManager.buildSessionProjection?.(),
        true,
      );
      lastMessages = identified;

      let messages = identified as unknown as readonly Record<string, unknown>[];
      let changed = identified.some((message, index) => message !== event.messages[index]);

      // Rolling window: bounded recap drop (recap mode) or condense-only
      // floor. Runs first so narrative reminders below operate on the
      // already-reduced list (they are tail-oriented, unaffected by the drop).
      if (contextWindowEnabled) {
        const opts = windowOptions();
        const natural = computeCutoff(messages, opts.keepTurns);
        // Fresh / shorter conversation (new run, branch switch, resume): drop stale state.
        if (natural < win.committedCutoff) resetWindowState();

        // Calibrate chars/token against the PREVIOUS turn's reported usage
        // (ground truth) so the span-budget math is measured, not guessed.
        try {
          const usage = ctx.getContextUsage?.();
          if (usage && typeof usage.tokens === 'number' && usage.tokens > 0 && win.lastSentEstChars > 0) {
            win.charsPerToken = updateCharsPerToken(win.charsPerToken, win.lastSentEstChars, usage.tokens);
          }
        } catch {
          /* usage is best-effort */
        }

        // Lazily hydrate the recap once per (re)load, so a resume continues
        // the memory instead of rebuilding it (branch first, then the
        // per-cast carry-over seed; see the ladder below).
        if (!win.recapHydrated) {
          win.recapHydrated = true;
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
              win.recapText = branchRecap.recap;
              win.recapCutoff = branchRecap.coveredTo;
              win.committedCutoff = branchRecap.coveredTo;
              // Timeline: prefer this branch's cumulative timeline (same
              // active-path guarantee); fall back to the per-cast carry-over
              // log when the branch carries no timeline entry.
              const branchTimeline = hydrateTimelineFromBranch(ctx);
              const priorTimeline =
                branchTimeline ??
                readEntryBody(state.cast, { id: 'auto', kind: 'timeline', name: '', description: '' }) ??
                '';
              if (priorTimeline.trim()) {
                win.timelineText = capBeatLog(
                  priorTimeline.trim(),
                  loadRoleplayConfig(cwd, envCharBudget).timelineMemoryMaxChars,
                );
              }
            } else {
              // 2. New tree (genuinely fresh session, or a fork with no recap
              //    on its path yet): `getBranch()` has nothing to hydrate, so
              //    seed continuity from the per-cast carry-over. Only the recap
              //    TEXT is seeded; coverage stays 0 (recapCutoff =
              //    committedCutoff = 0). The carry-over came from ANOTHER
              //    session, so it covers none of this session's messages: on a
              //    resumed long session that never rolled, claiming `natural`
              //    would drop all aged history and replace it with a foreign
              //    recap. A genuinely fresh session has natural == 0 anyway,
              //    and the seed is still injected (injection keys on recapText,
              //    not coverage). Normal rolls (folding into the seed as prior)
              //    + the safety floor take over from there. 3. Cold start: no
              //    carry-over -> recapText stays ''. Either way this load is a
              //    non-resume, so the one-shot facts seed (B2) may run.
              const priorEntry = state.entries.find((e) => e.kind === 'summary' && e.id === 'auto');
              const prior = priorEntry ? (readEntryBody(state.cast, priorEntry) ?? '') : '';
              if (prior.trim()) win.recapText = prior.trim();
              // Seed the timeline from the per-cast carry-over log (C5).
              const priorTimeline =
                readEntryBody(state.cast, { id: 'auto', kind: 'timeline', name: '', description: '' }) ?? '';
              if (priorTimeline.trim()) {
                win.timelineText = capBeatLog(
                  priorTimeline.trim(),
                  loadRoleplayConfig(cwd, envCharBudget).timelineMemoryMaxChars,
                );
              }
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
        // An armed `/roleplay recap force` rolls off-stride (see planRoll).
        const { roll: rollFired } = planRoll(win, natural, strideValue());
        if (rollFired) {
          /** True once this roll actually started (sync) or launched (async) a recap. */
          let recapStarted = false;
          if (recapMode) {
            const rollCfg = loadRoleplayConfig(cwd, envCharBudget);
            const info = resolveRecapModelInfo(ctx);
            const wantAsync = recapAsyncForced() ?? info.distinct;
            // Snapshot the session id at roll-plan time (decision a): the async
            // path must not read it inside its `.then` (the manager may be gone).
            const sid = currentSessionId(ctx);
            const spanFrom = win.recapCutoff;
            // Cap how far one roll advances coverage so the summarizer only ever
            // merges a digestible increment onto the prior recap (an unbounded
            // spanTo=natural made a stalled recap re-summarize a growing span,
            // collapse below acceptRecap's floor, and wedge - recapCutoff pinned
            // 190 turns in the field). The lag circuit-breaker below guarantees
            // coverage can never wedge permanently even if an increment is still
            // rejected.
            const spanTo = boundRollSpanTo(messages, win.recapCutoff, natural, rollCfg.recapMaxAdvance);
            const lag = natural - win.recapCutoff;
            const lagCeiling = rollCfg.recapLagCeiling;
            const span = messages.slice(spanFrom, spanTo).map(toSummarizable);
            if (wantAsync) {
              // Non-blocking: at most one background recap; return on the PRIOR
              // recap. The floor keeps the not-yet-covered span present until
              // the result lands, so nothing is lost; the drop boundary just
              // advances a turn or two later. gen-guarded against a
              // reset / branch change clobbering the current recap after the fact.
              if (!win.recapInFlight) {
                win.recapInFlight = true;
                recapStarted = true;
                const gen = win.recapGen;
                const isCurrent = (): boolean => gen === win.recapGen;
                const prior = win.recapText;
                const abort = new AbortController();
                win.recapAbort = abort;
                void doRecap(ctx, span, prior, info, abort.signal)
                  .then(async (result) => {
                    if (!isCurrent()) return; // stale (reset / branch change): discard
                    // Force-accept a rejected-but-usable candidate once coverage
                    // has lagged past the ceiling, so a persistently collapsing
                    // OR persistently over-cap summarizer can't wedge coverage
                    // forever. On the FORCED path only we salvage an over-cap
                    // candidate by clamping the raw text (result.next is null,
                    // but result.raw preserves it) - the normal path still drops
                    // a runaway rather than truncating it.
                    const salvaged = result.applied
                      ? result.next
                      : clampSummary(result.raw ?? '', rollCfg.summarizeMaxChars);
                    const forced = !result.applied && shouldForceRecap({ candidate: salvaged, lag, lagCeiling });
                    const commit = result.applied ? result.next : forced ? salvaged : null;
                    if (commit) {
                      win.recapText = commit;
                      win.recapCutoff = spanTo;
                      writeRecapRecord(commit, sid);
                    }
                    writeRecapAudit({ result, model: info.model, spanFrom, spanTo, mode: 'async', forced });
                    if (commit) {
                      // Capture runs SEQUENTIALLY after the recap, and is
                      // AWAITED inside the chain so `recapInFlight` stays set
                      // until it finishes. Both matter: the fact-extractor
                      // shares the recap endpoint, so awaiting stops the next
                      // roll from starting a concurrent recap on that single
                      // instance, and keeps capture from being orphaned as a
                      // fire-and-forget promise when the turn returns. Both
                      // extractors run under the recap's own AbortController
                      // (cancelled by resetWindowState, immune to a turn
                      // abort) and re-check staleness after every await.
                      await captureFacts(ctx, span, sid, abort.signal);
                      if (!isCurrent()) return;
                      // Timeline runs AFTER capture, sequential + awaited, for
                      // the same single-endpoint reason (C4).
                      await captureTimeline(ctx, span, sid, abort.signal, isCurrent);
                    }
                  })
                  .catch(() => {
                    /* keep prior recap + floor; retried on the next roll */
                  })
                  .finally(() => {
                    if (gen === win.recapGen) {
                      win.recapInFlight = false;
                      win.recapAbort = null;
                    }
                  });
              }
            } else {
              // Blocking (inherited / same endpoint): one llama.cpp instance
              // cannot serve the recap and the main turn concurrently.
              recapStarted = true;
              const gen = win.recapGen;
              const result = await doRecap(ctx, span, win.recapText, info, ctx.signal);
              const salvaged = result.applied ? result.next : clampSummary(result.raw ?? '', rollCfg.summarizeMaxChars);
              const forced = !result.applied && shouldForceRecap({ candidate: salvaged, lag, lagCeiling });
              const commit = result.applied ? result.next : forced ? salvaged : null;
              if (commit) {
                win.recapText = commit;
                win.recapCutoff = spanTo;
                writeRecapRecord(commit, sid);
                await captureFacts(ctx, span, sid, ctx.signal);
                await captureTimeline(ctx, span, sid, ctx.signal, () => gen === win.recapGen);
              }
              writeRecapAudit({ result, model: info.model, spanFrom, spanTo, mode: 'sync', forced });
            }
          }
          // Advance the condense boundary to `natural`, so the planRecap gate
          // fires at the stride (every ~stride aged messages), NOT every turn.
          // A bounded recap backlog still drains: each stride-roll summarizes a
          // digestible `recapMaxAdvance` chunk (boundRollSpanTo), advancing
          // recapCutoff faster than `natural` grows. Draining every turn instead
          // (committedCutoff = min(recapCutoff, natural)) churns the
          // front-injected recap and re-cuts the floor every turn, busting the
          // prompt-prefix cache on a session catching up a large backlog.
          //
          // In recap mode, only advance when a recap was actually started
          // this roll: if an in-flight async recap blocked it, holding the
          // boundary keeps planRecap firing so the backlog starts as soon as
          // the in-flight one lands, instead of waiting a whole extra stride.
          // Holding is also cache-neutral (the frozen prefix does not move).
          if (!recapMode || recapStarted) win.committedCutoff = natural;
          settleForcedRecap(win, recapStarted);
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
        // Freeze arithmetic + overflow valve live in `planWindowFloor`
        // (roleplay/window-pass.ts). Reserve against what is ACTUALLY
        // injected, not the raw cumulative stores: `recapText` is bounded by
        // `summarizeMaxChars`, but the timeline is injected through
        // `renderTimelineBlock` capped at `timelineMaxInjectChars`, while
        // `timelineText` is the many-KB cumulative append-log.
        let floorCutoff = 0;
        const windowTokens = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
        if (typeof windowTokens === 'number' && windowTokens > 0) {
          const sysChars = (typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '')?.length ?? 0;
          const timelineInjectChars = win.timelineText
            ? (renderTimelineBlock(win.timelineText, {
                maxChars: loadRoleplayConfig(cwd, envCharBudget).timelineMaxInjectChars,
              })?.length ?? 0)
            : 0;
          const floor = planWindowFloor({
            messages,
            windowTokens,
            sysChars,
            injectChars: win.recapText.length + timelineInjectChars,
            charsPerToken: win.charsPerToken,
            frozenFloorCutoff: win.frozenFloorCutoff,
            recapCutoff: win.recapCutoff,
          });
          // NB never keyed on `rollFired`: a session draining a recap backlog
          // rolls every turn, which would wiggle the floor and defeat the freeze.
          win.frozenFloorCutoff = floor.frozenFloorCutoff;
          floorCutoff = floor.floorCutoff;
        }
        const dropCutoff = Math.max(win.recapCutoff, floorCutoff);

        // Apply the window: layered drop+condense+inject (recap mode), the
        // hard-drop floor (recap off, over budget), or condense-only.
        const pass = applyWindowPass({
          messages,
          recapMode,
          dropCutoff,
          floorCutoff,
          committedCutoff: win.committedCutoff,
          recapText: win.recapText,
          timelineBlock:
            recapMode && win.timelineText.trim()
              ? renderTimelineBlock(win.timelineText, {
                  maxChars: loadRoleplayConfig(cwd, envCharBudget).timelineMaxInjectChars,
                })
              : null,
          opts,
        });
        if (pass.changed) {
          messages = pass.messages;
          changed = true;
        }

        // Opt-in per-turn composition audit (custom log entry, never sent to
        // the LLM) so the savings + token sawtooth are measurable.
        if (contextWindowDebug) {
          try {
            const sysChars = (typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '')?.length ?? 0;
            const fullChars = estimateChars(event.messages as unknown as readonly Record<string, unknown>[]);
            const sentChars = estimateChars(messages);
            const cpt = win.charsPerToken > 0 ? win.charsPerToken : DEFAULT_CHARS_PER_TOKEN;
            pi.appendEntry('roleplay-context-window-debug', {
              ts: Date.now(),
              messagesIn: event.messages.length,
              messagesOut: messages.length,
              natural,
              committedCutoff: win.committedCutoff,
              recapCutoff: win.recapCutoff,
              floorCutoff,
              dropCutoff,
              recapMode,
              recapChars: win.recapText.length,
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

        // Track what we sent so next turn can calibrate against its usage, and
        // snapshot the window state for the `/roleplay context` readout.
        try {
          const cpt = win.charsPerToken > 0 ? win.charsPerToken : DEFAULT_CHARS_PER_TOKEN;
          const sysChars = (typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '')?.length ?? 0;
          const sentChars = estimateChars(messages);
          const fullChars = estimateChars(event.messages as unknown as readonly Record<string, unknown>[]);
          win.lastSentEstChars = sysChars + sentChars;
          const prev = lastWindowSnapshot;
          lastWindowSnapshot = {
            ts: Date.now(),
            messagesIn: event.messages.length,
            messagesOut: messages.length,
            natural,
            committedCutoff: win.committedCutoff,
            recapCutoff: win.recapCutoff,
            floorCutoff,
            dropCutoff,
            frozenFloorCutoff: win.frozenFloorCutoff,
            recapChars: win.recapText.length,
            recapInFlight: win.recapInFlight,
            estSystemTokens: Math.round(sysChars / cpt),
            estFullPromptTokens: Math.round((sysChars + fullChars) / cpt),
            estSentPromptTokens: Math.round((sysChars + sentChars) / cpt),
            estSavedTokens: Math.round((fullChars - sentChars) / cpt),
            charsPerToken: Math.round(cpt * 100) / 100,
            dropMoved: prev ? dropCutoff !== prev.dropCutoff : false,
            recapChanged: prev ? win.recapText.length !== prev.recapChars : false,
          };
        } catch {
          win.lastSentEstChars = 0;
        }
      }

      // Emit once for the initiating narrative input. The final coordinator
      // replays its anchored snapshot on every later request, including tools.
      if (roleplayRemindersPending) {
        roleplayRemindersPending = false;
        const tail = messages.at(-1);
        if (tail?.role === 'user' || tail?.role === 'custom') {
          const reminders: { id: string; body: string | null }[] = [];
          if (depthInjectEnabled && pendingDepthScan !== null) {
            const persona = getActivePersona();
            const cfg = loadRoleplayConfig(cwd, envCharBudget);
            const insertions = buildInsertions({
              authorNote: persona?.authorNote ? substituteMacros(persona.authorNote, macroCtx()) : undefined,
              authorNoteDepth: persona?.authorNoteDepth,
              lore: buildDepthLore(pendingDepthScan),
            });
            const plan = cfg.depthLoreInlineTail ? planDepthTailMerge(insertions) : { insertions, tailBlock: null };
            // Keep relative depths until the coordinator binds the actual trigger
            // and finishes window planning. Only the accepted request freezes anchors.
            pi.events.emit('cache-reminders:insertions', plan.insertions);
            if (plan.tailBlock) reminders.push({ id: 'roleplay-depth', body: plan.tailBlock });
          }
          const sceneFold = pendingSceneFold;
          pendingSceneFold = null;
          if (sceneFold) {
            reminders.push({ id: 'roleplay-scene-fold', body: sceneFold.body });
            // Only sheets that actually reached this run's snapshot count as delivered.
            for (const id of sceneFold.ids) timing.sceneFoldDelivered.set(id, sceneFold.turn);
          }
          if (lorebookEnabled) reminders.push({ id: 'roleplay-lore', body: pendingLore });
          if (repetitionEnabled) reminders.push({ id: 'roleplay-repetition', body: buildRepetitionNudge(messages) });
          if (eventsEnabled) reminders.push({ id: 'roleplay-event', body: pendingEventForRun });
          let rm = messages as unknown as ReminderMessage[];
          for (const spec of reminders) rm = applyContextReminder(rm, spec);
          if (reminders.some((r) => r.body)) {
            messages = rm;
            changed = true;
          }
        }
      }

      return changed ? { messages: messages as unknown as typeof event.messages } : undefined;
    });
  }

  // The safety floor must see historical and first-request snapshot bytes.
  // Synchronous previews do not persist candidates or acknowledge events.
  unsubscribePipeline.push(
    pi.events.on(REMINDER_CAPABILITIES, (data) => {
      const request = data as ReminderCapabilities;
      const ctx = request.context as ExtensionContext;
      if (contextWindowEnabled && activeCast() !== null && ctx.model?.contextWindow) request.limiterRequired = true;
    }),
    pi.events.on(REMINDER_LIMIT, (data) => {
      if (!contextWindowEnabled || activeCast() === null) return;
      const request = data as ReminderLimitRequest;
      const ctx = request.context as ExtensionContext;
      const windowTokens = ctx.model?.contextWindow;
      if (typeof windowTokens !== 'number' || !Number.isFinite(windowTokens) || windowTokens <= 0) return;
      const result = limitReminderContext({
        messages: request.messages,
        preview: request.preview,
        origin: request.origin,
        floorAnchor: win.projectedFloorAnchor,
        windowTokens,
        charsPerToken: win.charsPerToken,
      });
      request.result = result;
      if (result.fits) win.projectedFloorAnchor = result.floorAnchor;
    }),
    pi.events.on(REMINDER_PROJECTED, (data) => {
      if (activeCast() === null) return;
      const request = data as ReminderProjectedRequest;
      win.lastSentEstChars = reminderRequestChars(request.messages);
      if (lastWindowSnapshot) {
        const sent = Math.round(win.lastSentEstChars / win.charsPerToken);
        lastWindowSnapshot = {
          ...lastWindowSnapshot,
          messagesOut: request.messages.length,
          estSentPromptTokens: sent,
          estFullPromptTokens: Math.max(sent, lastWindowSnapshot.estFullPromptTokens),
          estSavedTokens: Math.max(0, lastWindowSnapshot.estFullPromptTokens - sent),
        };
      }
    }),
  );

  // ── Compaction side-write (manual / overflow) ───────────────────────
  //
  // The rolling window (context hook) owns the common path; this handler
  // only cancels pi's THRESHOLD auto-compaction (recap mode with a resolved
  // summarizer) and, on the manual /
  // overflow safety-net paths, folds the evicted span into the running
  // recap (a strict side-write that never breaks compaction). Summarizer
  // infra (extDir / getSummarizer / toSummarizable) is defined above.
  if (summarizeEnabled) {
    pi.on('session_before_compact', async (event, ctx) => {
      const reason = (event as unknown as { reason?: string }).reason;
      // Own context management: cancel pi's THRESHOLD auto-compaction so the
      // rolling window is the sole manager and the see-saw stops. Only in
      // recap (size-bounded) mode AND only when a summarizer resolves: with
      // none, the recap never covers anything and the floor would silently
      // drop history, so let pi summarize it instead. Manual `/compact` and
      // genuine overflow recovery always run (belt-and-suspenders safety net).
      if (ownCompaction && reason === 'threshold' && (getSummarizer(ctx)?.isEnabled() ?? false)) {
        return { cancel: true };
      }
      // Manual / overflow (or threshold when not owning): fold the evicted
      // span into the recap so continuity survives the compaction.
      try {
        if (activeCast() === null) return undefined;
        resyncIfChanged(ctx);
        if (state.cast.length === 0) return undefined;
        const cfg = loadRoleplayConfig(cwd, envCharBudget);
        // Prior: the in-memory, branch-correct recap. The per-cast carry-over
        // (`summary/auto.md`, shared across same-cast sessions) is only a
        // fallback when this process holds no recap (e.g. the context window
        // is off, or nothing has hydrated / rolled yet).
        let prior = win.recapText.trim();
        if (!prior) {
          const priorEntry = state.entries.find((e) => e.kind === 'summary' && e.id === 'auto');
          prior = priorEntry ? (readEntryBody(state.cast, priorEntry) ?? '').trim() : '';
        }
        const info = resolveRecapModelInfo(ctx);
        const maxSpanChars = deriveMaxSpanChars({
          contextWindowTokens: info.model?.contextWindow,
          priorRecapChars: prior.length,
          charsPerToken: win.charsPerToken,
        });
        const messages = (event.preparation?.messagesToSummarize ?? []).map(toSummarizable);
        const plan = planSummarization(messages, { minMessages: cfg.summarizeMinMessages, maxSpanChars });
        if (!plan) return undefined;
        const sum = getSummarizer(ctx);
        if (!sum?.isEnabled()) return undefined;
        const startedAt = Date.now();
        const recap = await sum.summarize(
          { cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never, signal: event.signal },
          plan.spanText,
          prior || undefined,
          resolvePromptGuidance('summary', { cwd }),
        );
        // Collapse guard: never let a degenerate recap clobber a longer prior.
        if (recap === null || !acceptRecap(prior, recap)) return undefined;
        win.recapText = recap;
        // Refresh the per-cast carry-over seed, and keep the in-memory index
        // aware of it WITHOUT applyCast (which would reset lorebook timing as
        // a side effect).
        writeRecapRecord(recap, currentSessionId(ctx));
        const rec = composeAutoSummaryRecord(recap);
        state = {
          cast: state.cast,
          entries: upsertEntry(state.entries, {
            id: rec.id,
            kind: 'summary',
            name: rec.name,
            description: rec.description,
          }),
        };
        // Branch-primary store: stamp the recap on the branch. Coverage is 0
        // because indices into the pre-compaction message array mean nothing
        // afterwards (scanBranchForRecap also zeroes coverage for any recap
        // followed by a compaction entry, so this stays consistent).
        writeRecapAudit({
          result: {
            next: recap,
            raw: recap,
            applied: true,
            spanLen: plan.messageCount,
            priorLen: prior.length,
            startedAt,
          },
          model: info.model,
          spanFrom: 0,
          spanTo: 0,
          mode: 'compact',
        });
        ctx.ui.notify(`roleplay: folded ${plan.messageCount} evicted message(s) into the auto recap.`, 'info');
      } catch {
        // Side-write must never break compaction.
      }
      return undefined;
    });
  }

  // After a successful compaction the context is a NEW, shorter message
  // array (compaction summary + kept messages), so every index-valued cutoff
  // is stale. Keep the recap / timeline TEXT (still the scene memory) but
  // reset coverage to 0 and invalidate any in-flight async recap (its
  // `spanTo` indexes the old array). Normal rolls re-anchor coverage.
  if (contextWindowEnabled) {
    pi.on('session_compact', () => resetWindowCoverage(win));
  }

  // ── Scene events (/roleplay event) ──────────────────────────────────

  if (eventsEnabled) {
    unsubscribeReminderSnapshots = pi.events.on('cache-reminders:captured', (data) => {
      const snapshot = data as ReminderSnapshot | undefined;
      if (
        pendingEvent &&
        snapshot &&
        isCurrentEventCapture({
          pendingGeneration: pendingEventGeneration,
          frozenGeneration: pendingEventGenerationForRun,
          frozenBody: pendingEventForRun,
          specs: snapshot.specs,
        })
      )
        eventConsumed = true;
    });
  }
  //
  // `/roleplay event [hint]` queues a one-shot complication, generated by
  // the `roleplay-event` agent (default; always when a hint is given) and
  // falling back to the user's `events` deck. The generator mirrors the
  // summarizer wiring but, unlike it, stays enabled without an explicit
  // model (it inherits the parent session model) - only a missing agent
  // disables it.
  let eventGen: EventGenerator<Model<any>> | null = null;
  let eventGenInit = false;

  const getEventGenerator = (ctx: ExtensionContext): EventGenerator<Model<any>> | null => {
    if (eventGenInit) return eventGen;
    eventGenInit = true;
    try {
      const settings = resolveEventSettings({ cwd });
      eventGen = createEventGenerator<Model<any>>({
        settings,
        eventAgent: loadAgent('roleplay-event'),
        maxOutputChars: loadRoleplayConfig(cwd, envCharBudget).eventMaxChars,
        runOneShot: (args) =>
          runRoleplayChild({
            ...args,
            extensionLabel: 'roleplay-event',
            parentSessionManager: ctx.sessionManager,
            pinRequestOptions: false,
          }),
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
    // pi's bus already isolates this handler in its own try/catch, so a throw
    // here can't reach the emitting comfyui render - no extra guard needed.
    unsubscribeImageEvents = pi.events.on(COMFYUI_IMAGE_CHANNEL, (data) => {
      if (!isImageGeneratedEvent(data)) return;
      if (activeCast() === null) return;
      const path = data.savedPaths.at(-1);
      if (path) setAvatarInput({ scene: { path } });
    });
  }

  pi.on('session_shutdown', () => {
    try {
      setRoleplayImageModeOverride(undefined);
      clearActiveRoleplay();
      if (avatarDriveEnabled) clearAvatarInput();
      if (unsubscribeImageEvents) {
        unsubscribeImageEvents();
        unsubscribeImageEvents = null;
      }
    } catch {
      // teardown must never throw
    }
    try {
      unsubscribeReminderSnapshots?.();
    } catch {
      // A separate bus teardown must still run if another resource failed.
    }
    unsubscribeReminderSnapshots = null;
    for (const unsubscribe of unsubscribePipeline.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // One failing unsubscribe must not block the rest of teardown.
      }
    }
    // Lazily built runners capture the first ctx they saw; drop them so a
    // later session rebuilds against its own ctx.
    summarizer = null;
    summarizerInit = false;
    eventGen = null;
    eventGenInit = false;
    factExtractor = null;
    factExtractorInit = false;
    timelineExtractor = null;
    timelineExtractorInit = false;
    state = emptyState();
    castOverride = null;
    syncedCast = null;
    pendingEvent = null;
    eventConsumed = false;
    pendingLore = null;
    pendingSceneFold = null;
    lastLoreSelection = null;
    resetSceneFoldDelivery(timing);
    frozenMacroNow = null;
    pendingDepthScan = null;
    pendingEventForRun = null;
    pendingEventGenerationForRun = null;
    roleplayRemindersPending = false;
    lastSceneBlock = null;
    excludeCache = null;
    loreEmptyCache = null;
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
    loreEmptyCache = null;
  };

  /** Perform a planned mutation: writes first, then removes, then commit + persist the index. */
  const applyPlan = (action: string, plan: ActionPlan): ActionOut => {
    if (!plan.ok) return fail(action, plan.error);
    for (const w of plan.writes) atomicWriteFile(w.path, w.content);
    for (const path of plan.removes) removeFileIfExists(path);
    state = plan.state;
    persist();
    return { content: plan.content, details: { action, state: cloneState(state), entry: plan.entry } };
  };

  const readBody = (entry: RoleplayEntry): string | null => readEntryBody(state.cast, entry);

  const actSave = (params: RoleplayParamsT): ActionOut => applyPlan('save', planSave(state, params));

  const actUpdate = (params: RoleplayParamsT): ActionOut => applyPlan('update', planUpdate(state, params, readBody));

  const actRemove = (params: RoleplayParamsT): ActionOut => applyPlan('remove', planRemove(state, params));

  const actSearch = (params: RoleplayParamsT): ActionOut => {
    const plan = planSearch(state, params, readBody);
    if (!plan.ok) return fail('search', plan.error);
    return { content: plan.content, details: { action: 'search', state: cloneState(state), matches: plan.matches } };
  };

  // ── Card import (/roleplay import) ──────────────────────────────────
  /**
   * Import a SillyTavern character card (`.json` V1/V2/V3 or `.png` with a
   * `chara`/`ccv3` chunk) into the active cast: writes one `character`
   * record (carrying fold metadata such as V3 nickname aliases) plus a
   * `lore` record per non-empty `character_book` entry (disabled entries
   * are imported with `enabled: false`), then rebuilds `INDEX.md`.
   * Relative paths resolve against `baseDir` (the session cwd) and a
   * leading `~/` expands to the home dir. Returns a human summary or an
   * error string.
   */
  const importCardFile = (
    rawPath: string,
    baseDir: string,
  ): { ok: true; summary: string } | { ok: false; error: string } => {
    const path = resolveImportPath(rawPath, baseDir, homedir());
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
          character: rec.character,
        }),
      );
      const entry: RoleplayEntry = {
        id: slug,
        kind: rec.kind,
        name: rec.name,
        description: rec.description,
        ...(rec.lore ? { lore: rec.lore } : {}),
        ...(rec.character ? { character: rec.character } : {}),
      };
      entries = upsertEntry(entries, entry);
      written.push(`  [${rec.kind}] ${slug} - ${rec.name}`);
    }
    state = { cast: state.cast, entries };
    writeIndex(state);
    excludeCache = null;
    loreEmptyCache = null;

    const lines = [
      `Imported "${plan.characterName}" into cast "${state.cast}": ${plan.records.length} record(s).`,
      ...written,
    ];
    if (plan.warnings.length > 0) lines.push('', 'Warnings:', ...plan.warnings.map((w) => `  - ${w}`));
    return { ok: true, summary: lines.join('\n') };
  };

  // ── Card export (/roleplay export) ──────────────────────────────────
  /**
   * Export a character record plus every lore record of the active cast
   * (base lore and the currently activated bundles; disabled entries ride
   * along as `enabled: false`) as a SillyTavern Character Card V2 JSON.
   * `rawArgs` is `[character] [path]`: a leading token that resolves to a
   * character selects it (default: the persona's primary character, then
   * the first character record); the remainder is the output path
   * (default `<baseDir>/<slug>.card.json`). Never overwrites a file.
   */
  const exportCardFile = (
    rawArgs: string,
    baseDir: string,
  ): { ok: true; summary: string } | { ok: false; error: string } => {
    const trimmed = rawArgs.trim();
    const first = trimmed.split(/\s+/)[0] ?? '';
    let character = first ? resolveCharacter(state, first) : undefined;
    let pathArg = trimmed;
    if (character) {
      pathArg = trimmed.slice(first.length).trim();
    } else {
      if (first && !/[./~\\]/.test(trimmed))
        return { ok: false, error: `no character "${first}" in cast "${state.cast}"` };
      const primary = primaryCharName();
      character =
        (primary ? resolveCharacter(state, primary) : undefined) ?? state.entries.find((e) => e.kind === 'character');
    }
    if (!character) return { ok: false, error: `cast "${state.cast}" has no character record to export` };
    const path = pathArg ? resolveImportPath(pathArg, baseDir, homedir()) : join(baseDir, `${character.id}.card.json`);
    if (existsSync(path)) return { ok: false, error: `${path} already exists; pick another path` };
    const lore = state.entries
      .filter((e) => e.kind === 'lore' && e.lore)
      .map((e) => ({
        name: e.name,
        description: e.description,
        body: readEntryBody(state.cast, e) ?? '',
        lore: e.lore ?? emptyLoreMeta(),
      }));
    const card = recordsToCard(
      { name: character.name, description: character.description, body: readEntryBody(state.cast, character) ?? '' },
      lore,
    );
    try {
      atomicWriteFile(path, `${JSON.stringify(card, null, 2)}\n`);
    } catch (err) {
      return { ok: false, error: `cannot write ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      ok: true,
      summary: `Exported "${character.name}" with ${lore.length} lore entr(ies) from cast "${state.cast}" to ${path}`,
    };
  };

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: 'roleplay',
    label: 'Roleplay',
    description:
      'Cast-keyed durable store for roleplay scenarios, separate from coding `memory`. Holds character sheets that survive across sessions and workspaces; the active cast is injected each turn under `## Roleplay`. A relevant character sheet also auto-folds into the `## Roleplay scene` block: `pinned` characters every turn, and any character whose name/alias is mentioned in the recent window (precedence `pov` > `pinned` > name-triggered > index-only) - so you rarely need `read`. Actions: list, read (id), save ({name, description, body, kind?}), update (id, {name?, description?, body?}), remove (id), search (query).',
    promptSnippet:
      'Durable cast-keyed roleplay store: character sheets for the active scenario, injected each turn (pinned + name-triggered sheets auto-fold into the scene) and fetched in full on demand.',
    promptGuidelines: [
      'Save a `character` (roleplay action `save`) for a recurring character: voice, appearance, speech tics, hard constraints, first message, example dialogue.',
      'A character sheet auto-folds into the scene when `pinned: true` or when its name/alias appears in the recent messages - prefer that over a `roleplay read` (set `pinned` on always-present leads; add `aliases` for nicknames).',
      'The active cast comes from `/roleplay cast <name>` if set, else the active persona `cast:` (or the persona name).',
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
      const a = args;
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

  // This facade shares ComfyUI's executor, but exposes only scene intent to the model.
  const ImageParams = Type.Object(
    {
      prompt: Type.String({
        minLength: 1,
        maxLength: 4000,
        description:
          'Describe the visible scene in ordinary language. Name the depicted characters when possible. Do not write tags or an image-model prompt.',
      }),
    },
    { additionalProperties: false },
  );
  pi.registerTool<typeof ImageParams, GenerateDetails>({
    name: 'roleplay_image',
    label: 'Illustrate scene',
    description:
      'Illustrate a roleplay moment from a short scene description. Character visual identities and workflow-specific prompt writing are supplied automatically. Only describe what should be visible; do not choose a workflow, write tags, or add a negative prompt.',
    promptSnippet:
      'Use roleplay_image to illustrate a scene with one ordinary-language description; the tool writes the image-model prompt.',
    promptGuidelines: [
      'Describe subjects, actions and mood in ordinary language. Illustration or anime style does not imply Danbooru tags. Never call ComfyUI HTTP endpoints directly.',
    ],
    parameters: ImageParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      resyncIfChanged(ctx);
      const cfg = loadRoleplayConfig(ctx.cwd);
      const error = (message: string): GenerateToolResult => ({
        content: [{ type: 'text' as const, text: message }],
        details: { workflow: cfg.imageWorkflow ?? '(default)', savedPaths: [] as string[], error: message },
        isError: true,
      });
      if (activeCast() === null || (getRoleplayImageModeOverride() ?? cfg.imageMode) !== 'simple') {
        return error('roleplay_image requires an active roleplay persona and simple image mode');
      }
      const generate = getComfyuiGenerator();
      if (!generate) return error('ComfyUI is unavailable; enable the comfyui extension and configure a workflow');
      const persona = getActivePersona();
      const identities = [...(persona?.visualIdentities ?? [])].map((identity) => {
        const character = substituteMacros(identity.character, macroCtx());
        return Object.assign({}, identity, { character, body: substituteMacros(identity.body, macroCtx(character)) });
      });
      const warnings: string[] = [];
      for (const entry of state.entries.filter((record) => record.kind === 'character')) {
        const extracted = extractVisualIdentities(
          substituteMacros(readEntryBody(state.cast, entry) ?? '', macroCtx(entry.name)),
          `character ${entry.name}`,
          1,
        );
        identities.push(...extracted.identities);
        warnings.push(...extracted.warnings);
      }
      for (const chunk of [...keywordVisualLore, ...depthVisualLore]) {
        const extracted = extractVisualIdentities(chunk.body, `active lore ${chunk.entry.name}`, 2);
        identities.push(...extracted.identities);
        warnings.push(...extracted.warnings);
      }
      const visual = buildVisualContext({
        request: params.prompt,
        recentScene: extractSceneContext(lastMessages as readonly SceneMessage[], 2000),
        identities,
        characters: state.entries
          .filter((entry) => entry.kind === 'character')
          .map((entry) => ({
            name: entry.name,
            aliases: [entry.id, ...(entry.character?.aliases ?? [])],
          })),
        fallbackCharacters: [...(persona?.characters ?? []), ...(persona?.pov ? [persona.pov] : [])],
      });
      for (const warning of [...warnings, ...visual.warnings]) {
        if (!surfacedWarnings.has(warning)) {
          surfacedWarnings.add(warning);
          ctx.ui.notify(`roleplay images: ${warning}`, 'warning');
        }
      }
      return await generate({
        toolCallId,
        signal,
        onUpdate,
        ctx,
        requireEnhance: true,
        isolatedContext: true,
        params: {
          prompt: params.prompt,
          context: visual.context,
          ...(cfg.imageWorkflow ? { workflow: cfg.imageWorkflow } : {}),
          enhance: true,
          background: false,
          ephemeral: true,
          autoRefine: false,
        },
      });
    },
    renderCall: (args, theme) => renderGenerateCall(args, theme),
    renderResult: (result, options, theme, context) => renderGenerateResult(result, options, theme, context),
  });

  // ── /roleplay command ───────────────────────────────────────────────
  // Human-readable readout of the last context-window pass for `/roleplay
  // context`. Reads the per-turn snapshot captured by the context hook.
  const formatContextWindow = (windowTokens: number | undefined): string => {
    const cfg = loadRoleplayConfig(cwd, envCharBudget);
    return formatContextWindowReadout({
      recapMode,
      snapshot: lastWindowSnapshot,
      stride: strideValue(),
      maxAdvance: cfg.recapMaxAdvance > 0 ? cfg.recapMaxAdvance : cfg.recapChunk,
      windowTokens,
    });
  };

  pi.registerCommand('roleplay', {
    description: 'Inspect or switch the active roleplay cast',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(
        prefix,
        roleplaySubverbs(listCasts, () => state.entries.filter((e) => e.kind === 'character').map((e) => e.id)),
      ),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(ROLEPLAY_USAGE, 'info');
        return;
      }
      const raw = (args ?? '').trim();
      const [sub, ...rest] = raw.split(/\s+/);
      const verb = (sub ?? '').toLowerCase();
      // Verbatim remainder after the verb (inner whitespace preserved).
      const remainder = raw.slice((sub ?? '').length).trim();

      const dormant = activeCast() === null;
      const dormantNote =
        'Roleplay is dormant: no active persona declares `roleplay: true`. Run /persona <a roleplay persona> first.';

      if (verb === '' || verb === 'list') {
        resyncIfChanged(ctx);
        ctx.ui.notify(dormant ? dormantNote : formatText(state), 'info');
        return;
      }
      if (verb === 'context' || verb === 'ctx' || verb === 'window') {
        const win = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
        ctx.ui.notify(formatContextWindow(win), 'info');
        return;
      }
      if (verb === 'lore') {
        if (dormant) {
          ctx.ui.notify(dormantNote, 'info');
          return;
        }
        resyncIfChanged(ctx);
        const names = new Map(state.entries.filter((e) => e.kind === 'lore').map((e) => [e.id, e.name]));
        ctx.ui.notify(
          formatLoreReadout({
            lorebookEnabled,
            snapshot: lastLoreSelection,
            turn: timing.turnCount,
            timingState: timing.timingState,
            nameOf: (id) => names.get(id),
            bundles: loreBundles,
          }),
          'info',
        );
        return;
      }
      if (verb === 'recap') {
        if (dormant) {
          ctx.ui.notify(dormantNote, 'info');
          return;
        }
        resyncIfChanged(ctx);
        const mode = (rest[0] ?? 'show').toLowerCase();
        if (mode !== 'show' && mode !== 'force') {
          ctx.ui.notify('Usage: /roleplay recap [show|force]', 'warning');
          return;
        }
        const unavailable = recapUnavailableReason({
          summarizeEnabled,
          contextWindowEnabled,
          summarizerReady: recapMode && (getSummarizer(ctx)?.isEnabled() ?? false),
        });
        if (mode === 'force') {
          if (unavailable) {
            ctx.ui.notify(`Cannot force a recap: recap mode is off (${unavailable}).`, 'warning');
            return;
          }
          armForcedRecap(win);
          ctx.ui.notify(
            `Forced recap armed: the next context pass rolls the recap regardless of the stride${win.recapInFlight ? ' (an async roll is in flight; the force waits for it to land)' : ''}.`,
            'info',
          );
          return;
        }
        let model: string | undefined;
        try {
          const m = resolveRecapModelInfo(ctx).model;
          if (m?.id) model = m.provider ? `${m.provider}/${m.id}` : m.id;
        } catch {
          model = undefined;
        }
        const timelineOn = timelineEnabled();
        ctx.ui.notify(
          formatRecapReadout({
            unavailable,
            recapText: win.recapText,
            recapCutoff: win.recapCutoff,
            committedCutoff: win.committedCutoff,
            natural: lastWindowSnapshot?.natural,
            inFlight: win.recapInFlight,
            forceArmed: win.forceRecap,
            model,
            timelineEnabled: timelineOn,
            timelineBlock:
              timelineOn && win.timelineText.trim()
                ? renderTimelineBlock(win.timelineText, {
                    maxChars: loadRoleplayConfig(cwd, envCharBudget).timelineMaxInjectChars,
                  })
                : null,
          }),
          'info',
        );
        return;
      }
      if (verb === 'relationships' || verb === 'rel') {
        if (dormant) {
          ctx.ui.notify(dormantNote, 'info');
          return;
        }
        resyncIfChanged(ctx);
        const cfg = loadRoleplayConfig(cwd, envCharBudget);
        const rows = state.entries.flatMap((e) =>
          e.kind === 'relationship' && e.relationship ? [{ id: e.id, name: e.name, meta: e.relationship }] : [],
        );
        ctx.ui.notify(
          formatRelationshipsReadout(rows, new Date(), {
            decayPerDay: cfg.relationshipDecayPerDay,
            baseline: cfg.relationshipBaseline,
          }),
          'info',
        );
        return;
      }
      if (verb === 'export') {
        if (dormant) {
          ctx.ui.notify(dormantNote, 'warning');
          return;
        }
        resyncIfChanged(ctx);
        const result = exportCardFile(remainder, ctx.cwd);
        ctx.ui.notify(result.ok ? result.summary : `roleplay export: ${result.error}`, result.ok ? 'info' : 'error');
        return;
      }
      if (verb === 'images') {
        const mode = rest.join(' ').trim();
        if (mode.length === 0) {
          const cfg = loadRoleplayConfig(ctx.cwd);
          ctx.ui.notify(
            `Image mode: ${getRoleplayImageModeOverride() ?? cfg.imageMode}\nSimple workflow: ${cfg.imageWorkflow ?? '(ComfyUI default)'}\nUsage: /roleplay images simple|full|off`,
            'info',
          );
          return;
        }
        if (!isRoleplayImageMode(mode)) {
          ctx.ui.notify('Usage: /roleplay images simple|full|off', 'warning');
          return;
        }
        setRoleplayImageModeOverride(mode);
        pi.appendEntry(ROLEPLAY_IMAGE_MODE_ENTRY, mode);
        gateRoleplayTool();
        ctx.ui.notify(
          `Roleplay image mode: ${mode}${dormant ? ' (takes effect under a roleplay persona)' : ''}`,
          'info',
        );
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
        const target = remainder;
        if (target.length === 0) {
          ctx.ui.notify('Usage: /roleplay import <path.json|.png>', 'info');
          return;
        }
        resyncIfChanged(ctx);
        const result = importCardFile(target, ctx.cwd);
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
          const task = buildEventTask(
            {
              recentScene: concatRecentMessageText(lastMessages, cfg.scanDepth),
              sheets: characterSummaries(),
              openThreads: openThreadsForCast(),
              ...(hint ? { hint } : {}),
              seedThreads: cfg.eventSeedThreads,
            },
            resolvePromptGuidance('event', { cwd }),
          );
          queued = await gen.generate({ cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never }, task);
        }
        if (queued === null) {
          const deckPick = pickDeckEvent(cfg.events, Math.random, cfg.eventMaxChars);
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
        pendingEventGeneration += 1;
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
        // Stamp a marker on the SESSION BRANCH so branch hydration cold-starts
        // the next turn. The within-session store is the branch, and we cannot
        // delete the pre-newscene recap/timeline entries from it; without this
        // marker, continuing in the same session (or reloading it) would
        // re-hydrate and resurrect the scene we just archived. Both
        // `hydrateRecapFromBranch` and `hydrateTimelineFromBranch` scan
        // newest-first and treat this marker as "no memory beyond here", so it
        // shadows every older entry until the new scene rolls its own recap.
        try {
          pi.appendEntry('roleplay-newscene', { ts });
        } catch {
          /* marker is best-effort; resetWindowState below still clears memory */
        }
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
        if (dormant) {
          ctx.ui.notify(dormantNote, 'info');
        } else {
          // Regenerate INDEX.md from the COMPLETE on-disk inventory (base +
          // every lore bundle, not just the active selection). This is the
          // on-demand rebuild path for bundles authored by direct file edits
          // rather than through the `roleplay` tool.
          writeIndex(state);
          ctx.ui.notify(`Rescanned cast "${state.cast}" and rebuilt INDEX.md.\n\n${formatText(state)}`, 'info');
        }
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
