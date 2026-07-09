/**
 * Pure helper that keeps the CONVERSATION prompt-cache breakpoint off
 * volatile, reminder-bearing tail content on anthropic-style providers.
 *
 * The problem
 * ───────────
 * Anthropic-style providers cache the request prefix up to explicit
 * breakpoints. Pi places three: one on the system block, one on the last
 * tool, and one on the LAST user/toolResult message ("to cache
 * conversation history"). See
 * `packages/ai/src/api/anthropic-messages.ts` (`cache_control` on the
 * last block) and `packages/ai/src/api/bedrock-converse-stream.ts`
 * (a `cachePoint` block pushed onto the last user message).
 *
 * Several extensions (todo, scratchpad, bg-bash, context-budget,
 * roleplay) splice an EPHEMERAL `<system-reminder id="…">` block onto
 * that same last message every turn via the shared
 * `context-reminder.ts` helper. The reminder is regenerated fresh each
 * request and never persisted, so next turn that message is in history
 * WITHOUT it. Because the only conversation breakpoint sits on that
 * message, the cached prefix always ends with content the next turn no
 * longer reproduces → the conversation cache never gets a read hit.
 * `cacheRead` collapses to system+tools and the whole conversation
 * re-writes (`cacheWrite`) every turn — an O(n) cost blow-up that grows
 * with the session. (Note: it is the reminder's EPHEMERALITY, not its
 * volatility, that poisons — even a static plan collapses the read.)
 *
 * The fix: two strategies, best-first
 * ───────────────────────────────────
 * On turns where the tail carries a reminder, get the breakpoint OFF the
 * ephemeral content. Two ways, tried best-first:
 *
 *   1. AGGREGATE (primary). Pull the `<system-reminder>` block(s) out to
 *      a trailing position PAST a breakpoint placed on the tail's real
 *      content, so the real content (e.g. a large tool result) caches
 *      immediately and only the reminder rides uncached.
 *        - Anthropic: the reminder is already a sibling text block; set
 *          `cache_control` on the last NON-reminder block.
 *        - Bedrock: the reminder is nested INSIDE the toolResult content
 *          member, so un-nest it into a trailing sibling text block and
 *          insert the `cachePoint` between: `[{toolResult: real},
 *          {cachePoint}, {text: reminder}]`. This mixed shape is accepted
 *          by Bedrock Converse and caches the real prefix (validated
 *          live: a `[toolResult, cachePoint, text]` request read back the
 *          prefix a `[toolResult, cachePoint]` request had written).
 *
 *   2. RELOCATE-TO-PREV (fallback). When the tail can't be split cleanly
 *      (no real content survives extraction, or the previous step can't
 *      find a cacheable host), move the breakpoint onto the PREVIOUS user
 *      message, which is always reminder-free and byte-stable. The newest
 *      turn rides uncached and folds into the cache one turn later.
 *
 * Both strategies relocate the breakpoint off the ephemeral content, so
 * pi stays at three breakpoints (under the four-checkpoint ceiling). The
 * fix keys off the `<system-reminder` marker the shared helper emits, so
 * it covers every tail-injecting extension at once. The aggregator's win
 * is largest in sessions with a persistently-active reminder (bg-bash
 * jobs, long todo plans): there the tail is reminder-bearing every turn,
 * so relocate-to-prev's one-turn-late caching would recur each turn,
 * whereas the aggregator caches the newest real content immediately.
 *
 * Scope
 * ─────
 * Only anthropic-style payloads are touched. The style is detected from
 * the markers present on the tail: a `cachePoint` content block (Bedrock
 * Converse) or a block carrying `cache_control` (direct Anthropic).
 * Payloads with neither — e.g. OpenAI-compatible endpoints such as a
 * local llama.cpp server — are left untouched.
 *
 * Purity
 * ──────
 * No pi imports; operates on a duck-typed structural subset of the
 * provider payload. It mutates the payload IN PLACE (provider command
 * inputs are large and not cheaply cloneable, and the
 * `before_provider_request` seam expects the returned object to be the
 * wire payload). It returns a small {@link RelocateResult} describing
 * what it did, for tracing and tests.
 */

// The wire marker every <system-reminder> block carries. Sourced from
// `context-reminder.ts` (the emitter) so the detector here, the emitter,
// and the reminder-primer addendum share one literal and can't drift.
import { REMINDER_TAG_MARKER as REMINDER_MARKER } from './context-reminder.ts';
import { isRecord } from './shared/guards.ts';

