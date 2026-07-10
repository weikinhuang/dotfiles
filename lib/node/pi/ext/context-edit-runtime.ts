/**
 * Shared runtime for the three context-edit overlay extensions
 * (`context-trim`, `message-edit`, `tool-collapse`).
 *
 * Lives under `ext/` because it imports the pi runtime
 * (`buildSessionContext`, `ExtensionAPI`, `ExtensionContext`) - the pure
 * directive engine it drives (target resolution, the overlay pass,
 * candidate enumeration, the pure completion mapping) stays in
 * [`../context-edit/`](../context-edit).
 *
 * The three extensions share a near-identical plumbing skeleton, each
 * keyed by its own `customType` and candidate filter:
 *
 *   - a per-session directive `state`, rebuilt from the session branch on
 *     load (`reduceBranch(branch, customType)`);
 *   - a `context`-hook snapshot of the resolved messages the model saw
 *     (`lastContextMessages`), used to enumerate candidates on demand;
 *   - a Tab-completion candidate snapshot kept fresh from the context hook
 *     and after each command (`getArgumentCompletions` receives no `ctx`);
 *   - a `persist` mirror that appends the full post-mutation state as a
 *     `custom` session entry so overlays survive `/reload` + resume.
 *
 * This factory owns that state and exposes the shared operations; each
 * extension supplies only the parts that INTENTIONALLY differ - its
 * `candidatesFrom` filter, its completion `describe`, and its own
 * `context`-hook body (auto-collapse / non-vision strip) built from the
 * `readContextMessages` / `finishContext` primitives here.
 */

import {
  buildSessionContext,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { type CompletionCandidate, toCompletionCandidates } from '../context-edit/complete.ts';
import { cloneState, type ContextEditState, emptyState, reduceBranch } from '../context-edit/directive.ts';
import { type Candidate, candidateLabel } from '../context-edit/enumerate.ts';
import { type LooseMessage } from '../context-edit/target.ts';

/**
 * pi's `ContextEventResult` (`{ messages?: AgentMessage[] }`) is not
 * exported, so the runtime returns the overlaid list opaquely: `messages`
 * is typed `never` (assignable to pi's `AgentMessage[]` at the handler
 * return site, mirroring the extensions' original `{ messages: out as
 * never }`), or `undefined` when no directive applied.
 */
export type ContextHookResult = { messages: never } | undefined;

export interface ContextEditRuntimeOptions {
  /** The extension's `pi` handle (for `appendEntry`). */
  pi: ExtensionAPI;
  /** `custom`-entry type that keys this extension's persisted state. */
  customType: string;
  /**
   * The extension's candidate filter: enumerate + narrow the resolved
   * message list to the candidates this command targets. Intentionally
   * per-extension (tool-collapse merges call/result pairs, context-trim
   * drops tool-calls, message-edit keeps only messages), so it is
   * supplied here rather than unified.
   */
  candidatesFrom: (messages: readonly LooseMessage[]) => Candidate[];
  /**
   * Render a candidate's completion-menu description. Defaults to
   * {@link candidateLabel}; tool-collapse appends a `[background]` hint.
   */
  describe?: (c: Candidate) => string;
}

export interface ContextEditRuntime {
  /** The current persisted directive set. */
  getState(): ContextEditState;
  /** Replace the directive set (after a pure mutation returns a new state). */
  setState(next: ContextEditState): void;
  /** Rebuild `state` from the session branch: `reduceBranch(branch, customType)`. */
  rebuildFromSession(ctx: ExtensionContext): void;
  /** The extension's candidate filter, re-exposed for convenience. */
  candidatesFrom(messages: readonly LooseMessage[]): Candidate[];
  /** Refresh the Tab-completion snapshot from a candidate list. */
  refreshCompletion(cands: readonly Candidate[]): void;
  /** `candidatesFrom(messages)` + `refreshCompletion` + return the candidates. */
  refreshFromMessages(messages: readonly LooseMessage[]): Candidate[];
  /** Current Tab-completion snapshot (for `getArgumentCompletions`). */
  getCompletionCandidates(): CompletionCandidate[];
  /**
   * Resolve the message list to enumerate against: prefer the live
   * `context`-hook snapshot, else build it from the current branch.
   * (message-edit intentionally does NOT use this - see its inline note.)
   */
  currentMessages(ctx: ExtensionContext): LooseMessage[];
  /** The last `context`-hook snapshot (null before the first LLM call). */
  getSnapshot(): LooseMessage[] | null;
  /**
   * Read + guard the `context` event's message list, storing it as the
   * live snapshot. Returns null when the payload isn't an array (nothing
   * to overlay).
   */
  readContextMessages(event: ContextEvent): LooseMessage[] | null;
  /**
   * Close out a `context` hook: store the final overlaid list as the
   * snapshot, refresh the completion candidates, and return the pi result
   * (only when at least one directive applied).
   */
  finishContext(out: LooseMessage[], applied: number): ContextHookResult;
  /** Append the full post-mutation state as a `custom` entry; reset the snapshot. */
  persist(): void;
}

/** Build the shared context-edit runtime for one extension. */
export function createContextEditRuntime(options: ContextEditRuntimeOptions): ContextEditRuntime {
  const { pi, customType, candidatesFrom } = options;
  const describe = options.describe ?? candidateLabel;

  let state: ContextEditState = emptyState();
  // Snapshot of the resolved messages from the most recent `context`
  // hook - the exact list the model saw - so the commands enumerate
  // candidates that resolve back cleanly. null before the first LLM call.
  let lastContextMessages: LooseMessage[] | null = null;
  let completionCandidates: CompletionCandidate[] = [];

  const refreshCompletion = (cands: readonly Candidate[]): void => {
    completionCandidates = toCompletionCandidates(cands, describe);
  };

  const refreshFromMessages = (messages: readonly LooseMessage[]): Candidate[] => {
    const cands = candidatesFrom(messages);
    refreshCompletion(cands);
    return cands;
  };

  const currentMessages = (ctx: ExtensionContext): LooseMessage[] => {
    if (lastContextMessages) return lastContextMessages;
    try {
      const built = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      return (built.messages as unknown as LooseMessage[]) ?? [];
    } catch {
      return [];
    }
  };

  return {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    rebuildFromSession: (ctx) => {
      state = reduceBranch(ctx.sessionManager.getBranch(), customType);
    },
    candidatesFrom,
    refreshCompletion,
    refreshFromMessages,
    getCompletionCandidates: () => completionCandidates,
    currentMessages,
    getSnapshot: () => lastContextMessages,
    readContextMessages: (event) => {
      const messages = (event as unknown as { messages?: LooseMessage[] }).messages;
      if (!Array.isArray(messages)) return null;
      lastContextMessages = messages;
      return messages;
    },
    finishContext: (out, applied) => {
      lastContextMessages = out;
      refreshCompletion(candidatesFrom(out));
      return applied > 0 ? { messages: out as never } : undefined;
    },
    persist: () => {
      try {
        pi.appendEntry(customType, cloneState(state));
      } catch {
        // Never let bookkeeping break the command.
      }
      lastContextMessages = null;
    },
  };
}
