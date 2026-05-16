/**
 * Pure helpers for the stall-recovery extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The extension's job is to detect when an agent turn ended without
 * producing meaningful work - either because the model stopped silently
 * (common with weaker local models and with reasoning models whose
 * "thinking" phase completes without emitting content) or because the
 * provider/transport errored out - and fire a follow-up nudge that pokes
 * the agent loop into another turn. The classifier here decides whether
 * a turn looks stalled; the extension handles budget, UI, and delivery.
 *
 * Detection is deliberately conservative: we only fire on two unambiguous
 * signals, `empty` (no text + no tool calls) and `error` (explicit error
 * field somewhere on the turn). Hedging / punting detection was considered
 * and rejected - the false-positive rate would be too high, and the todo
 * extension's completion-claim guardrail catches a related case ("claimed
 * done but didn't deliver") from a separate angle. The two extensions are
 * orthogonal and compose naturally.
 */

import { truncate } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/** What kind of stall we detected. */
export type StallReason = { kind: 'empty' } | { kind: 'error'; error: string };

/**
 * Duck-typed minimal shape of an assistant message's meaningful output.
 * The extension extracts this from `event.messages` on `agent_end`; the
 * classifier works off it so tests don't have to fabricate whole
 * provider-message objects.
 */
export interface AssistantSnapshot {
  /** Concatenated text content, un-trimmed. */
  text: string;
  /** Number of tool-call content parts in the final assistant message. */
  toolCallCount: number;
  /** Optional explicit error. Presence implies a failed turn. */
  error?: string;
  /**
   * Provider `stopReason` when available, e.g. `"stop"`, `"toolUse"`,
   * `"length"`, `"error"`, or `"aborted"`. Carried through so the
   * classifier can distinguish user-initiated aborts (Ctrl+C) from
   * genuine stalls - we must NEVER treat an explicit user interrupt as
   * something to auto-retry past.
   */
  stopReason?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Message-shape helpers + sentinel
// ──────────────────────────────────────────────────────────────────────

/**
 * Unwrap a possibly-wrapped session entry down to its inner message.
 * Session storage sometimes wraps messages as `{ message: {...} }` and
 * sometimes delivers bare `AgentMessage`s; handle both without throwing.
 */
function unwrapMessage(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const w = entry as { message?: unknown };
  return w.message ?? entry;
}

/**
 * Best-effort extraction of text from a user message. User content can be
 * a bare string or an array of `{type:'text', text}` / image parts; we
 * only want the text.
 */
function userMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as { role?: string; content?: unknown };
  if (m.role !== 'user') return '';
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  const parts: string[] = [];
  for (const raw of m.content) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as { type?: string; text?: unknown };
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n');
}

/** Sentinel prefix identifying messages this extension synthesized. */
export const STALL_MARKER = '⟳ [pi-stall-recovery]';

/**
 * Detect whether `text` already carries our sentinel. Used both to skip
 * re-firing on our own injected messages and to count prior retries in
 * the branch when recovering after a reload.
 */
export function hasStallMarker(text: string): boolean {
  return text.includes(STALL_MARKER);
}

// ──────────────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────────────

/**
 * Classify an assistant turn snapshot as a stall (returning a reason) or
 * normal (returning `null`). Order of checks matters:
 *
 *   1. User-initiated aborts (`stopReason === 'aborted'`) are never
 *      stalls. Ctrl+C is an explicit request to stop; auto-retrying
 *      past it would fight the user.
 *   2. Errors win over emptiness so the retry message can surface the
 *      specific failure.
 *   3. Genuinely empty turns (no text + no tool calls) are stalls.
 */
export function classifyAssistant(snap: AssistantSnapshot): StallReason | null {
  if (snap.stopReason === 'aborted') return null;
  if (snap.error?.trim()) {
    return { kind: 'error', error: snap.error.trim() };
  }
  const trimmed = snap.text.trim();
  if (trimmed.length === 0 && snap.toolCallCount === 0) {
    return { kind: 'empty' };
  }
  return null;
}

/**
 * Extract an `AssistantSnapshot` from an arbitrary assistant-message
 * object. Handles both string-content and content-part-array shapes
 * defensively - provider adapters vary, and we'd rather under-fire than
 * throw.
 *
 * Returns `null` if the input isn't recognizably an assistant message;
 * callers use that to skip entries cleanly.
 */
