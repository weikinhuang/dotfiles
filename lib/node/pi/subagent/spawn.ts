/**
 * Shared subagent spawn primitives.
 *
 * Extracted from `config/pi/extensions/subagent.ts` so other extensions
 * that need to spawn a one-shot child agent (currently the iteration-loop
 * critic) can go through the same pipeline without cloning the spawn
 * path - model resolution, timeout + abort wiring, turn-count enforcement,
 * stop-reason classification, and final-text extraction.
 *
 * Two exports:
 *   - `resolveChildModel(...)` - pure model resolution for a child agent,
 *     given (optional) spec override + agent default + parent inherit.
 *     Used by both the full subagent spawn (worktree / background /
 *     audit mirror) and the critic one-shot.
 *   - `runOneShotAgent(...)` - single-prompt spawn: create the session,
 *     subscribe, drive `child.prompt(task)`, enforce timeout + maxTurns
 *     + parent signal, return classification. Callers that need richer
 *     orchestration (worktrees, snapshots, multi-prompt children) stay
 *     with the full extension-local path; this helper targets the
 *     "spawn → one answer → read → done" shape.
 *
 * This module intentionally has no dependency on
 * `@earendil-works/pi-coding-agent` - the real `createAgentSession`,
 * `DefaultResourceLoader`, and `SessionManager` are injected by the
 * extension caller through `runOneShotAgent`'s `deps` object. That
 * keeps the helper testable under `vitest` without the pi runtime and
 * matches the `ReadLayer` / `SpawnLike` dependency-injection pattern
 * already in use for other `lib/node/pi/` helpers.
 *
 * No disposal policy on the session - `runOneShotAgent` already calls
 * `session.dispose()` by default; the caller can pass `keepSession: true`
 * to opt out and inspect `session.state.messages` first.
 */

import { parseModelSpec } from '../model-spec.ts';
import { type ThinkingLevel, THINKING_LEVELS } from '../preset.ts';
import { collectSubagentInjections, type SubagentExtensionFactory } from './extension-injection.ts';
import { type AgentDef } from './loader.ts';
import { classifyStopReason, extractFinalAssistantText, type AgentMessageLike } from './result.ts';

// ──────────────────────────────────────────────────────────────────────
// Model resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal structural subset of pi's `ModelRegistry.find()` so callers
 * can pass the real thing without pulling in the pi-ai types here.
 */
export interface ModelRegistryLike<M> {
  find(provider: string, modelId: string): M | undefined;
}

export interface ResolveChildModelOptions<M> {
  /** Explicit override string (e.g. `amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0`). */
  override?: string | undefined;
  /** Agent default model (or `'inherit'`). */
  agent: AgentDef;
  /** Parent's current model - used when override is absent AND the agent is `inherit`. */
  parent: M | undefined;
  /** Model registry used to resolve `provider/id` to a runtime model descriptor. */
  modelRegistry: ModelRegistryLike<M>;
}

export type ResolveChildModelResult<M> =
  | { ok: true; model: M; thinkingLevel?: ThinkingLevel }
  | { ok: false; error: string };

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/**
 * Peel a trailing `:<thinking-level>` suffix off a model id, mirroring
 * pi's own model-pattern parsing (`packages/coding-agent` model-resolver).
 * Model ids may legitimately contain colons (OpenRouter `:exacto`, Bedrock
 * inference-profile `...:0`), so callers must try an exact registry match
 * first and only fall back to this when that misses. Returns `undefined`
 * when the last colon segment is not a recognised thinking level.
 */
function splitThinkingSuffix(modelId: string): { modelId: string; thinkingLevel: ThinkingLevel } | undefined {
  const idx = modelId.lastIndexOf(':');
  if (idx <= 0) return undefined;
  const suffix = modelId.slice(idx + 1);
  if (!THINKING_LEVEL_SET.has(suffix)) return undefined;
  return { modelId: modelId.slice(0, idx), thinkingLevel: suffix as ThinkingLevel };
}

