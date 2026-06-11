/**
 * Pure helper for cache-friendly, ephemeral "context reminder" injection.
 *
 * Background
 * ──────────
 * Several pi extensions (todo, memory, scratchpad, bg-bash) want a small
 * block of always-current state visible to the model every turn (the
 * active plan, saved memories, the scratchpad, running jobs). The
 * historical mechanism appends that block to the SYSTEM PROMPT via
 * `before_agent_start`. That works but is cache-hostile: the system
 * prompt sits at the very front of the context, so mutating it on every
 * state change busts the provider's prompt-prefix cache for the whole
 * request.
 *
 * Pi exposes a better seam: the `context` hook ("Fired before each LLM
 * call. Can modify messages."). Its handler receives a `structuredClone`
 * of the conversation and returns a replacement array that is used ONLY
 * to build that one provider payload - the persisted conversation
 * (`context.messages`) is never touched (see `agent-loop.ts`
 * `streamAssistantResponse`). So a reminder injected here is genuinely
 * EPHEMERAL: rebuilt fresh each request, never written to the session,
 * and the system prompt stays byte-stable so the prefix cache stays warm.
 *
 * This module is the generic, reusable core that any extension can drive
 * from its own `context` handler:
 *
 *   pi.on('context', (event) => ({
 *     messages: applyContextReminder(event.messages as ReminderMessage[], {
 *       id: 'todo-plan',
 *       body: formatActivePlan(state) ?? null,
 *     }) as typeof event.messages,
 *   }));
 *
 * Mechanism
 * ─────────
 * The reminder is framed as a `<system-reminder id="...">…</system-reminder>`
 * text block (the same convention Claude Code uses for its ephemeral
 * reminders) and spliced into the content of the LAST user / toolResult
 * message - i.e. the thing the assistant is about to respond to. Splicing
 * INTO an existing message (rather than appending a fresh turn) keeps the
 * role sequence valid for `convertToLlm`, which is strict about what may
 * follow a `toolResult`.
 *
 * Before splicing, any prior block carrying the same `id` is stripped
 * (`stripReminder`). Because pi's `context` output is not persisted, the
 * cloned array normally arrives pristine and this strip is a no-op - but
 * keeping it makes the function an idempotent fixpoint, lets two
 * extensions with different ids coexist, and is robust if pi ever starts
 * persisting transformed context.
 *
 * Purity
 * ──────
 * No pi imports. Operates on a duck-typed `ReminderMessage` structural
 * subset (same pattern as `verify-detect.ts`'s `BranchEntry`) so it stays
 * under the root tsconfig + vitest. The caller casts pi's `AgentMessage`
 * to/from `ReminderMessage`.
 */

// ──────────────────────────────────────────────────────────────────────
// Structural message shapes (duck-typed subset of pi's AgentMessage)
// ──────────────────────────────────────────────────────────────────────

/** A text content block. The only block kind this module creates or removes. */
export interface ReminderTextBlock {
  type: 'text';
  text: string;
}

/** Any non-text content block (image, etc.) - passed through untouched. */
export interface ReminderOtherBlock {
  type: string;
  [key: string]: unknown;
}

export type ReminderContentBlock = ReminderTextBlock | ReminderOtherBlock;

/**
 * Minimal shape we need from a message: a `role` and `content` that is
 * either a bare string (user messages can be) or an array of content
 * blocks. Extra fields (timestamp, toolName, …) are preserved via spread.
 */
export interface ReminderMessage {
  role: string;
  content: string | ReminderContentBlock[];
  [key: string]: unknown;
}