/** A single content block. Duck-typed: we only read marker fields. */
export interface PayloadBlock {
  type?: unknown;
  text?: unknown;
  toolResult?: unknown;
  cachePoint?: unknown;
  cache_control?: unknown;
  [key: string]: unknown;
}

/** A provider message. `content` is a string or an array of blocks. */
export interface PayloadMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

/** The provider request payload (Anthropic Messages / Bedrock Converse). */
export interface CachePayload {
  messages?: unknown;
  [key: string]: unknown;
}

export type CacheStyle = 'bedrock' | 'anthropic';

export interface RelocateResult {
  /** Whether the payload was mutated. */
  changed: boolean;
  /** Detected cache style, when a marker was found on the tail. */
  style?: CacheStyle;
  /**
   * Short machine outcome (tracing / tests). `aggregated` = reminder
   * un-nested past a breakpoint on the real tail content; `relocated` =
   * fell back to moving the breakpoint onto the previous turn; otherwise
   * a no-op reason.
   */
  reason: string;
}

function isBlockArray(v: unknown): v is PayloadBlock[] {
  return Array.isArray(v);
}

/** Anthropic caches blocks of these types; mirror pi's own guard. */
const CACHEABLE_ANTHROPIC_TYPES: ReadonlySet<unknown> = new Set(['text', 'image', 'tool_result']);

/**
 * If `b` is a `<system-reminder>` text block, return its text; else null.
 * Handles both Anthropic blocks (`{type:'text', text}`) and Bedrock
 * content members (`{text}`, no `type`). A non-text block, or a text
 * block whose text doesn't open with the marker, returns null.
 */
function reminderTextOf(b: unknown): string | null {
  if (!isRecord(b)) return null;
  if ('type' in b && b.type !== 'text') return null;
  const t = b.text;
  if (typeof t !== 'string') return null;
  return t.trimStart().startsWith(REMINDER_MARKER) ? t : null;
}

/** Does this message's serialized content carry an ephemeral reminder? */
function carriesReminder(msg: PayloadMessage): boolean {
  try {
    return JSON.stringify(msg).includes(REMINDER_MARKER);
  } catch {
    return false;
  }
}

