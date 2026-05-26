/**
 * Waveform working indicator.
 *
 * Replaces pi's default braille spinner with a music-style scrolling
 * waveform rendered in 1-dot-thick braille bars (two waveform samples
 * per glyph) and a rainbow shimmer that drifts across the wave. The
 * `Working...` label is replaced with `Thinking...` and shimmers in the
 * same hue band, on its own ticker since pi doesn't expose the indicator's
 * frame index for syncing.
 *
 * The shimmering label is followed by a dim claude-code-style suffix in
 * parens: `Thinking... (5s · ↑ 185 tokens · thinking with medium effort)`.
 * Elapsed time covers the whole agent loop; ↑/↓ token counts reset on
 * each `turn_start` so they reflect the current turn only (claude-code
 * semantics). The thinking segment reflects the current turn's reasoning
 * blocks (live "thinking with <level> effort" → "still thinking" after
 * 20 s in-block → "thought for Ns" once the block ends). The state
 * machine + format helpers live in
 * `lib/node/pi/waveform-indicator/suffix.ts`.
 *
 * Pi UI surface used:
 *   ctx.ui.setWorkingIndicator({ frames, intervalMs })
 *     - pi auto-cycles the pre-rendered frame array while streaming.
 *   ctx.ui.setWorkingMessage(text)
 *     - replaces the leading "Working" label verbatim. We re-call this
 *       on a 80 ms ticker bound to agent_start / agent_end so the label
 *       shimmers in sync with the indicator beat.
 *   pi.on('message_update' | 'message_end' | 'turn_start' | ...)
 *     - drives the suffix state machine: usage / phase / thinking blocks.
 *   pi.getThinkingLevel()
 *     - read each tick so the suffix reflects the level the user has
 *       currently selected (no caching of `thinking_level_select`).
 *
 * Knobs:
 *   /waveform                 show current style
 *   /waveform scroll          right-to-left scrolling waveform (default)
 *   /waveform spectrum        independent bouncing bars, EQ-style heat-map color
 *   /waveform tokenrate       live tokens-per-second bars, full-spectrum
 *                             magnitude heat-map (blue → cyan → green → yellow
 *                             → red). Re-rendered per label tick instead of
 *                             from a pre-rendered loop.
 *   /waveform off             hide the indicator entirely (keep label)
 *   /waveform reset           restore pi's default spinner + "Working..." label
 *
 * The chosen style persists to `<cwd>/.pi/waveform-indicator.json`
 * (project-local override) or `<piAgentDir>/waveform-indicator.json` (user-
 * global) so it sticks across pi sessions. `/waveform reset` clears the
 * file. The `PI_WAVEFORM_INDICATOR_MODE` env var overrides the file when
 * set, for one-shot per-shell overrides.
 *
 * Future hook: `renderLabel(tick, suffix)` builds the head from
 * `shimmerLabel`; swap that function for one that calls a tiny model
 * (or any other generator) and the shimmer + dim suffix keep working.
 *
 * Environment:
 *   PI_WAVEFORM_INDICATOR_DISABLED=1   leave pi's default indicator alone
 *   PI_WAVEFORM_INDICATOR_MODE=<mode>  override the persisted mode for
 *                                     this session (scroll|spectrum|tokenrate|off|default)
 *   PI_WAVEFORM_THINKING_PULSE=off     suppress the breathing pulse on the
 *                                     thinking-effort segment of the suffix
 *                                     (the rest of the suffix still dims as
 *                                     before). Any other value keeps the
 *                                     pulse on; the default is on.
 *   PI_WAVEFORM_THINKING_PULSE_HZ=<f>  cosine frequency in Hz. Default 0.5
 *                                     (≈ 2 s period). `<= 0` and non-finite
 *                                     values short-circuit to a static dim
 *                                     render (no pulse) - same effect as
 *                                     `PI_WAVEFORM_THINKING_PULSE=off`.
 */

import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
  type ResourceLoader,
  SessionManager,
  getAgentDir,
  parseFrontmatter,
  type WorkingIndicatorOptions,
} from '@earendil-works/pi-coding-agent';

import {
  type AgentDef,
  type AgentLoadResult,
  defaultAgentLayers,
  loadAgents,
  makeNodeReadLayer,
} from '../../../lib/node/pi/subagent/loader.ts';
import { createPersistedSubagentSessionManager } from '../../../lib/node/pi/subagent/session-dir.ts';
import { type CreateAgentSessionDep, resolveChildModel, runOneShotAgent } from '../../../lib/node/pi/subagent/spawn.ts';
import { piAgentDir } from '../../../lib/node/pi/pi-paths.ts';
import { buildIndicatorFrames } from '../../../lib/node/pi/waveform-indicator/wave.ts';
import { shimmerLabel } from '../../../lib/node/pi/waveform-indicator/shimmer.ts';
import { buildSpectrumFrames } from '../../../lib/node/pi/waveform-indicator/spectrum.ts';
import {
  TOKEN_RATE_BUFFER_SIZE,
  buildTokenRateFrame,
  pushTokenRateSample,
  tokenRateBarsToHeights,
} from '../../../lib/node/pi/waveform-indicator/token-rate.ts';
import {
  FALLBACK_PHRASE,
  type WaveformPhraseState,
  abortInFlight,
  acceptPhrase,
  buildPhrasePrompt,
  digestPrompt,
  digestToolCall,
  issueRequest,
  markFiredThisTurn,
  newWaveformPhraseState,
  resetTurn,
  validatePhrase,
} from '../../../lib/node/pi/waveform-indicator/phrase.ts';
import {
  type PersonaFsAdapter,
  type PersonaLayerPaths,
  loadPersonaBody,
  resolvePersonaPath,
} from '../../../lib/node/pi/waveform-indicator/persona.ts';
import {
  type TokenRateState,
  markMessageEnd as markRateMessageEnd,
  markMessageStart as markRateMessageStart,
  newTokenRateState,
  stepTokenRate,
} from '../../../lib/node/pi/waveform-indicator/rate.ts';
import {
  type DynamicLabelConfig,
  type WaveformMode,
  clearWaveformState,
  resolveDynamicLabelConfig,
  resolveInitialWaveformMode,
  resolveWaveformStatePath,
  writeWaveformState,
} from '../../../lib/node/pi/waveform-indicator/state.ts';
import {
  type LabelSuffixState,
  dimText,
  formatSuffix,
  newLabelSuffixState,
  resetTurnState,
} from '../../../lib/node/pi/waveform-indicator/suffix.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { readTextOrNull } from '../../../lib/node/pi/fs-safe.ts';

