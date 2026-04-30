/**
 * Pure helpers for the stall-recovery extension.
 *
 * No pi imports so this module can be unit-tested under plain `node --test`
 * without the pi runtime.
 *
 * The extension's job is to detect when an agent turn ended without
 * producing meaningful work — either because the model stopped silently
 * (common with weaker local models and with reasoning models whose
 * "thinking" phase completes without emitting content) or because the
 * provider/transport errored out — and fire a follow-up nudge that pokes
 * the agent loop into another turn. The classifier here decides whether
 * a turn looks stalled; the extension handles budget, UI, and delivery.
 *
 * Detection is deliberately conservative: we only fire on two unambiguous
 * signals, `empty` (no text + no tool calls) and `error` (explicit error
 * field somewhere on the turn). Hedging / punting detection was considered
 * and rejected — the false-positive rate would be too high, and the todo
 * extension's completion-claim guardrail catches a related case ("claimed
 * done but didn't deliver") from a separate angle. The two extensions are
 * orthogonal and compose naturally.
 */

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
}

/**
 * Classify an assistant turn snapshot as a stall (returning a reason) or
 * normal (returning `null`). Order of checks matters: errors win over
 * emptiness so the retry message can surface the specific failure.
 */
export function classifyAssistant(snap: AssistantSnapshot): StallReason | null {
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
 * defensively — provider adapters vary, and we'd rather under-fire than
 * throw.
 *
 * Returns `null` if the input isn't recognizably an assistant message;
 * callers use that to skip entries cleanly.
 */
export function snapshotFromAssistantMessage(message: unknown): AssistantSnapshot | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { role?: string; content?: unknown; error?: unknown };
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

  const error = typeof m.error === 'string' ? m.error : undefined;

  return { text, toolCallCount, error };
}

/**
 * Pull the last assistant snapshot from a sequence of turn messages. The
 * `agent_end` event carries `event.messages` which includes the user
 * prompt, every assistant/toolResult cycle, and any errors along the way.
 * We only care about the FINAL assistant message — that's the one that
 * either produced work (good) or stalled (bad).
 *
 * Returns `null` if the sequence contains no assistant message at all
 * (degenerate input; skip detection).
 */
export function lastAssistantSnapshot(messages: readonly unknown[]): AssistantSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const snap = snapshotFromAssistantMessage((messages[i] as { message?: unknown })?.message ?? messages[i]);
    if (snap) return snap;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Retry-message builder
// ──────────────────────────────────────────────────────────────────────

/** Sentinel prefix identifying messages this extension synthesized. */
export const STALL_MARKER = '⟳ [pi-stall-recovery]';

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Build the follow-up user message injected into the session to kick the
 * agent into another turn. Carries the sentinel so the extension can
 * detect its own prior injections and enforce the retry budget.
 *
 * Messages are short and directive by design — weaker models benefit from
 * concrete instructions ("continue where you left off") over vague ones
 * ("please continue").
 */
export function buildRetryMessage(reason: StallReason, attempt: number, maxAttempts: number): string {
  const budget = `(${attempt}/${maxAttempts})`;
  switch (reason.kind) {
    case 'empty':
      return [
        STALL_MARKER,
        budget,
        'Your previous turn produced no output. The task is not complete. Continue where you left off —',
        'review any active todos, check the last tool result if there was one, and produce either the',
        'next tool call or the final answer for the user.',
      ].join(' ');
    case 'error':
      return [
        STALL_MARKER,
        budget,
        `Your previous turn failed with: ${truncate(reason.error, 200)}.`,
        'Retry the same approach, or try a different one if the error suggests the approach was wrong.',
      ].join(' ');
  }
}

/**
 * Detect whether `text` already carries our sentinel. Used both to skip
 * re-firing on our own injected messages and to count prior retries in
 * the branch when recovering after a reload.
 */
export function hasStallMarker(text: string): boolean {
  return text.includes(STALL_MARKER);
}
