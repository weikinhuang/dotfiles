/**
 * Result extraction for the subagent extension.
 *
 * Pure module - no pi imports - so it can be unit-tested under `vitest`.
 * Mirrors the "content-part shape" approach in `btw.ts`: declares a
 * minimal local interface for `AssistantMessage.content[]` parts so this
 * module has no runtime dependency on `@earendil-works/pi-ai`.
 *
 * The final assistant text is what the parent LLM actually sees. Every
 * tool call, every thinking block, every intermediate user/tool result
 * is stripped out - that context stays in the child session file for
 * later auditing but never pollutes the parent.
 */

export type StopReason = 'completed' | 'max_turns' | 'aborted' | 'error';

export interface AssistantContentPart {
  type: string;
  /** Text parts carry the user-visible answer. */
  text?: string;
}

export interface AssistantMessageLike {
  role: 'assistant';
  content?: readonly AssistantContentPart[];
}

export interface AgentMessageLike {
  /** May be `user`, `assistant`, `toolResult`, `custom`, … - we only inspect `assistant`. */
  role: string;
  content?: readonly AssistantContentPart[];
}

/**
 * Scan `messages` from the back to find the last assistant message with
 * at least one `text` content part, and return the concatenated text.
 * Returns an empty string when the child never emitted a final answer
 * (tool-call-only termination, aborted before first message, etc.).
 *
 * Consecutive text parts are joined with no separator so models that
 * stream text in chunks still read naturally (same as `btw.ts`).
 */
export function extractFinalAssistantText(messages: readonly AgentMessageLike[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.content) continue;
    const parts: string[] = [];
    for (const part of m.content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join('').trim();
  }
  return '';
}

export interface ClassifyStopReasonInput {
  /** The child's turn counter exceeded `maxTurns`. */
  reachedMaxTurns?: boolean;
  /** The parent's abort signal fired, or the per-call timeout tripped. */
  aborted?: boolean;
  /** Child threw or returned an error. */
  error?: boolean;
}

/**
 * Pick the most specific stop reason, with precedence:
 *   max_turns > aborted > error > completed
 *
 * `max_turns` outranks `aborted` because we synthesize the abort signal
 * on purpose when we hit the cap, and users want to see that
 * distinction in the tool result details.
 */
export function classifyStopReason(input: ClassifyStopReasonInput): StopReason {
  if (input.reachedMaxTurns) return 'max_turns';
  if (input.aborted) return 'aborted';
  if (input.error) return 'error';
  return 'completed';
}