/**
 * Pi's `createAgentSession` types `modelRegistry` as the concrete
 * `ModelRegistry` class, while `lib/node/pi/subagent/spawn.ts` uses a
 * structural `ModelRegistryLike` so the helper can stay testable
 * without pi imports. Wrap pi's constructor so the types line up.
 */
const piCreateAgentSession: CreateAgentSessionDep<Model<any>, SessionManager> = (args) =>
  createAgentSession({
    ...args,
    modelRegistry: args.modelRegistry as ModelRegistry,
    resourceLoader: args.resourceLoader as ResourceLoader,
  });

type Mode = WaveformMode;

// Initial state-path snapshot. Pre-`session_start` we resolve against
// `process.cwd()`; once pi hands us a `ctx.cwd` we re-resolve through
// `resolveWaveformStatePath` and pick up a project-local file if the
// session was started inside a repo that ships one.
const INITIAL_STATE_PATH = resolveWaveformStatePath({ cwd: process.cwd() });

/**
 * Read `PI_WAVEFORM_THINKING_PULSE` + `PI_WAVEFORM_THINKING_PULSE_HZ`
 * and resolve them into the `{enabled, hz}` shape `formatSuffix`
 * consumes. `PI_WAVEFORM_THINKING_PULSE=off` is the only opt-out; any
 * other value (including unset) leaves the pulse on. A non-finite or
 * `<= 0` Hz value flips `enabled` to false here so we never call
 * `formatSuffix` with `tick` set in a way that would land on the
 * static-peak `cos(0) = 1` frame.
 */
function resolveThinkingPulseConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  hz: number | undefined;
} {
  const rawDisable = env.PI_WAVEFORM_THINKING_PULSE;
  if (typeof rawDisable === 'string' && rawDisable.toLowerCase() === 'off') {
    return { enabled: false, hz: undefined };
  }
  const rawHz = env.PI_WAVEFORM_THINKING_PULSE_HZ;
  if (rawHz === undefined || rawHz === '') {
    return { enabled: true, hz: undefined };
  }
  const parsed = Number(rawHz);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { enabled: false, hz: undefined };
  }
  return { enabled: true, hz: parsed };
}

const FRAME_INTERVAL_MS = 50;
// Per-mode frame intervals. The label ticker stays at FRAME_INTERVAL_MS
// because shimmer drift speed is independent of the indicator rate.
const SCROLL_FRAME_INTERVAL_MS = 80;
const SPECTRUM_FRAME_INTERVAL_MS = 50;
// Tokenrate re-renders the indicator on every label tick, so the
// per-frame interval just tells pi how fast to interpolate within a push
// (kept symmetric with the label tick so the chart updates as fast as it
// is sampled).
const TOKEN_RATE_FRAME_INTERVAL_MS = 50;
const DEFAULT_LABEL = 'Thinking...';
const HIDDEN_INDICATOR: WorkingIndicatorOptions = { frames: [] };

/**
 * Produce the label string for tick `tick`. The base label is a
 * rainbow-shimmered head (default `Thinking...`, or a tiny-model phrase
 * once one has been accepted); when an agent loop is active and a
 * suffix state is being tracked, append a dim claude-code-style suffix
 * like ` (5s · ↑ 185 tokens · thinking with medium effort)`.
 *
 * `headText` defaults to the static `Thinking...` fallback. The
 * extension swaps in the accepted-phrase from `WaveformPhraseState`
 * once a tiny-model spawn lands a valid phrase; until then we render
 * the fallback so something always paints.
 *
 * Note: `suffix` is pre-styled (see `computeSuffix`). When the pulse is
 * on, the thinking-effort segment carries its own SGR wrap and the rest
 * gets the static dim baseline; when off, the whole suffix is wrapped in
 * `dimText`. Either way it lands here ready to print, so this function
 * just joins head + suffix without further styling.
 */
function renderLabel(tick: number, suffix: string | undefined, headText: string = DEFAULT_LABEL): string {
  const head = shimmerLabel(headText, tick);
  if (suffix === undefined) return head;
  return `${head} ${suffix}`;
}

function indicatorFor(mode: Mode): WorkingIndicatorOptions | undefined {
  switch (mode) {
    case 'scroll':
      return {
        frames: buildIndicatorFrames(),
        intervalMs: SCROLL_FRAME_INTERVAL_MS,
      };
    case 'spectrum':
      return {
        frames: buildSpectrumFrames(),
        intervalMs: SPECTRUM_FRAME_INTERVAL_MS,
      };
    case 'tokenrate':
      // Built per-tick from live token-rate samples, not from a static
      // frame array. The label ticker re-applies a fresh single-frame
      // indicator on every pulse; `undefined` here means "don't touch the
      // indicator from session_start / agent_start" so the per-tick path
      // owns the rendering.
      return undefined;
    case 'off':
      return HIDDEN_INDICATOR;
    case 'default':
      return undefined;
  }
}