export interface ReminderSpec {
  /**
   * Stable, unique id for THIS reminder (e.g. `'todo-plan'`). Used both
   * to frame the block (`<system-reminder id="todo-plan">`) and to detect
   * the extension's own prior block for stripping. Two extensions MUST
   * use distinct ids so they only ever GC their own block.
   */
  id: string;
  /**
   * Inner reminder text to inject, or `null` / empty to inject nothing
   * (only strip any prior block of this id). Typically the output of the
   * extension's plan/state formatter.
   */
  body: string | null | undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Framing
// ──────────────────────────────────────────────────────────────────────

const TAG_OPEN_PREFIX = '<system-reminder id="';
const TAG_CLOSE = '</system-reminder>';

/** Roles a reminder may be spliced into (what the assistant responds to). */
const INJECTABLE_ROLES: ReadonlySet<string> = new Set(['user', 'toolResult']);

/** The opening tag for a given id. A block belongs to this id iff its text starts with it. */
function openTagFor(id: string): string {
  return `${TAG_OPEN_PREFIX}${id}">`;
}

/** Frame `body` as a self-identifying system-reminder text block. */
export function frameReminder(id: string, body: string): string {
  return `${openTagFor(id)}\n${body}\n${TAG_CLOSE}`;
}

/** Does this content block belong to the given reminder id? */
function isReminderBlock(block: ReminderContentBlock, id: string): boolean {
  return block.type === 'text' && typeof (block as ReminderTextBlock).text === 'string'
    ? (block as ReminderTextBlock).text.startsWith(openTagFor(id))
    : false;
}

// ──────────────────────────────────────────────────────────────────────
// Core
// ──────────────────────────────────────────────────────────────────────

/** Normalize `content` to an array of blocks (string → single text block). */
function toBlocks(content: string | ReminderContentBlock[]): ReminderContentBlock[] {
  if (typeof content === 'string') {
    // Empty string → no blocks (avoids injecting a stray empty text part).
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  return content.slice();
}

/**
 * Remove every block carrying `id` from every message. Returns a new
 * array; only messages that actually changed are rebuilt (so unchanged
 * messages keep their identity, which keeps the clone cheap and diffs
 * tight). A message whose content becomes empty after stripping keeps an
 * empty array rather than being dropped.
 */
export function stripReminder<M extends ReminderMessage>(messages: readonly M[], id: string): M[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    if (!msg.content.some((b) => isReminderBlock(b, id))) return msg;
    const content = msg.content.filter((b) => !isReminderBlock(b, id));
    return { ...msg, content } as M;
  });
}

/**
 * Strip any prior block of `spec.id`, then (when `spec.body` is non-empty)
 * splice a fresh framed reminder block onto the END of the last
 * user/toolResult message's content.
 *
 * The block goes on the LAST message, and only when that message is a
 * user/toolResult - i.e. the turn the assistant is about to answer.
 * Before a `context` call the trailing message is always one of those;
 * guarding on it (rather than scanning backwards into history) avoids
 * ever splicing a reminder into a message the assistant has already
 * responded to.
 *
 * Returns a NEW array (input is never mutated). When the trailing message
 * is not injectable, or `spec.body` is empty, only the strip is applied
 * (a no-op on pristine input).
 *
 * Deterministic: identical input + identical `spec` always yields an
 * identical result, and re-applying the same spec is a fixpoint - both
 * required so the only thing that changes the outgoing payload is a real
 * change in `body`, preserving the provider's prompt-prefix cache.
 */
export function applyContextReminder<M extends ReminderMessage>(messages: readonly M[], spec: ReminderSpec): M[] {
  const stripped = stripReminder(messages, spec.id);

  const body = spec.body?.trim();
  if (!body) return stripped;

  // Inject only into the trailing message, and only when it's the kind
  // the assistant responds to (user / toolResult).
  const target = stripped.length - 1;
  if (target < 0 || !INJECTABLE_ROLES.has(stripped[target].role)) return stripped;

  const msg = stripped[target];
  const blocks = toBlocks(msg.content);
  blocks.push({ type: 'text', text: frameReminder(spec.id, body) });

  const out = stripped.slice();
  out[target] = { ...msg, content: blocks } as M;
  return out;
}
