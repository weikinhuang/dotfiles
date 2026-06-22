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
import { adaptCreateAgentSession, runOneShotAgent } from '../../../lib/node/pi/subagent/spawn.ts';
import {
  atomicWriteFile,
  castDir,
  fileFor,
  listCasts,
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

  if (depthInjectEnabled || repetitionEnabled || eventsEnabled) {
    pi.on('context', (event) => {
      if (activeCast() === null) return undefined;
      // Capture the live scene so the `/roleplay event` command (which runs
      // between turns, without message access) can read recent context.
      lastMessages = event.messages;

      let messages = event.messages;
      let changed = false;

      // Depth injection (author's note + depth-tagged lore) splices content
      // at depth; reminders below append ephemerally to the trailing message.
      if (depthInjectEnabled) {
        const persona = getActivePersona();
        const scanDepth = loadRoleplayConfig(cwd, envCharBudget).scanDepth;
        const insertions = buildInsertions({
          authorNote: persona?.authorNote ? substituteMacros(persona.authorNote, macroCtx()) : undefined,
          authorNoteDepth: persona?.authorNoteDepth,
          lore: buildDepthLore(recentText(event.messages, scanDepth)),
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
      if (repetitionEnabled) reminders.push({ id: 'roleplay-repetition', body: buildRepetitionNudge(messages) });
      if (eventsEnabled) {
        reminders.push({ id: 'roleplay-event', body: pendingEvent ? formatEventDirector(pendingEvent) : null });
        if (pendingEvent) eventConsumed = true;
      }
      if (reminders.length > 0) {
        let rm = messages as unknown as ReminderMessage[];
        for (const spec of reminders) rm = applyContextReminder(rm, spec);
        if (reminders.some((r) => r.body)) {
          messages = rm as unknown as typeof event.messages;
          changed = true;
        }
      }

      return changed ? { messages } : undefined;
    });
  }

  // ── Auto-summarization (Phase 7B) ───────────────────────────────────
  //
  // On `session_before_compact` pi hands us the span it is about to
  // evict (`preparation.messagesToSummarize`). We fold it into a rolling
  // `summary/auto` record so scene continuity survives compaction. This
  // is a strict SIDE-write: we never return `{compaction}` / `{cancel}`,
  // so any failure here leaves pi's own compaction untouched. The whole
  // path is gated by `roleplay: true` + `PI_ROLEPLAY_DISABLE_SUMMARIZE`
  // and degrades to a no-op when the model / agent / settings are
  // unavailable (the adapter returns `null`).
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
          const result = await runOneShotAgent({
            deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
            cwd: args.cwd,
            agent: args.agent,
            model: args.model,
            task: args.task,
            modelRegistry: args.modelRegistry,
            agentDir: getAgentDir(),
            sessionManager: summarizerSessionManager(ctx, args.cwd),
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

  if (summarizeEnabled) {
    pi.on('session_before_compact', async (event, ctx) => {
      try {
        if (activeCast() === null) return undefined;
        resyncIfChanged(ctx);
        if (state.cast.length === 0) return undefined;
        const cfg = loadRoleplayConfig(cwd, envCharBudget);
        const messages = (event.preparation?.messagesToSummarize ?? []).map(toSummarizable);
        const plan = planSummarization(messages, { minMessages: cfg.summarizeMinMessages });
        if (!plan) return undefined;
        const sum = getSummarizer(ctx);
        if (!sum?.isEnabled()) return undefined;
        const priorEntry = state.entries.find((e) => e.kind === 'summary' && e.id === 'auto');
        const prior = priorEntry ? (readEntryBody(state.cast, priorEntry) ?? undefined) : undefined;
        const recap = await sum.summarize(
          { cwd, model: ctx.model, modelRegistry: ctx.modelRegistry as never, signal: event.signal },
          plan.spanText,
          prior,
        );
        if (recap === null) return undefined;
        const rec = composeAutoSummaryRecord(recap);
        atomicWriteFile(
          fileFor(state.cast, 'summary', rec.id),
          serializeEntry({ name: rec.name, description: rec.description, kind: 'summary', body: rec.body }),
        );
        // Re-scan so the index + in-memory state reflect the new record.
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