export function snapshotFromAssistantMessage(message: unknown): AssistantSnapshot | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as {
    role?: string;
    content?: unknown;
    error?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (m.role !== 'assistant') return null;

  let text = '';
  let toolCallCount = 0;

  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const raw of m.content) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as { type?: string; text?: unknown };
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c.type === 'toolCall') toolCallCount++;
    }
    text = parts.join('\n');
  }

  // Providers expose the failure reason under either `error` (older
  // shapes) or `errorMessage` (pi-agent-core ≥ recent), paired with a
  // `stopReason`. Accept both on the way in.
  const error = typeof m.error === 'string' ? m.error : typeof m.errorMessage === 'string' ? m.errorMessage : undefined;
  const stopReason = typeof m.stopReason === 'string' ? m.stopReason : undefined;

  return { text, toolCallCount, error, stopReason };
}

/**
 * Pull the last assistant snapshot from a sequence of turn messages. The
 * `agent_end` event carries `event.messages` which includes the user
 * prompt, every assistant/toolResult cycle, and any errors along the way.
 * We only care about the FINAL assistant message - that's the one that
 * either produced work (good) or stalled (bad).
 *
 * Returns `null` if the sequence contains no assistant message at all
 * (degenerate input; skip detection).
 */
export function lastAssistantSnapshot(messages: readonly unknown[]): AssistantSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const snap = snapshotFromAssistantMessage(unwrapMessage(messages[i]));
    if (snap) return snap;
  }
  return null;
}

/**
 * Count consecutive trailing stall turns in a message history, reading
 * backwards from the end. The returned count is the number of retries
 * already attempted for the current real-user prompt - i.e., `0` means
 * no trailing stall (either empty history or the last assistant turn was
 * healthy), `1` means the last assistant turn stalled, `2` means the
 * last two assistant turns both stalled, etc.
 *
 * Walks back through the history using these rules:
 *
 *   - `assistant` that classifies as a stall → count++, keep walking.
 *   - `assistant` that is healthy (text or tool call) → stop; the streak
 *     broke, return the count so far. Intermediate successful turns
 *     within a multi-step agent loop naturally reset the budget.
 *   - `user` carrying our sentinel (`STALL_MARKER`) → a synthesized
 *     nudge; skip, keep walking.
 *   - `user` without the sentinel → a real user input; stop. This
 *     scopes the counter to the current user prompt without needing any
 *     in-memory state.
 *   - `toolResult` or other roles → skip; invisible to the streak.
 *
 * Designed to replace the extension's in-memory `consecutiveRetries`
 * counter, which lost track of intermediate successful turns within an
 * agent run (those don't fire `agent_end`). Being stateless also makes
 * reload-mid-stall correct for free.
 */
export function countTrailingStalls(messages: readonly unknown[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = unwrapMessage(messages[i]);
    if (!raw || typeof raw !== 'object') continue;
    const role = (raw as { role?: string }).role;
    if (role === 'assistant') {
      const snap = snapshotFromAssistantMessage(raw);
      if (!snap) continue;
      if (classifyAssistant(snap)) {
        count++;
        continue;
      }
      return count; // healthy assistant breaks the streak
    }
    if (role === 'user') {
      const text = userMessageText(raw);
      if (text && hasStallMarker(text)) continue; // synthesized nudge
      return count; // real user input resets the budget
    }
    // toolResult and other roles are transparent to the streak.
  }
  return count;
}

// ──────────────────────────────────────────────────────────────────────
// Retry-message builder
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the follow-up user message injected into the session to kick the
 * agent into another turn. Carries the sentinel so the extension can
 * detect its own prior injections and enforce the retry budget.
 *
 * Messages are short and directive by design - weaker models benefit from
 * concrete instructions ("continue where you left off") over vague ones
 * ("please continue").
 *
 * The tone escalates with `attempt`. On the first retry we nudge; on the
 * final allowed retry (`attempt >= maxAttempts`) we switch to an
 * imperative prompt that explicitly forbids another empty / re-thinking
 * response. In practice the gentle prompt is almost identical to the
 * original instruction, which reasoning models sometimes re-enter; the
 * imperative prompt is worded differently enough to shift the strategy.
 */