function lastUserIndex(messages: PayloadMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function prevUserIndex(messages: PayloadMessage[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/**
 * Normalize an Anthropic message's content to a block array. A string
 * becomes a single text block (mirrors pi's own conversion when it adds
 * cache_control to a string-content message).
 */
function normalizeAnthropicContent(content: unknown): PayloadBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return isBlockArray(content) ? content : [];
}

/**
 * Bedrock: rebuild the tail as `[…real blocks…, cachePoint, …reminder
 * text…]`. Reminder text is lifted out of `toolResult.content` members
 * and out of top-level sibling text blocks; the cachePoint pi placed is
 * reused (preserving type/ttl). Returns false (→ fallback) when no
 * reminder is found, no real content survives, or a toolResult would be
 * emptied by extraction.
 */
function aggregateBedrockTail(tail: PayloadMessage): boolean {
  if (!isBlockArray(tail.content)) return false;

  let cpTemplate: unknown;
  const reminders: PayloadBlock[] = [];
  const realBlocks: PayloadBlock[] = [];

  for (const b of tail.content) {
    if (isRecord(b) && isRecord(b.cachePoint)) {
      cpTemplate ??= b.cachePoint;
      continue;
    }
    const top = reminderTextOf(b);
    if (top !== null) {
      reminders.push({ text: top });
      continue;
    }
    if (isRecord(b) && isRecord(b.toolResult)) {
      const tr = b.toolResult as { content?: unknown };
      if (isBlockArray(tr.content)) {
        const kept: PayloadBlock[] = [];
        for (const m of tr.content) {
          const rt = reminderTextOf(m);
          if (rt !== null) reminders.push({ text: rt });
          else kept.push(m);
        }
        // Extraction must not empty the tool result (would change what
        // the tool returned); bail to the safe fallback if it would.
        if (kept.length === 0) return false;
        tr.content = kept;
      }
    }
    realBlocks.push(b);
  }

  if (reminders.length === 0 || realBlocks.length === 0) return false;

  tail.content = [...realBlocks, { cachePoint: cpTemplate ?? { type: 'default' } }, ...reminders];
  return true;
}

/**
 * Anthropic: strip `cache_control` off every block and set it on the last
 * NON-reminder block, leaving the trailing reminder block(s) uncached.
 * Returns false (→ fallback) when there is no real block, or the last
 * real block isn't a cacheable type.
 */
function aggregateAnthropicTail(tail: PayloadMessage): boolean {
  if (!isBlockArray(tail.content)) return false;
  const blocks = tail.content;

  let lastRealIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (reminderTextOf(blocks[i]) === null) lastRealIdx = i;
  }
  if (lastRealIdx < 0) return false;
  const target = blocks[lastRealIdx];
  if (!CACHEABLE_ANTHROPIC_TYPES.has(target.type)) return false;

  let template: unknown;
  for (const b of blocks) {
    if (isRecord(b) && isRecord(b.cache_control)) {
      template ??= b.cache_control;
      delete b.cache_control;
    }
  }
  target.cache_control = template ?? { type: 'ephemeral' };
  return true;
}

/**
 * Fallback: move the breakpoint from the (reminder-bearing) tail onto the
 * previous user message, which is reminder-free and byte-stable. Mutates
 * the messages in place. Transactional on the Anthropic path: never
 * strips the tail's marker unless the previous message can host it.
 */
function relocateToPrev(messages: PayloadMessage[], lastIdx: number, style: CacheStyle): RelocateResult {
  const prevIdx = prevUserIndex(messages, lastIdx);
  if (prevIdx < 0) return { changed: false, style, reason: 'no-previous-user-message' };
  const last = messages[lastIdx];
  const prev = messages[prevIdx];
  if (!isBlockArray(last.content)) return { changed: false, style, reason: 'tail-content-not-array' };
  const lastBlocks = last.content;

  if (style === 'bedrock') {
    const cpBlock = lastBlocks.find((b) => isRecord(b) && isRecord(b.cachePoint));
    if (!isBlockArray(prev.content)) return { changed: false, style, reason: 'prev-content-not-array' };
    last.content = lastBlocks.filter((b) => !(isRecord(b) && isRecord(b.cachePoint)));
    if (!prev.content.some((b) => isRecord(b) && isRecord(b.cachePoint))) {
      prev.content.push({ cachePoint: cpBlock?.cachePoint ?? { type: 'default' } });
    }
    return { changed: true, style, reason: 'relocated' };
  }

  // anthropic
  const prevContent = normalizeAnthropicContent(prev.content);
  const target = prevContent.length > 0 ? prevContent[prevContent.length - 1] : undefined;
  if (!target || !CACHEABLE_ANTHROPIC_TYPES.has(target.type)) {
    return { changed: false, style, reason: 'prev-has-no-cacheable-block' };
  }
  let template: unknown;
  for (const b of lastBlocks) {
    if (isRecord(b) && isRecord(b.cache_control)) {
      template ??= b.cache_control;
      delete b.cache_control;
    }
  }
  if (!isRecord(target.cache_control)) {
    target.cache_control = template ?? { type: 'ephemeral' };
  }
  prev.content = prevContent;
  return { changed: true, style, reason: 'relocated' };
}

/**
 * Keep the conversation cache breakpoint off the ephemeral reminder on
 * the tail message. Mutates `payload` in place. See the module header for
 * the aggregate-then-relocate strategy.
 */
export function relocateTailCacheBreakpoint(payload: unknown): RelocateResult {
  if (!isRecord(payload)) return { changed: false, reason: 'no-payload' };
  const messages = (payload as CachePayload).messages;
  if (!Array.isArray(messages) || messages.length < 2) {
    return { changed: false, reason: 'too-few-messages' };
  }
  const msgs = messages as PayloadMessage[];

  const lastIdx = lastUserIndex(msgs);
  if (lastIdx < 0) return { changed: false, reason: 'no-user-message' };

  const last = msgs[lastIdx];
  if (!isBlockArray(last.content)) return { changed: false, reason: 'tail-content-not-array' };
  const lastBlocks = last.content;

  // Detect style from the markers actually on the tail message.
  const hasCachePoint = lastBlocks.some((b) => isRecord(b) && isRecord(b.cachePoint));
  const hasCacheControl = lastBlocks.some((b) => isRecord(b) && isRecord(b.cache_control));
  const style: CacheStyle | undefined = hasCachePoint ? 'bedrock' : hasCacheControl ? 'anthropic' : undefined;
  if (!style) return { changed: false, reason: 'no-cache-marker-on-tail' };

  // Only act when the tail is volatile (carries a reminder this turn).
  if (!carriesReminder(last)) return { changed: false, style, reason: 'tail-not-volatile' };

  // 1. Primary: aggregate (un-nest the reminder past a breakpoint on the
  //    real tail content).
  const aggregated = style === 'bedrock' ? aggregateBedrockTail(last) : aggregateAnthropicTail(last);
  if (aggregated) return { changed: true, style, reason: 'aggregated' };

  // 2. Fallback: relocate the breakpoint onto the previous user message.
  return relocateToPrev(msgs, lastIdx, style);
}