/**
 * Resolve the model to use for a spawned child agent.
 *
 * Precedence: explicit `override` → agent's own model (unless
 * `'inherit'`) → parent's current model.
 *
 * Returns a tagged result so the caller can surface a precise
 * diagnostic to the user when any stage fails. The `error` strings
 * mirror the previous in-extension wording so tool-result messages
 * don't change shape.
 */
export function resolveChildModel<M>({
  override,
  agent,
  parent,
  modelRegistry,
}: ResolveChildModelOptions<M>): ResolveChildModelResult<M> {
  if (override) {
    const parsed = parseModelSpec(override);
    if (!parsed) return { ok: false, error: `invalid modelOverride "${override}" (expected provider/id)` };
    // Exact match first: model ids may legitimately end in a colon segment
    // (e.g. `...:0`, `model:exacto`) that is not a thinking level.
    const exact = modelRegistry.find(parsed.provider, parsed.modelId);
    if (exact) return { ok: true, model: exact };
    // Miss: peel a trailing `:<thinking-level>` suffix and retry, so specs
    // like `llama-cpp/qwen3-6-27b:off` resolve to the registered base model
    // and carry the requested thinking level back to the caller.
    const split = splitThinkingSuffix(parsed.modelId);
    if (split) {
      const resolved = modelRegistry.find(parsed.provider, split.modelId);
      if (resolved) return { ok: true, model: resolved, thinkingLevel: split.thinkingLevel };
    }
    return { ok: false, error: `model ${parsed.provider}/${parsed.modelId} not registered` };
  }
  if (agent.model !== 'inherit') {
    const resolved = modelRegistry.find(agent.model.provider, agent.model.modelId);
    if (!resolved) {
      return { ok: false, error: `agent model ${agent.model.provider}/${agent.model.modelId} not registered` };
    }
    return { ok: true, model: resolved };
  }
  if (!parent) {
    return { ok: false, error: 'no model available for child session (use /login or configure a default model)' };
  }
  return { ok: true, model: parent };
}

/**
 * Return `agent` with its `thinkingLevel` replaced by `thinkingLevel` when a
 * `resolveChildModel` override peeled a `:<level>` suffix off the model spec
 * (e.g. `llama-cpp/qwen3-6-27b:off`); otherwise return `agent` unchanged.
 *
 * Centralises the merge every `runOneShotAgent` caller applies so a resolved
 * suffix wins over the agent def's own level, without threading a new option
 * through each mock-shim + wrapper. `runOneShotAgent` reads `agent.thinkingLevel`
 * when it creates the session, so passing the adjusted agent is sufficient.
 */
export function agentWithResolvedThinking(agent: AgentDef, thinkingLevel: ThinkingLevel | undefined): AgentDef {
  return thinkingLevel === undefined ? agent : { ...agent, thinkingLevel };
}

// ──────────────────────────────────────────────────────────────────────
// One-shot spawn
// ──────────────────────────────────────────────────────────────────────

/**
 * Narrow shape of the `AgentSession` returned by
 * `@earendil-works/pi-coding-agent`. We only need what `runOneShotAgent`
 * touches - subscribe, prompt, abort, dispose, and `state.messages`.
 */