export function buildRetryMessage(reason: StallReason, attempt: number, maxAttempts: number): string {
  const budget = `(${attempt}/${maxAttempts})`;
  const isFinalAttempt = attempt >= maxAttempts;
  switch (reason.kind) {
    case 'empty':
      if (isFinalAttempt) {
        return [
          STALL_MARKER,
          budget,
          `Your previous ${attempt} turn(s) produced ZERO output - no text, no tool calls.`,
          'You MUST emit content this turn: either a concrete tool_use block or a final text answer for the user.',
          'Do NOT return another empty response. Do NOT spend the whole turn in extended thinking.',
          'If you have genuinely nothing to do, say so explicitly in a short text block (e.g. "Task complete" or',
          '"Blocked on: <reason>") - silence is not an acceptable answer.',
        ].join(' ');
      }
      return [
        STALL_MARKER,
        budget,
        'Your previous turn produced no output. The task is not complete. Continue where you left off -',
        'review any active todos, check the last tool result if there was one, and produce either the',
        'next tool call or the final answer for the user.',
      ].join(' ');
    case 'error':
      if (isFinalAttempt) {
        return [
          STALL_MARKER,
          budget,
          `Your previous ${attempt} turn(s) failed with transport errors (last: ${truncate(reason.error, 160)}).`,
          'Retry once more. If the error looks transient (rate limit, DNS, timeout) just re-run the same call.',
          'If it looks structural (4xx, schema mismatch), change approach - e.g. smaller batch, different tool,',
          'or report the failure back to the user in a text block instead of silently giving up.',
        ].join(' ');
      }
      return [
        STALL_MARKER,
        budget,
        `Your previous turn failed with: ${truncate(reason.error, 200)}.`,
        'Retry the same approach, or try a different one if the error suggests the approach was wrong.',
      ].join(' ');
  }
}

// ──────────────────────────────────────────────────────────────────────
// Thinking-strip on retry
// ──────────────────────────────────────────────────────────────────────

/**
 * Strip `thinking` content blocks from every trailing stalled assistant
 * message in `messages` when the very last entry is one of our retry
 * nudges. No-op otherwise.
 *
 * Rationale: reasoning models (extended-thinking Claude, local Qwen3,
 * etc.) that stall once often stall again on the retry because the
 * provider replays the prior `thinking` block - complete with
 * `thinkingSignature` - and the model just resumes the same rumination
 * that produced no output last time. By dropping those `thinking` blocks
 * before the retry call we force a fresh reasoning pass over the new
 * (imperative) user nudge.
 *
 * Safety:
 *
 *   - We only strip from messages inside the trailing stall window
 *     (bounded by the same rules `countTrailingStalls` uses: real user
 *     prompts and healthy assistants stop the walk). Successful prior
 *     turns are never touched.
 *   - Stalled turns, by definition, emitted no text and no tool calls.
 *     Stripping their `thinking` blocks removes nothing the conversation
 *     depends on. Anthropic's `thinkingSignature` continuity is only
 *     required when the next turn responds to a `tool_use`; an empty
 *     stall has no tool_use to carry forward.
 *   - If stripping would leave an assistant message with zero content
 *     blocks (all-thinking stall), we substitute a single empty-text
 *     block so the conversation structure stays provider-valid rather
 *     than dropping the message outright (which would renumber indices
 *     the provider's cache keys off of).
 *   - Non-array `content` is left alone; we only know how to rewrite the
 *     content-parts shape.
 *
 * Operates on whatever shape the caller passes (bare `AgentMessage` or
 * session-wrapped `{ message }`) and mutates entries in place. pi's
 * `emitContext` hands handlers a `structuredClone` of the real message
 * list, so in-place mutation is the idiomatic move here - we return the
 * same array reference to make the intent explicit.
 */
export function stripThinkingFromStalledTurns<T>(messages: T[]): T[] {
  if (messages.length === 0) return messages;

  // Gate: only run when the most recent message is a stall-recovery nudge.
  const lastInner = unwrapMessage(messages[messages.length - 1]);
  if (!lastInner || typeof lastInner !== 'object') return messages;
  const lastRole = (lastInner as { role?: string }).role;
  if (lastRole !== 'user') return messages;
  const lastText = userMessageText(lastInner);
  if (!hasStallMarker(lastText)) return messages;

  // Walk the trailing stall window and rewrite each stalled assistant's
  // content. Stop at the first real user prompt or healthy assistant.
  for (let i = messages.length - 2; i >= 0; i--) {
    const raw = unwrapMessage(messages[i]);
    if (!raw || typeof raw !== 'object') continue;
    const role = (raw as { role?: string }).role;
    if (role === 'user') {
      const t = userMessageText(raw);
      if (t && hasStallMarker(t)) continue; // synthesized nudge, skip
      break; // real user input → end of window
    }
    if (role === 'assistant') {
      // Classify the assistant turn BEFORE touching its content -
      // healthy turns (text or tool call) are the boundary of the
      // trailing stall window and must not have their thinking stripped.
      const snap = snapshotFromAssistantMessage(raw);
      if (snap && classifyAssistant(snap) === null) break;
      const a = raw as { content?: unknown };
      if (!Array.isArray(a.content)) continue;
      const keep: unknown[] = [];
      let strippedAny = false;
      for (const block of a.content as unknown[]) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'thinking') {
          strippedAny = true;
          continue;
        }
        keep.push(block);
      }
      if (!strippedAny) continue;
      a.content = keep.length > 0 ? keep : [{ type: 'text', text: '' }];
      continue;
    }
    // toolResult or anything else: transparent to the walk.
  }
  return messages;
}