function describeMode(mode: Mode): string {
  switch (mode) {
    case 'scroll':
      return 'scrolling waveform';
    case 'spectrum':
      return 'spectrum bars';
    case 'tokenrate':
      return 'token-rate waveform';
    case 'off':
      return 'hidden';
    case 'default':
      return 'pi default spinner';
  }
}

export default function extension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_WAVEFORM_INDICATOR_DISABLED)) return;

  let mode: Mode = resolveInitialWaveformMode(INITIAL_STATE_PATH);
  // Re-resolved on session_start once ctx.cwd is available so a
  // project-local `<cwd>/.pi/waveform-indicator.json` overrides the
  // user-global file.
  let statePath: string = INITIAL_STATE_PATH;
  const pulseConfig = resolveThinkingPulseConfig();
  let labelTimer: ReturnType<typeof setInterval> | null = null;
  let tick = 0;
  // Tracks per-loop counters that drive the dim suffix. `null` outside
  // an active agent loop so the label renders without parens between
  // turns / before any agent_start.
  let suffixState: LabelSuffixState | null = null;
  // Cached so the per-tick suffix builder can read live context size
  // without a fresh event payload. Many providers leave
  // `partial.usage.input` at zero until message_end; getContextUsage()
  // is the synchronous source of truth pi already exposes.
  let lastCtx: ExtensionContext | null = null;
  // Context-token count snapshot used as the baseline for the ↑
  // segment's per-turn delta. Initialised at `session_start` (= system
  // prompt + tools, before any user input) so turn 1's ↑ shows just
  // the user-prompt size; refreshed at every assistant `message_end`
  // so subsequent turns show only the new content (tool result / next
  // user message) appended since the previous LLM call. Persists across
  // agent loops within the same session so a second `agent_start`
  // (e.g. user asks a follow-up question) doesn't regress to the
  // cumulative full-context display.
  let prevContextTokensSnapshot: number | undefined = undefined;
  // Token-rate (tokens/sec) state for the `tokenrate` mode. The buffer
  // is a 20-slot circular FIFO (10 glyphs × 2 columns); the state
  // machine carries the previous sample's timestamp + cumulative
  // estimate so the per-tick rate is `Δ tokens / Δ seconds`. Allocated
  // on `agent_start`, torn down on `agent_end` along with the suffix
  // state, kept `null` outside an active agent loop so the indicator
  // renders nothing between turns.
  let rateState: TokenRateState | null = null;
  let rateBuffer: number[] | null = null;

  // ──────────────────────────────────────────────────────────────────
  // Dynamic-label (persona-driven `Thinking...` head) state
  // ──────────────────────────────────────────────────────────────────

  // Resolved dynamic-label config. Re-resolved on session_start so a
  // mid-pi `vi <piAgentDir>/waveform-indicator.json` edit followed by /reload
  // picks up the new value. Default config is `enabled: false` so the
  // feature stays off until the user opts in.
  let dynamicLabelConfig: DynamicLabelConfig = {
    enabled: false,
    tinyModel: null,
    persona: 'daemon-waveform',
    maxCallsPerSession: 20,
  };
  // Loaded agent registry. The waveform-phraser agent definition is
  // looked up by name; if it's missing we silently fall back to the
  // static head (the agent is shipped with the dotfiles repo so a
  // missing definition usually means the agents/ dir wasn't installed).
  let phraserAgent: AgentDef | null = null;
  // Pre-resolved persona overlay text - appended to a cloned AgentDef
  // at spawn time. `null` means "no overlay" (neutral system prompt
  // only); the `persona: ""` config opt-out also lands here as null.
  let personaOverlay: string | null = null;
  // Coalescing reducer state - request id, in-flight controller, per-
  // turn dedup set, session call counter. Allocated lazily on the
  // first trigger that fires (turn_start) so we don't pay for state
  // when the feature is disabled.
  let phraseState: WaveformPhraseState | null = null;
  // One-shot notification tracker so we don't spam the same warning
  // on every retry / reload.
  const notifiedDynamicLabelWarnings = new Set<string>();

  const extDir = dirname(fileURLToPath(import.meta.url));
  const userPiDir = piAgentDir();

  // Optional debug logger for the dynamic-label spawn pipeline. Enabled
  // by `PI_WAVEFORM_DYNAMIC_LABEL_DEBUG=1`; writes JSONL lines to
  // `<piAgentDir>/waveform-indicator.debug.log` so the user can audit
  // which guard (stopReason, validator, abort, exception) is dropping a
  // spawn result. No-op when the env var is unset so production runs
  // pay zero overhead.
  const debugEnabled = envTruthy(process.env.PI_WAVEFORM_DYNAMIC_LABEL_DEBUG);
  const debugLogPath = join(userPiDir, 'waveform-indicator.debug.log');
  function debugLog(event: string, fields: Record<string, unknown>): void {
    if (!debugEnabled) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n';
      appendFileSync(debugLogPath, line, 'utf8');
    } catch {
      /* logging failures must never break the indicator */
    }
  }

  const personaFsAdapter: PersonaFsAdapter = {
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    readFile: readTextOrNull,
  };

  const agentReadLayer = makeNodeReadLayer();

  /**
   * Surface a dynamic-label diagnostic via `ctx.ui.notify`, but only
   * once per (key) per session - so a registry-miss at every turn
   * doesn't paint a stream of duplicate warnings on screen.
   */
  function notifyOnce(ctx: ExtensionContext, key: string, body: string): void {
    if (notifiedDynamicLabelWarnings.has(key)) return;
    notifiedDynamicLabelWarnings.add(key);
    try {
      ctx.ui.notify(`waveform-indicator: ${body}`, 'warning');
    } catch {
      /* notify failures never break the indicator */
    }
  }

  /**
   * Resolve the persona body for `name`. Empty string opts out
   * (returns `null` without a warning). Unknown / malformed personas
   * fall back to the shipped `daemon-waveform` body when available; a
   * one-shot notify fires for the first failure. Returns the trimmed
   * body, or `null` when no overlay should be appended.
   */
  function resolvePersonaOverlay(ctx: ExtensionContext, name: string): string | null {
    if (name === '') return null;
    const layers: PersonaLayerPaths = {
      projectDir: join(ctx.cwd, '.pi', 'personas'),
      userDir: join(userPiDir, 'personas'),
      shippedDir: join(extDir, '..', 'personas'),
    };
    const path = resolvePersonaPath(name, layers, personaFsAdapter);
    if (path === null) {
      notifyOnce(
        ctx,
        `persona-missing:${name}`,
        `persona "${name}" not found in any layer; falling back to neutral prompt`,
      );
      // Try `daemon-waveform` as a last-resort fallback when the user
      // picked a non-existent name (so the default-persona path can
      // never miss).
      if (name !== 'daemon-waveform') {
        const daemonPath = resolvePersonaPath('daemon-waveform', layers, personaFsAdapter);
        if (daemonPath !== null) {
          const fallback = loadPersonaBody(daemonPath, parseFrontmatter, personaFsAdapter);
          return fallback.body;
        }
      }
      return null;
    }
    const result = loadPersonaBody(path, parseFrontmatter, personaFsAdapter);
    if (result.body === null && result.warnings.length > 0) {
      for (const w of result.warnings) {
        notifyOnce(ctx, `persona:${w.path}:${w.reason}`, `persona "${name}": ${w.reason}`);
      }
    }
    return result.body;
  }

  /**
   * Re-resolve `dynamicLabelConfig`, reload the persona overlay, and
   * (re-)load the waveform-phraser agent definition. Called on
   * `session_start` so `/reload` picks up edits without restarting pi.
   */
  function reloadDynamicLabel(ctx: ExtensionContext): void {
    const resolution = resolveDynamicLabelConfig(statePath);
    dynamicLabelConfig = resolution.config;
    for (const w of resolution.warnings) {
      notifyOnce(ctx, `state:${w}`, w);
    }

    // Always load the agent definition even when disabled - cheap, and
    // the user may flip enabled=on mid-session via env or by editing
    // the file + /reload.
    try {
      const layers = defaultAgentLayers({ extensionDir: extDir, cwd: ctx.cwd });
      const knownToolNames = new Set(pi.getAllTools().map((t) => t.name));
      const loaded: AgentLoadResult = loadAgents({
        layers,
        knownToolNames,
        fs: agentReadLayer,
        parseFrontmatter,
      });
      phraserAgent = loaded.agents.get('waveform-phraser') ?? null;
    } catch {
      phraserAgent = null;
    }

    personaOverlay = resolvePersonaOverlay(ctx, dynamicLabelConfig.persona);
  }

  /**
   * Clone `phraserAgent` with the persona body appended to its
   * `appendSystemPrompt`. The clone is per-spawn so swapping personas
   * mid-session is just a re-resolve at session_start - the cloned
   * defs never accumulate.
   */
  function buildSpawnAgent(): AgentDef | null {
    if (!phraserAgent) return null;
    if (!personaOverlay) return phraserAgent;
    const existing = phraserAgent.appendSystemPrompt?.trim() ?? '';
    const composed = existing.length > 0 ? `${existing}\n\n${personaOverlay}` : personaOverlay;
    return { ...phraserAgent, appendSystemPrompt: composed };
  }

  /**
   * Headline for the current frame: the accepted phrase when one has
   * landed, otherwise the static fallback. The reducer never clears
   * `acceptedPhrase` once set, so this just returns whatever's in
   * state.
   */
  function currentHead(): string {
    return phraseState?.acceptedPhrase ?? FALLBACK_PHRASE;
  }

  /**
   * Walk the session entries backward and return the most recent
   * `role: 'user'` message text, collapsed to a single string. Used
   * to seed the cached `promptDigest` on `turn_start`.
   */
  function findLatestUserMessageText(ctx: ExtensionContext): string {
    let entries: readonly { type?: string; message?: unknown }[] = [];
    try {
      entries = ctx.sessionManager.getEntries() as readonly { type?: string; message?: unknown }[];
    } catch {
      return '';
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== 'message') continue;
      const msg = e.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role !== 'user') continue;
      const content = msg.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
          if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
            const text = (part as { text?: unknown }).text;
            if (typeof text === 'string') parts.push(text);
          }
        }
        return parts.join(' ');
      }
    }
    return '';
  }

  /**
   * Fire a tiny-model phrase spawn for `phaseTag`. Returns immediately
   * after issuing the request; the spawn promise runs in the
   * background and lands its result via `acceptPhrase`. Short-circuits
   * on:
   *
   *   - dynamic-label disabled
   *   - phraser agent missing
   *   - per-turn dedup already fired for this tag
   *   - per-session budget exhausted
   *   - the model registry doesn't know about `tinyModel` (the
   *     spawn-time half of the two-stage validation - emits a
   *     one-shot warning).
   */
  function fireTriggerSpawn(ctx: ExtensionContext, phaseTag: string, contextDigest: string): void {
    if (!dynamicLabelConfig.enabled || !dynamicLabelConfig.tinyModel) {
      debugLog('skip', { reason: 'disabled-or-no-model', phaseTag });
      return;
    }
    if (!phraserAgent) {
      debugLog('skip', { reason: 'no-phraser-agent', phaseTag });
      return;
    }
    if (phraseState === null) {
      debugLog('skip', { reason: 'no-phrase-state', phaseTag });
      return;
    }

    // Per-turn dedup: at most one spawn per phaseTag per turn.
    if (markFiredThisTurn(phraseState, phaseTag)) {
      debugLog('skip', { reason: 'already-fired-this-turn', phaseTag });
      return;
    }

    // Budget: hard short-circuit. Keep last accepted phrase on screen.
    if (phraseState.callsThisSession >= dynamicLabelConfig.maxCallsPerSession) {
      notifyOnce(
        ctx,
        'budget-exhausted',
        `dynamic-label budget of ${dynamicLabelConfig.maxCallsPerSession} calls exhausted; keeping last phrase`,
      );
      debugLog('skip', { reason: 'budget-exhausted', phaseTag, calls: phraseState.callsThisSession });
      return;
    }

    // Spawn-time registry check (the second half of the two-stage
    // validation). Don't fall back to a different model.
    const slash = dynamicLabelConfig.tinyModel.indexOf('/');
    if (slash <= 0) return; // shouldn't happen - we already parsed at load
    const provider = dynamicLabelConfig.tinyModel.slice(0, slash);
    const modelId = dynamicLabelConfig.tinyModel.slice(slash + 1);
    const found = ctx.modelRegistry.find(provider, modelId);
    if (!found) {
      notifyOnce(
        ctx,
        `model-miss:${dynamicLabelConfig.tinyModel}`,
        `tinyModel ${provider}/${modelId} not registered; keeping static label`,
      );
      debugLog('skip', { reason: 'model-miss', phaseTag, model: dynamicLabelConfig.tinyModel });
      return;
    }

    const agent = buildSpawnAgent();
    if (!agent) {
      debugLog('skip', { reason: 'no-spawn-agent', phaseTag });
      return;
    }

    const { requestId, signal } = issueRequest(phraseState, ctx.signal);
    const state = phraseState;
    const task = buildPhrasePrompt(phaseTag, contextDigest);
    debugLog('spawn-fire', { requestId, phaseTag, contextDigest, model: dynamicLabelConfig.tinyModel });

    // Resolve the child model via the same helper iteration-loop uses
    // so an explicit `tinyModel` override goes through the shared
    // precedence ladder. We already passed the registry hit check
    // above, but resolveChildModel re-checks defensively.
    const resolution = resolveChildModel({
      override: dynamicLabelConfig.tinyModel,
      agent,
      parent: ctx.model,
      modelRegistry: ctx.modelRegistry,
    });
    if (!resolution.ok) {
      // Already aborted the controller via issueRequest; nothing else
      // to do here - the resolution error is more of an internal
      // diagnostic than a user-facing problem.
      return;
    }

    // Background spawn - we never await this. The label ticker keeps
    // painting whatever's in state.acceptedPhrase (or the fallback)
    // until the promise lands and `acceptPhrase` updates state.
    runOneShotAgent({
      deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
      cwd: ctx.cwd,
      agent,
      model: resolution.model,
      task,
      modelRegistry: ctx.modelRegistry,
      agentDir: getAgentDir(),
      signal,
      // Disk-backed session per `config/pi/extensions/AGENTS.md`. A
      // missing parent session dir throws - we let that propagate so
      // the user sees a clear "restart without --no-session" message
      // rather than silently dropping transcripts.
      sessionManager: createPersistedSubagentSessionManager({
        cwd: ctx.cwd,
        parentSessionManager: ctx.sessionManager,
        extensionLabel: 'waveform-indicator',
        SessionManager,
      }),
    })
      .then((result) => {
        if (signal.aborted) {
          debugLog('spawn-return', {
            requestId,
            phaseTag,
            outcome: 'signal-aborted',
            stopReason: result.stopReason,
            finalText: result.finalText,
          });
          return;
        }
        // `runOneShotAgent`'s `turn_end` handler aborts the child as soon
        // as `turns >= maxTurns`, so a one-turn natural completion (which
        // is exactly what we want from the waveform-phraser) classifies
        // as `max_turns`, not `completed`. Treat `max_turns` with a
        // non-empty `finalText` as success - the response landed before
        // the abort. `aborted` / `error` / empty-text outcomes still drop.
        const accepted = result.stopReason === 'completed' || result.stopReason === 'max_turns';
        if (!accepted || result.finalText.length === 0) {
          debugLog('spawn-return', {
            requestId,
            phaseTag,
            outcome: 'non-completed-stop',
            stopReason: result.stopReason,
            errorMessage: result.errorMessage,
            finalText: result.finalText,
          });
          return;
        }
        const firstLine = result.finalText.split(/\r?\n/, 1)[0] ?? '';
        const phrase = validatePhrase(firstLine);
        if (phrase === null) {
          debugLog('spawn-return', {
            requestId,
            phaseTag,
            outcome: 'validator-rejected',
            stopReason: result.stopReason,
            firstLine,
            finalText: result.finalText,
          });
          return;
        }
        const acceptResult = acceptPhrase(state, requestId, phrase, signal);
        debugLog('spawn-return', {
          requestId,
          phaseTag,
          outcome: `accept-${acceptResult}`,
          stopReason: result.stopReason,
          phrase,
        });
      })
      .catch((e) => {
        /* swallow - failures keep the previously-accepted phrase */
        debugLog('spawn-return', {
          requestId,
          phaseTag,
          outcome: 'thrown',
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        });
      });
  }

  /**
   * Extract the most recent ToolCall part from a streaming partial
   * AssistantMessage. The `toolcall_start` event fires before pi has
   * finished streaming the args, so the input map may still be empty
   * - we surface the tool name unconditionally and use whatever
   * partial-input string is there for the digest.
   */
  function digestLatestToolCall(partial: unknown): { name: string; digest: string } {
    if (!partial || typeof partial !== 'object') return { name: '', digest: '' };
    const content = (partial as { content?: unknown }).content;
    if (!Array.isArray(content)) return { name: '', digest: '' };
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i] as { type?: string; toolName?: unknown; input?: unknown } | undefined;
      if (part?.type !== 'toolCall') continue;
      const name = typeof part.toolName === 'string' ? part.toolName : '';
      const input = part.input;
      return { name, digest: digestToolCall(name, input) };
    }
    return { name: '', digest: '' };
  }

  function liveOutputTokens(state: LabelSuffixState): number {
    // Mirror the suffix's downlink formula so the rate samples and the
    // ↓ counter agree on the same cumulative output: committed-so-far
    // plus the live estimate (max of provider-streamed `currentUsage`
    // and the byte-accumulator / 4 estimate).
    const realOutputThisMessage = state.currentUsage?.output ?? 0;
    const estimateThisMessage = Math.ceil(state.currentMessageOutputBytes / 4);
    const liveThisMessage = Math.max(realOutputThisMessage, estimateThisMessage);
    return state.committedUsage.output + liveThisMessage;
  }

  function renderTokenRateIndicator(ctx: ExtensionContext): void {
    if (rateState === null || rateBuffer === null) return;
    if (suffixState !== null) {
      const step = stepTokenRate(rateState, liveOutputTokens(suffixState), Date.now());
      if (step.rate !== undefined) {
        pushTokenRateSample(rateBuffer, step.rate);
      }
    }
    const heights = tokenRateBarsToHeights(rateBuffer);
    const frame = buildTokenRateFrame(heights);
    // Push two copies of the same frame so pi's loader doesn't
    // short-circuit a one-element frame array as a static spinner -
    // the per-tick call here is what actually drives the live update,
    // but pi needs ≥2 frames to keep the render loop alive between
    // pushes.
    ctx.ui.setWorkingIndicator({
      frames: [frame, frame],
      intervalMs: TOKEN_RATE_FRAME_INTERVAL_MS,
    });
  }

  function computeSuffix(): string | undefined {
    if (suffixState === null) return undefined;
    // Read the level fresh each tick: the user may have changed it via
    // /thinking-level mid-turn and we want the next frame to reflect it.
    let level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' = 'off';
    try {
      level = pi.getThinkingLevel();
    } catch {
      // ExtensionAPI is meant to expose this synchronously, but keep the
      // suffix renderable even if a future pi version flakes.
    }
    let inputDeltaTokens: number | undefined;
    try {
      const cur = lastCtx?.getContextUsage()?.tokens ?? undefined;
      if (cur === undefined) {
        inputDeltaTokens = undefined;
      } else if (prevContextTokensSnapshot === undefined) {
        // Snapshot wasn't captured (e.g. session_start fired before pi
        // had populated context). Fall back to the full current context
        // size so the very first request still shows an honest count.
        inputDeltaTokens = cur;
      } else {
        // Compaction (or any other shrink) can make `cur` smaller than
        // the snapshot - clamp the delta to >=0 and let the floor logic
        // in formatTokenSegment suppress the segment when it ends up at 0.
        inputDeltaTokens = Math.max(0, cur - prevContextTokensSnapshot);
      }
    } catch {
      // Same defensive try as above.
    }
    // When the pulse is on, `formatSuffix` returns a pre-styled string
    // (two-pass dim baseline + breathing thinking-effort segment); when
    // off, it returns the plain `(…)` text and we wrap with the same
    // static dim baseline the suffix has used since day one.
    if (pulseConfig.enabled) {
      return formatSuffix(suffixState, level, Date.now(), {
        inputDeltaTokens,
        tick,
        breatheSpeed: pulseConfig.hz,
      });
    }
    return dimText(formatSuffix(suffixState, level, Date.now(), { inputDeltaTokens }));
  }

  function applyIndicator(ctx: ExtensionContext): void {
    ctx.ui.setWorkingIndicator(indicatorFor(mode));
  }

  function applyLabel(ctx: ExtensionContext): void {
    if (mode === 'default') {
      ctx.ui.setWorkingMessage(undefined);
      return;
    }
    ctx.ui.setWorkingMessage(renderLabel(tick, computeSuffix(), currentHead()));
    if (mode === 'tokenrate') {
      renderTokenRateIndicator(ctx);
    }
  }

  function stopLabelTicker(): void {
    if (labelTimer) {
      clearInterval(labelTimer);
      labelTimer = null;
    }
  }

  function startLabelTicker(ctx: ExtensionContext): void {
    // Belt-and-braces: clear any stale timer before installing a new one
    // (e.g. after /reload or a missed agent_end).
    stopLabelTicker();
    if (mode === 'default') return;
    tick = 0;
    applyLabel(ctx);
    labelTimer = setInterval(() => {
      tick++;
      applyLabel(ctx);
    }, FRAME_INTERVAL_MS);
  }

  pi.on('session_start', async (_event, ctx) => {
    lastCtx = ctx;
    // Snapshot the initial context size (system prompt + tools, before
    // any user input is in scope) so the very first turn's ↑ segment
    // renders only the new user-prompt size rather than the full
    // cumulative context. For `reason: "resume" | "reload" | "fork"`
    // this captures the resumed transcript size, which is the right
    // baseline - we want the user's *new* input on the next turn to be
    // the displayed delta, not the entire restored history.
    try {
      const cur = ctx.getContextUsage()?.tokens;
      if (typeof cur === 'number') prevContextTokensSnapshot = cur;
    } catch {
      /* ignore - keeps prevContextTokensSnapshot undefined and we fall
       * back to displaying the full context size on turn 1. */
    }
    // Re-resolve the state path against ctx.cwd so a project-local
    // `<cwd>/.pi/waveform-indicator.json` overrides the user-global
    // file. The module-load snapshot used process.cwd(), which is
    // usually right but doesn't survive a session that started in a
    // different directory. Re-read the mode too so a project file
    // saying `tokenrate` paints from the first frame even when the
    // global file said `scroll`.
    statePath = resolveWaveformStatePath({ cwd: ctx.cwd });
    mode = resolveInitialWaveformMode(statePath);
    // Re-resolve the dynamic-label config + load the persona overlay +
    // the waveform-phraser agent definition. Re-doing this on every
    // session_start (including /reload) means edits to the state file
    // or the shipped agent file land without a pi restart.
    reloadDynamicLabel(ctx);
    applyIndicator(ctx);
    // Don't start the label ticker yet - pi only renders the loader during
    // streaming. Label gets seeded on agent_start.
  });

  pi.on('agent_start', async (_event, ctx) => {
    lastCtx = ctx;
    suffixState = newLabelSuffixState(Date.now());
    // Allocate the tokenrate state regardless of the active mode so a
    // mid-turn `/waveform tokenrate` toggle doesn't have to wait for the
    // next `agent_start` to start sampling - the buffer + state machine
    // are cheap (20 numbers + a few timestamps).
    rateState = newTokenRateState();
    rateBuffer = Array.from({ length: TOKEN_RATE_BUFFER_SIZE }, () => 0);
    // Allocate the phrase reducer on first agent_start; subsequent
    // agent loops in the same session keep the accepted phrase so the
    // head doesn't briefly flash back to the static fallback.
    phraseState ??= newWaveformPhraseState();
    // Note: we deliberately do NOT reset `prevContextTokensSnapshot`
    // here - that snapshot survives across agent loops in the same
    // session so a second user prompt also shows just its own delta
    // instead of the full cumulative context.
    applyIndicator(ctx);
    startLabelTicker(ctx);
  });

  pi.on('turn_start', async (_event, ctx) => {
    lastCtx = ctx;
    // Per-turn reset preserves the loop-level token totals but clears
    // phase / currentUsage / thinking - matching the spec where
    // "thought for Ns" only reflects the current turn's blocks.
    if (suffixState !== null) resetTurnState(suffixState);

    // Capture the user prompt that started this turn so the thinking /
    // text triggers can reuse the digest without walking the session
    // tree on every fire. Pi's TurnStartEvent payload only carries
    // turnIndex + timestamp, so we walk ctx.sessionManager for the
    // most-recent user message instead.
    if (phraseState !== null) {
      resetTurn(phraseState);
      const userText = findLatestUserMessageText(ctx);
      phraseState.promptDigest = userText.length > 0 ? digestPrompt(userText) : undefined;
      const digest = phraseState.promptDigest ?? '';
      fireTriggerSpawn(ctx, 'starting work on', digest);
    }
  });

  pi.on('message_update', async (event, ctx) => {
    lastCtx = ctx;
    if (suffixState === null) return;
    const ev = event.assistantMessageEvent;
    // Pull the live usage off whichever payload this event variant carries.
    if (ev.type === 'done') {
      suffixState.currentUsage = { input: ev.message.usage.input, output: ev.message.usage.output };
    } else if (ev.type === 'error') {
      suffixState.currentUsage = { input: ev.error.usage.input, output: ev.error.usage.output };
    } else {
      suffixState.currentUsage = { input: ev.partial.usage.input, output: ev.partial.usage.output };
    }
    // Drive phase + thinking machine off the event's discriminator. Also
    // accumulate streamed delta byte counts as a live output-token
    // estimate for providers that don't emit `partial.usage.output`
    // until the final chunk - bytes / 4 ticks the ↓ counter live so the
    // user sees something happen during a slow generation.
    switch (ev.type) {
      case 'start':
        // Fresh assistant message starting; reset the per-message byte
        // accumulator so its estimate doesn't carry between messages.
        suffixState.currentMessageOutputBytes = 0;
        // Prime the tokenrate state to skip the first post-start sample
        // (it would otherwise paint a huge rightmost spike as the bytes
        // counter races up from zero against an artificially small dt).
        if (rateState !== null) {
          markRateMessageStart(rateState, Date.now(), liveOutputTokens(suffixState));
        }
        break;
      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        // Any non-thinking content event flips the phase and hides the
        // thinking segment. We set the flag on every variant (not just
        // `*_start`) because some providers skip the `_start` and emit
        // `_delta` directly.
        suffixState.phase = 'downlink';
        suffixState.thinking.hasStreamedNonThinkingContent = true;
        if (ev.type === 'text_start' && phraseState !== null) {
          // `responding about` trigger: the model has started its
          // user-facing reply. Reuses the cached promptDigest captured
          // on turn_start.
          fireTriggerSpawn(ctx, 'responding about', phraseState.promptDigest ?? '');
        } else if (ev.type === 'toolcall_start' && phraseState !== null) {
          // `using <tool>` trigger: derive the digest from the partial
          // assistant message's pending tool call. The partial carries
          // a `toolName` and partial-args string; safe to swallow if
          // the shape isn't there yet (we'll still spawn with just
          // the phaseTag).
          const partial = (ev as { partial?: { content?: unknown } }).partial;
          const toolDigest = digestLatestToolCall(partial);
          fireTriggerSpawn(ctx, `using ${toolDigest.name || 'tool'}`, toolDigest.digest);
        }
        break;
      case 'thinking_start':
        suffixState.phase = 'downlink';
        // Always overwrite: a new thinking_start means a new block, and
        // the "still thinking" 20s timer must restart at zero per spec.
        suffixState.thinking.activeStartedAtMs = Date.now();
        // Reopen the thinking segment for this new block even if a
        // previous block had already streamed non-thinking content.
        // The flag will flip back to true on the next text/toolcall
        // event, hiding the segment again.
        suffixState.thinking.hasStreamedNonThinkingContent = false;
        if (phraseState !== null) {
          // `reasoning about` trigger: another thinking block opened.
          // Reuse the cached promptDigest.
          fireTriggerSpawn(ctx, 'reasoning about', phraseState.promptDigest ?? '');
        }
        break;
      case 'thinking_delta':
        // Thinking content event - no flag flip, just byte accumulation
        // (handled below).
        break;
      case 'thinking_end':
        if (suffixState.thinking.activeStartedAtMs !== undefined) {
          suffixState.thinking.cumulativeMs += Date.now() - suffixState.thinking.activeStartedAtMs;
          suffixState.thinking.activeStartedAtMs = undefined;
        }
        suffixState.thinking.hasFinishedAny = true;
        break;
    }
    // Accumulate streamed delta byte counts as a live output-token
    // estimate for providers that don't emit `partial.usage.output`
    // until the final chunk - bytes / 4 ticks the ↓ counter live so the
    // user sees something happen during a slow generation. Counts both
    // text and thinking deltas since both consume output token budget.
    if (ev.type === 'text_delta' || ev.type === 'thinking_delta' || ev.type === 'toolcall_delta') {
      if (typeof ev.delta === 'string') {
        suffixState.currentMessageOutputBytes += Buffer.byteLength(ev.delta, 'utf8');
      }
    }
  });

  pi.on('message_end', async (event, ctx) => {
    lastCtx = ctx;
    if (suffixState === null) return;
    const message = event.message;
    // AgentMessage is a discriminated union (User | Assistant | ToolResult
    // | custom). Only assistant messages carry a `usage`; the rest commit
    // nothing. Custom agent messages without `role` likewise no-op.
    if (typeof message !== 'object' || message === null) return;
    if ((message as { role?: string }).role !== 'assistant') return;
    const usage = (message as { usage?: { input: number; output: number } }).usage;
    if (usage === undefined) return;
    suffixState.committedUsage.input += usage.input;
    suffixState.committedUsage.output += usage.output;
    suffixState.currentUsage = undefined;
    // The byte-estimate counter has now been replaced by the real
    // committed output tokens; reset so the next message starts fresh.
    suffixState.currentMessageOutputBytes = 0;
    // Clear the rate baseline so the next message starts from a fresh
    // sample rather than measuring a delta against a stale anchor. The
    // negative-delta clause inside `stepTokenRate` covers the case where
    // the byte counter resets mid-tick, but resetting here is the
    // explicit lifecycle hook the plan calls out.
    if (rateState !== null) markRateMessageEnd(rateState);
    // Snapshot the post-LLM-call context size so the next turn's ↑
    // segment renders only the *new* content (tool results / next user
    // message), not the full cumulative context. Tool results get
    // appended between message_end and turn_end, so by the next
    // message_start the delta = (current context) - (this snapshot)
    // = size of new content this turn.
    try {
      const cur = ctx.getContextUsage()?.tokens;
      if (typeof cur === 'number') prevContextTokensSnapshot = cur;
    } catch {
      /* ignore */
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    lastCtx = ctx;
    stopLabelTicker();
    suffixState = null;
    rateState = null;
    rateBuffer = null;
    // Reset point #2: abort the in-flight phrase spawn but KEEP the
    // accepted phrase so a follow-up agent loop in the same session
    // re-uses it as the seed. The per-turn dedup set is cleared on
    // the next turn_start, not here.
    if (phraseState !== null) abortInFlight(phraseState);
    // Note: we deliberately keep `prevContextTokensSnapshot` here -
    // a follow-up user prompt in the same session should compute its
    // ↑ delta against the post-last-message-end snapshot, not against
    // a freshly cleared baseline.
    // Reset label so the next turn doesn't briefly flash a stale shimmer
    // frame before agent_start kicks in again. Uses the accepted phrase
    // when one was landed this loop, otherwise the static fallback.
    if (mode !== 'default') {
      ctx.ui.setWorkingMessage(renderLabel(0, undefined, currentHead()));
    }
  });

  pi.on('session_shutdown', async () => {
    stopLabelTicker();
    suffixState = null;
    rateState = null;
    rateBuffer = null;
    lastCtx = null;
    prevContextTokensSnapshot = undefined;
    // Reset point #3: abort + drop ALL phrase state so nothing bleeds
    // across pi sessions. /reload routes through session_shutdown +
    // session_start, so reset point #4 collapses onto this code path.
    if (phraseState !== null) {
      abortInFlight(phraseState);
      phraseState = null;
    }
    notifiedDynamicLabelWarnings.clear();
  });

  pi.registerCommand('waveform', {
    description:
      'Set the streaming working indicator: scroll, spectrum, tokenrate, off, or reset (restore pi default).',
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        ctx.ui.notify(`Waveform indicator: ${describeMode(mode)}`, 'info');
        return;
      }
      if (arg !== 'scroll' && arg !== 'spectrum' && arg !== 'tokenrate' && arg !== 'off' && arg !== 'reset') {
        ctx.ui.notify('Usage: /waveform [scroll|spectrum|tokenrate|off|reset]', 'error');
        return;
      }
      mode = arg === 'reset' ? 'default' : (arg as Mode);
      // Persist before applying so a UI failure mid-apply doesn't leave
      // the file out of sync with the user's expressed intent.
      try {
        if (arg === 'reset') {
          clearWaveformState(statePath);
        } else {
          writeWaveformState(statePath, mode);
        }
      } catch (e) {
        ctx.ui.notify(`Could not persist waveform mode to ${statePath}: ${(e as Error).message}`, 'error');
      }
      applyIndicator(ctx);
      // If we're mid-stream the label ticker is running - reapply now.
      if (labelTimer) {
        if (mode === 'default') {
          stopLabelTicker();
          ctx.ui.setWorkingMessage(undefined);
        } else {
          applyLabel(ctx);
        }
      } else if (mode === 'default') {
        ctx.ui.setWorkingMessage(undefined);
      }
      ctx.ui.notify(`Waveform indicator set to: ${describeMode(mode)}`, 'info');
    },
  });
}
