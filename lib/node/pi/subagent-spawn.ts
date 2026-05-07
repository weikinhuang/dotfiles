/**
 * Shared subagent spawn primitives.
 *
 * Extracted from `config/pi/extensions/subagent.ts` so other extensions
 * that need to spawn a one-shot child agent (currently the iteration-loop
 * critic) can go through the same pipeline without cloning the spawn
 * path — model resolution, timeout + abort wiring, turn-count enforcement,
 * stop-reason classification, and final-text extraction.
 *
 * Two exports:
 *   - `resolveChildModel(...)` — pure model resolution for a child agent,
 *     given (optional) spec override + agent default + parent inherit.
 *     Used by both the full subagent spawn (worktree / background /
 *     audit mirror) and the critic one-shot.
 *   - `runOneShotAgent(...)` — single-prompt spawn: create the session,
 *     subscribe, drive `child.prompt(task)`, enforce timeout + maxTurns
 *     + parent signal, return classification. Callers that need richer
 *     orchestration (worktrees, snapshots, multi-prompt children) stay
 *     with the full extension-local path; this helper targets the
 *     "spawn → one answer → read → done" shape.
 *
 * This module intentionally has no dependency on
 * `@earendil-works/pi-coding-agent` — the real `createAgentSession`,
 * `DefaultResourceLoader`, and `SessionManager` are injected by the
 * extension caller through `runOneShotAgent`'s `deps` object. That
 * keeps the helper testable under `vitest` without the pi runtime and
 * matches the `ReadLayer` / `SpawnLike` dependency-injection pattern
 * already in use for other `lib/node/pi/` helpers.
 *
 * No disposal policy on the session — `runOneShotAgent` already calls
 * `session.dispose()` by default; the caller can pass `keepSession: true`
 * to opt out and inspect `session.state.messages` first.
 */

import { parseModelSpec } from './btw.ts';
import { type AgentDef } from './subagent-loader.ts';
import { extractFinalAssistantText, type AgentMessageLike } from './subagent-result.ts';

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
  /** Parent's current model — used when override is absent AND the agent is `inherit`. */
  parent: M | undefined;
  /** Model registry used to resolve `provider/id` to a runtime model descriptor. */
  modelRegistry: ModelRegistryLike<M>;
}

export type ResolveChildModelResult<M> = { ok: true; model: M } | { ok: false; error: string };

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
    const resolved = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!resolved) return { ok: false, error: `model ${parsed.provider}/${parsed.modelId} not registered` };
    return { ok: true, model: resolved };
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

// ──────────────────────────────────────────────────────────────────────
// One-shot spawn
// ──────────────────────────────────────────────────────────────────────

/**
 * Narrow shape of the `AgentSession` returned by
 * `@earendil-works/pi-coding-agent`. We only need what `runOneShotAgent`
 * touches — subscribe, prompt, abort, dispose, and `state.messages`.
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

/** Session creator — matches pi's `createAgentSession` return shape. */
export type CreateAgentSessionDep<M, S> = (args: {
  cwd: string;
  model: M;
  thinkingLevel: AgentDef['thinkingLevel'];
  tools: string[];
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  authStorage: unknown;
  resourceLoader: ResourceLoaderLike;
  sessionManager: S;
}) => Promise<{ session: AgentSessionLike }>;

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
}

/** Dependency injection bundle — the extension passes pi's real constructors here. */
export interface RunOneShotDeps<M, S> {
  createAgentSession: CreateAgentSessionDep<M, S>;
  DefaultResourceLoader: new (args: DefaultResourceLoaderCtorArgs) => ResourceLoaderLike;
  /** SessionManager — only `inMemory(cwd)` is invoked by the helper. */
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
  /** pi's model registry, threaded into the session for auth / dispatch. */
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
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
 *   - reached `maxTurns` (we abort after the N-th `turn_end`)
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
  const resourceLoader = new deps.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: undefined,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    appendSystemPrompt: appendParts.length > 0 ? appendParts : undefined,
  });
  await resourceLoader.reload();

  const created = await deps.createAgentSession({
    cwd,
    model,
    thinkingLevel: agent.thinkingLevel,
    tools: agent.tools,
    modelRegistry,
    authStorage: modelRegistry.authStorage,
    resourceLoader,
    sessionManager,
  });
  const child = created.session;

  let turns = 0;
  let reachedMaxTurns = false;
  let abortedByUs = false;
  let errFromChild: string | undefined;

  const doAbort = (): void => {
    abortedByUs = true;
    void child.abort();
  };

  const unsubscribe = child.subscribe((event: AgentSessionEventLike) => {
    if (event.type === 'turn_end') {
      turns++;
      if (turns >= maxTurns) {
        reachedMaxTurns = true;
        doAbort();
      }
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const err = event.message.errorMessage;
      if (err) errFromChild = err;
    }
    onEvent?.({ event, turn: turns, abort: doAbort });
  });

  const timer = setTimeout(doAbort, timeoutMs);
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

  let stopReason: OneShotStopReason;
  let errorMessage: string | undefined;
  if (reachedMaxTurns) {
    stopReason = 'max_turns';
    errorMessage = `hit max turns (${maxTurns})`;
  } else if (abortedByUs || errorIsAbort || signal?.aborted === true) {
    stopReason = 'aborted';
    errorMessage = 'aborted';
  } else if (thrownError && !errorIsAbort) {
    stopReason = 'error';
    errorMessage = thrownError.message;
  } else if (errFromChild) {
    stopReason = 'error';
    errorMessage = errFromChild;
  } else {
    stopReason = 'completed';
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
