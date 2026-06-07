/**
 * Addressing + resolution for context-edit directives.
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * A `Target` names a piece of content inside the resolved LLM message
 * list (the same `AgentMessage[]` the `context` hook receives). Two
 * addressing schemes cover everything pi can put in context:
 *
 *   - `toolCallId` - a tool call and its paired tool result share a
 *     stable `toolCallId`. Used for tool-result content (the `read` /
 *     `bash` / `comfyui` outputs) and for collapsing a call+result pair.
 *     An optional `partIndex` pins one content part of the tool result.
 *
 *   - `message` - user / assistant messages carry no id, only a
 *     millisecond `timestamp`. We key on `(role, timestamp)` with an
 *     optional `partIndex` for one content part. The rare same-ms
 *     collision is disambiguated by `occurrence` (the Nth message with
 *     that exact role+timestamp, in branch order).
 *
 * Targets are resolved fresh every turn against the live message list,
 * so a directive whose target no longer matches (compaction dropped it,
 * a branch switched away) simply becomes a no-op the caller can report
 * as "stale" rather than throwing.
 */

/** Minimal duck-typed content parts - we never import pi's AI types here. */
export interface LooseTextPart {
  type: 'text';
  text: string;
  [k: string]: unknown;
}
export interface LooseImagePart {
  type: 'image';
  data: string;
  mimeType: string;
  [k: string]: unknown;
}
export interface LooseToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  [k: string]: unknown;
}
export type LoosePart = LooseTextPart | LooseImagePart | LooseToolCallPart | { type: string; [k: string]: unknown };

/** Minimal duck-typed message - mirrors pi's `Message` union shape. `role` is
 * one of `user` / `assistant` / `toolResult` (plus any future pi role). */
export interface LooseMessage {
  role: string;
  content: string | LoosePart[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  [k: string]: unknown;
}

export type Target =
  | { by: 'toolCallId'; toolCallId: string; partIndex?: number }
  | { by: 'message'; role: 'user' | 'assistant'; timestamp: number; partIndex?: number; occurrence?: number };

/**
 * Canonical string for a target, used for equality (e.g. marking a
 * candidate "already trimmed" or looking up a directive to restore).
 * A missing `partIndex` is encoded as `*` so a whole-message target and
 * a part-scoped target never collide.
 */
export function targetKey(target: Target): string {
  if (target.by === 'toolCallId') {
    return `tc:${target.toolCallId}:${target.partIndex ?? '*'}`;
  }
  return `msg:${target.role}:${target.timestamp}:${target.occurrence ?? 0}:${target.partIndex ?? '*'}`;
}

export function targetsEqual(a: Target, b: Target): boolean {
  return targetKey(a) === targetKey(b);
}

/** Normalize a message's content to an array of parts (string -> single text part). */
export function toParts(content: string | LoosePart[]): LoosePart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  // pi can hand us a message whose `content` is neither string nor array
  // (e.g. null on a tool-call-only assistant message). Treat as empty.
  return Array.isArray(content) ? content : [];
}

/** A resolved hit: the message index in the list, plus the part index when the target was part-scoped. */
export interface ResolvedTarget {
  messageIndex: number;
  partIndex?: number;
}

/**
 * Resolve a `message`-addressed target to its index in `messages`.
 * `occurrence` selects among messages sharing the exact role+timestamp
 * (0 = first in branch order). Returns null when nothing matches.
 */
function resolveMessageTarget(
  messages: readonly LooseMessage[],
  target: Extract<Target, { by: 'message' }>,
): ResolvedTarget | null {
  let seen = 0;
  const want = target.occurrence ?? 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== target.role) continue;
    if (m.timestamp !== target.timestamp) continue;
    if (seen === want) return { messageIndex: i, partIndex: target.partIndex };
    seen++;
  }
  return null;
}

/**
 * Resolve a `toolCallId`-addressed target. A tool *result* message
 * carries `toolCallId` directly; this resolves to that result message
 * (the bulky payload). Returns null when no result with that id exists
 * in the list.
 */
function resolveToolResultTarget(
  messages: readonly LooseMessage[],
  target: Extract<Target, { by: 'toolCallId' }>,
): ResolvedTarget | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'toolResult' && m.toolCallId === target.toolCallId) {
      return { messageIndex: i, partIndex: target.partIndex };
    }
  }
  return null;
}

/** Resolve any target to a `{ messageIndex, partIndex? }`, or null when it no longer matches. */
export function resolveTarget(messages: readonly LooseMessage[], target: Target): ResolvedTarget | null {
  return target.by === 'toolCallId'
    ? resolveToolResultTarget(messages, target)
    : resolveMessageTarget(messages, target);
}

/**
 * Find the assistant message + part index holding the `toolCall` whose
 * id is `toolCallId`. Used by collapse to blank the call's arguments
 * while keeping the call/result pairing intact. Returns null when the
 * call isn't present (e.g. compacted away).
 */
export function findToolCall(
  messages: readonly LooseMessage[],
  toolCallId: string,
): { messageIndex: number; partIndex: number } | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const parts = toParts(m.content);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part.type === 'toolCall' && (part as LooseToolCallPart).id === toolCallId) {
        return { messageIndex: i, partIndex: p };
      }
    }
  }
  return null;
}