export interface AgentSessionLike {
  subscribe(handler: (event: AgentSessionEventLike) => void): () => void;
  prompt(task: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly state: { messages: unknown };
}

/** Subset of pi's `AgentSessionEvent` union used for turn counting + cost aggregation. */
export interface AgentSessionEventLike {
  type: string;
  message?: {
    role?: string;
    errorMessage?: string;
    /**
     * Assistant content parts. We only need each part's `type` to tell
     * whether the turn ended with a `toolCall` (the agent intends another
     * turn) versus a final text answer (it is done). Typed as the same
     * `string | parts[]` union pi's `AgentMessage.content` uses (a
     * `UserMessage` carries a bare string) so pi's real event stream
     * stays assignable; we only inspect it when it is an array. Optional
     * because non-assistant events omit it.
     */
    content?: string | readonly { type?: string }[];
    /**
     * Per-assistant-turn token + USD cost payload populated by pi's
     * `AssistantMessage.usage` (see `@earendil-works/pi-ai`'s `Usage`
     * type). `usage.cost.total` is the USD number `research-cost-hook`
     * sums to drive the statusline cost counter. Optional because
     * non-assistant events and aborted turns may lack it.
     */
    usage?: {
      cost?: {
        total?: number;
      };
    };
  };
}

/**
 * Session creator - matches pi's `createAgentSession` return shape.
 *
 * `modelRegistry` is forwarded for backwards-compat but is a no-op under
 * pi >= 0.80: `createAgentSession` no longer accepts a registry / auth
 * store and instead builds its own `ModelRuntime` from `agentDir`
 * (auth.json + models.json). The registry's only live consumer here is
 * `resolveChildModel` (via `find`), so the dep only needs the structural
 * `ModelRegistryLike<M>` - no `authStorage`.
 */
export type CreateAgentSessionDep<M, S> = (args: {
  cwd: string;
  model: M;
  thinkingLevel: AgentDef['thinkingLevel'];
  tools: string[];
  modelRegistry: ModelRegistryLike<M>;
  resourceLoader: ResourceLoaderLike;
  sessionManager: S;
}) => Promise<{ session: AgentSessionLike }>;

export function adaptCreateAgentSession<M, S, MR, RL>(
  createAgentSession: (args: {
    cwd: string;
    model: M;
    thinkingLevel: AgentDef['thinkingLevel'];
    tools: string[];
    modelRegistry: MR;
    resourceLoader: RL;
    sessionManager: S;
  }) => Promise<{ session: AgentSessionLike }>,
): CreateAgentSessionDep<M, S> {
  return (args) =>
    createAgentSession({
      ...args,
      modelRegistry: args.modelRegistry as MR,
      resourceLoader: args.resourceLoader as RL,
    });
}

/** Minimal resource-loader shape (just the method `runOneShotAgent` awaits). */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** Minimal options that pi's `DefaultResourceLoader` constructor accepts. */
export interface DefaultResourceLoaderCtorArgs {
  cwd: string;
  agentDir: string;
  settingsManager: undefined;
  noExtensions: true;
  noSkills: true;
  noPromptTemplates: true;
  appendSystemPrompt?: string[];
  /**
   * Inline factories loaded into the child session even though
   * `noExtensions: true` skips the layered on-disk extensions. Pi's
   * `DefaultResourceLoader` accepts this slot natively; we surface it
   * here so `runOneShotAgent` can compose the global subagent-injection
   * registry (`collectSubagentInjections()`) with any per-call factories
   * the caller threads through `RunOneShotAgentOptions.extensionFactories`.
   */
  extensionFactories?: SubagentExtensionFactory[];
}

/** Dependency injection bundle - the extension passes pi's real constructors here. */
export interface RunOneShotDeps<M, S> {
  createAgentSession: CreateAgentSessionDep<M, S>;
  DefaultResourceLoader: new (args: DefaultResourceLoaderCtorArgs) => ResourceLoaderLike;
  /** SessionManager - only `inMemory(cwd)` is invoked by the helper. */
  SessionManager: { inMemory(cwd: string): S };
  /** Agent-dir resolver (pi's `getAgentDir`). */
  getAgentDir(): string;
}

/** Classification returned alongside the final text. */
export type OneShotStopReason = 'completed' | 'max_turns' | 'aborted' | 'error';

/** Event passed to `onEvent`. Caller can `abort()` to trigger termination (classified as aborted). */
export interface OneShotAgentEvent {
  event: AgentSessionEventLike;
  /** Turn count AFTER incrementing on `turn_end`, or current value on other events. */
  turn: number;
  /** Aborts the running child; counts as `abortedByUs` for stop-reason classification. */
  abort(): void;
}

export interface RunOneShotAgentOptions<M, S> {
  /** Injected pi constructors (see `RunOneShotDeps`). */
  deps: RunOneShotDeps<M, S>;
  /** cwd passed through to the agent session and DefaultResourceLoader. */
  cwd: string;
  /** Agent definition (from `loadAgents`). */
  agent: AgentDef;
  /** Resolved child model (see `resolveChildModel`). */
  model: M;
  /** Prompt given to the child. */
  task: string;
  /** pi's model registry, used by `resolveChildModel` to resolve `provider/id`. */
  modelRegistry: ModelRegistryLike<M>;
  /** Agent search path for `DefaultResourceLoader`. Defaults to `deps.getAgentDir()`. */
  agentDir?: string;
  /** SessionManager to use. Defaults to `deps.SessionManager.inMemory(cwd)`. */
  sessionManager?: S;
  /** Parent turn's AbortSignal. Abort classification triggers on this as well as timeout/maxTurns. */
  signal?: AbortSignal;
  /** Wall-clock cap in ms. Defaults to `agent.timeoutMs`. */
  timeoutMs?: number;
  /** Turn count cap. Defaults to `agent.maxTurns`. */
  maxTurns?: number;
  /** Per-event hook. Callers may aggregate usage or push status. */
  onEvent?: (event: OneShotAgentEvent) => void;
  /** Don't call `session.dispose()` on return; caller owns the lifecycle. */
  keepSession?: boolean;
  /**
   * Per-call extension factories loaded into the child session. These
   * compose AFTER the global subagent-injection registry returned by
   * `collectSubagentInjections()`, so a per-call factory can override
   * a globally-registered one (pi's runner uses last-registered-wins
   * semantics for handlers on the same event).
   *
   * Most callers (deep-research, iteration-loop) leave this unset and
   * rely solely on the registry; `subagent` style callers that build
   * their own resource loader can mirror this composition manually.
   */
  extensionFactories?: SubagentExtensionFactory[];
}

export interface RunOneShotAgentResult {
  /** Final assistant text (already extracted). */
  finalText: string;
  /** Turns counted via `turn_end`. */
  turns: number;
  /** Classification (completed / max_turns / aborted / error). */
  stopReason: OneShotStopReason;
  /** Human-readable error when `stopReason !== 'completed'`. */
  errorMessage?: string;
  /** Child's message list (same reference as `session.state.messages`). */
  messages: AgentMessageLike[];
  /** The session itself. Disposed unless `keepSession: true` was passed. */
  session: AgentSessionLike;
}

/**
 * Spawn `agent` with `task`, drive exactly one prompt, return
 * classification + final text.
 *
 * Catches + classifies these termination modes:
 *   - normal completion
 *   - reached `maxTurns` (we abort after the N-th `turn_end` *only* when
 *     that turn still wanted to continue; a final answer that lands on
 *     the N-th turn is a normal completion, not a truncation)
 *   - wall-clock timeout (we abort when `timeoutMs` elapses)
 *   - parent `AbortSignal` fired (we abort + classify as aborted)
 *   - child threw a non-abort Error (classified as error)
 *   - child reported an `errorMessage` on a message_end (classified as error)
 *
 * On any abort path the child's `abort()` is called exactly once; the
 * timeout and parent-signal listeners are removed in `finally` so the
 * caller doesn't leak timer / event-listener handles.
 */
export async function runOneShotAgent<M, S>(options: RunOneShotAgentOptions<M, S>): Promise<RunOneShotAgentResult> {
  const {
    deps,
    cwd,
    agent,
    model,
    task,
    modelRegistry,
    agentDir = deps.getAgentDir(),
    sessionManager = deps.SessionManager.inMemory(cwd),
    signal,
    timeoutMs = agent.timeoutMs,
    maxTurns = agent.maxTurns,
    onEvent,
    keepSession = false,
  } = options;

  const appendParts: string[] = [];
  if (agent.appendSystemPrompt) appendParts.push(agent.appendSystemPrompt);
  if (agent.body.trim().length > 0) appendParts.push(agent.body.trim());
  // Compose global subagent-injection registry first, then per-call
  // factories - last-registered wins per pi's handler-chain semantics,
  // so a caller can override a globally-registered hook on the same
  // event by passing its own factory in `options.extensionFactories`.
  const factories: SubagentExtensionFactory[] = [...collectSubagentInjections(), ...(options.extensionFactories ?? [])];
  const resourceLoader = new deps.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: undefined,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    appendSystemPrompt: appendParts.length > 0 ? appendParts : undefined,
    ...(factories.length > 0 ? { extensionFactories: factories } : {}),
  });
  await resourceLoader.reload();

  const created = await deps.createAgentSession({
    cwd,
    model,
    thinkingLevel: agent.thinkingLevel,
    tools: agent.tools,
    modelRegistry,
    resourceLoader,
    sessionManager,
  });
  const child = created.session;

  let turns = 0;
  let reachedMaxTurns = false;
  let abortedByUs = false;
  let timedOut = false;
  let errFromChild: string | undefined;
  // Whether the current assistant turn ended wanting to continue (it
  // emitted a tool call, so pi will run another turn). Lets us tell a
  // *natural completion that lands on the maxTurns-th turn* (no pending
  // tool call -> the agent is done) apart from a *runaway cut off at the
  // cap* (pending tool call -> we truncated real work). Defaults to
  // false and is reset at each `turn_start`, so a stale value from a
  // prior turn can never mis-flag a cap-hit as max_turns; we only trip
  // the cap when THIS turn actually signalled a pending tool call.
  let lastTurnWantsMore = false;

  const doAbort = (): void => {
    abortedByUs = true;
    void child.abort();
  };

  const unsubscribe = child.subscribe((event: AgentSessionEventLike) => {
    if (event.type === 'turn_start') {
      lastTurnWantsMore = false;
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const err = event.message.errorMessage;
      if (err) errFromChild = err;
      const content = event.message.content;
      if (typeof content === 'object' && content !== null && content.length > 0) {
        lastTurnWantsMore = content.some((part) => part?.type === 'toolCall');
      }
    } else if (event.type === 'turn_end') {
      turns++;
      // Only treat hitting the cap as max_turns when the agent actually
      // wanted another turn. A subagent whose final answer lands exactly
      // on the maxTurns-th turn (e.g. image-captioner: turn 1 reads, turn
      // 2 captions) has completed - flagging it max_turns would throw away
      // a perfectly good finalText.
      if (turns >= maxTurns && lastTurnWantsMore) {
        reachedMaxTurns = true;
        doAbort();
      }
    }
    onEvent?.({ event, turn: turns, abort: doAbort });
  });

  const timer = setTimeout(() => {
    timedOut = true;
    doAbort();
  }, timeoutMs);
  const onParentAbort = (): void => doAbort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  let thrownError: Error | undefined;
  try {
    await child.prompt(task);
  } catch (e) {
    thrownError = e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
    unsubscribe();
  }

  const errorIsAbort =
    thrownError !== undefined && (thrownError.name === 'AbortError' || /abort/i.test(thrownError.message ?? ''));
  const messages = child.state.messages as AgentMessageLike[];
  const finalText = extractFinalAssistantText(messages);

  // Share the one stop-reason precedence (max_turns > aborted > error >
  // completed) with `result.ts::classifyStopReason` instead of inlining a
  // second copy. A thrown abort / a fired parent signal / our own abort
  // all count as "aborted"; a non-abort throw or a child-reported
  // errorMessage counts as "error".
  const aborted = abortedByUs || errorIsAbort || signal?.aborted === true;
  const hadError = (thrownError !== undefined && !errorIsAbort) || errFromChild !== undefined;
  const stopReason: OneShotStopReason = classifyStopReason({ reachedMaxTurns, aborted, error: hadError });

  let errorMessage: string | undefined;
  if (stopReason === 'max_turns') {
    errorMessage = `hit max turns (${maxTurns})`;
  } else if (stopReason === 'aborted') {
    // Distinguish the wall-clock timeout from a user / parent abort so
    // the tool result explains WHY the child stopped.
    errorMessage = timedOut ? `timed out after ${timeoutMs}ms` : 'aborted';
  } else if (stopReason === 'error') {
    errorMessage = thrownError && !errorIsAbort ? thrownError.message : errFromChild;
  }

  if (!keepSession) {
    try {
      child.dispose();
    } catch {
      /* best-effort */
    }
  }

  return { finalText, turns, stopReason, errorMessage, messages, session: child };
}
