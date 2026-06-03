/**
 * Fork-mode helpers for the subagent extension.
 *
 * Pure module - no pi imports - so it can be unit-tested under `vitest`.
 *
 * "Fork mode" boots a child agent from the parent's full conversation
 * history (via `SessionManager.forkFrom`, seeded into `agent.state.messages`
 * by `createAgentSession`) instead of an empty context. The child sees
 * everything the parent saw, and -- when the request prefix matches the
 * parent's -- the model's prompt-cache prefix is reused.
 *
 * Anthropic's cache is byte-prefix based with breakpoints ordered
 * tools -> system -> last user message (verified in pi's
 * `packages/ai/src/providers/anthropic.ts`). A hit therefore requires the
 * child to reuse the parent's model + system prompt + tools verbatim, and
 * to inject its persona/task as the *new user message* rather than as a
 * system-prompt suffix (which would shift the system breakpoint and miss).
 * {@link buildForkPrompt} produces that user message.
 *
 * Recursion: the parent's history references the `subagent` /
 * `subagent_send` tools, so a forked child could be tempted to call them.
 * Children already run with `noExtensions: true` (so those tools are never
 * registered in the child), but we additionally exclude them by name
 * ({@link RECURSIVE_TOOL_NAMES}) and gate at runtime via `depth.ts` as
 * defense-in-depth.
 */

/** Tool names that must never be available to a child agent. */
export const RECURSIVE_TOOL_NAMES: readonly string[] = ['subagent', 'subagent_send'];

export interface ResolveForkModeArgs {
  /** Per-call `fork` tool param (overrides the agent default when set). */
  perCall: boolean | undefined;
  /** Agent-def `context` field: `inherit` opts into fork mode. */
  agentDefault: 'fresh' | 'inherit';
  /**
   * Parent session file path from `sessionManager.getSessionFile()`.
   * `undefined`/empty for non-persisted sessions, which cannot be forked.
   */
  parentSessionFile: string | undefined;
}

export interface ForkModeDecision {
  /** Whether to fork the parent context. */
  fork: boolean;
  /**
   * When fork was requested but downgraded to fresh, a short reason the
   * caller can surface (e.g. a `ctx.ui.notify`). Absent otherwise.
   */
  reason?: string;
}

/**
 * Decide whether a spawn runs in fork mode. The per-call param wins over
 * the agent default. A requested fork is downgraded to fresh (with a
 * reason) when the parent session is not persisted to disk, since
 * `SessionManager.forkFrom` needs a source file.
 */
export function resolveForkMode(args: ResolveForkModeArgs): ForkModeDecision {
  const requested = args.perCall ?? args.agentDefault === 'inherit';
  if (!requested) return { fork: false };
  const file = args.parentSessionFile?.trim();
  if (!file) {
    return { fork: false, reason: 'parent session is not persisted; running with fresh context' };
  }
  return { fork: true };
}

export interface BuildForkPromptArgs {
  /** Agent identity + role body. */
  agent: { name: string; body: string };
  /** The task the parent delegated. */
  task: string;
}

/**
 * The user message that seeds a forked child. Carries the agent persona
 * (normally the system prompt in fresh mode) plus the task, so the
 * child's system prompt can stay byte-identical to the parent's for cache
 * reuse.
 */
export function buildForkPrompt(args: BuildForkPromptArgs): string {
  const parts = [`You are now acting as the "${args.agent.name}" sub-agent, continuing from the conversation above.`];
  const body = args.agent.body.trim();
  if (body.length > 0) parts.push(body);
  parts.push(`## Task\n\n${args.task}`);
  return parts.join('\n\n');
}
