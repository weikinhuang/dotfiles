/**
 * Shared text extraction from pi message / session-entry content.
 *
 * Several extensions independently walk message `content` (a string, or an
 * array of `{ type: 'text', text }` parts) to pull out plain text for
 * scanning: roleplay's depth-lore / repetition scanners and the
 * waveform-indicator's prompt digest. These helpers centralise the walk so
 * the pattern lives in one tested place instead of being re-copied per
 * extension.
 *
 * Pure module - no pi imports. Inputs are typed loosely (`unknown`) so
 * callers can pass pi's message / entry objects without importing the pi
 * runtime here.
 */

/** Append the text of every `{ type: 'text', text }` part in `content` to `out`. */
function collectTextParts(content: readonly unknown[], out: string[]): void {
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') out.push(text);
    }
  }
}

/** Options for {@link extractContentText}. */
export interface ContentTextOptions {
  /** Separator joining array text parts. Defaults to a newline. */
  sep?: string;
  /** Trim the final result. Defaults to `false`. */
  trim?: boolean;
}

/**
 * Canonical `content -> plain text` core. A string is returned as-is; an
 * array joins its `{ type: 'text', text }` parts with `sep` (default `'\n'`),
 * dropping any part that is not a text part or whose `text` is not a string;
 * anything else yields the empty string. The result is trimmed when
 * `trim` is set.
 *
 * All the message-text and message-extract helpers funnel through here so the
 * walk lives in one tested place.
 */
export function extractContentText(content: unknown, opts: ContentTextOptions = {}): string {
  const sep = opts.sep ?? '\n';
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    collectTextParts(content, parts);
    text = parts.join(sep);
  }
  return opts.trim ? text.trim() : text;
}

/**
 * Flatten one message's `content` to plain text. A string is returned
 * as-is; an array joins its text parts with `sep`; anything else yields the
 * empty string. Thin wrapper over {@link extractContentText}.
 */
export function messageContentToText(content: unknown, sep = '\n'): string {
  return extractContentText(content, { sep });
}

/**
 * Concatenate the text of the last `n` messages (any role) into one string,
 * joined by `sep`. Used for depth-lore keyword scanning over the recent
 * window.
 */
export function concatRecentMessageText(messages: readonly unknown[], n: number, sep = '\n'): string {
  const parts: string[] = [];
  for (const m of messages.slice(-Math.max(1, n))) {
    const content = (m as { content?: unknown }).content;
    // Route each message's content through the canonical extractor; skip
    // messages whose content is neither a string nor a parts array so a
    // non-text message doesn't contribute a spurious empty separator.
    if (typeof content === 'string' || Array.isArray(content)) {
      parts.push(extractContentText(content, { sep }));
    }
  }
  return parts.join(sep);
}

/**
 * Collect the text of the last `window` messages matching `role` (each
 * message's text as one entry). Empty messages are skipped. Used for
 * repetition / anti-slop scanning over recent assistant replies.
 */
export function collectRoleMessageTexts(
  messages: readonly unknown[],
  opts: { role: string; window: number },
): string[] {
  const texts: string[] = [];
  for (const m of messages) {
    if ((m as { role?: unknown }).role !== opts.role) continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === 'string') {
      if (content.trim().length > 0) texts.push(content);
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      collectTextParts(content, parts);
      if (parts.length > 0) texts.push(parts.join('\n'));
    }
  }
  return texts.slice(-Math.max(1, opts.window));
}

/**
 * Walk session entries backward and return the text of the most recent
 * `message` entry matching `role` (default `user`), joining array text parts
 * with `sep` (default a single space). Entries whose content is neither a
 * string nor an array are skipped so the scan continues to an earlier match.
 * Returns the empty string when no match exists.
 */
export function latestMessageTextFromEntries(
  entries: readonly { type?: string; message?: unknown }[],
  opts: { role?: string; sep?: string } = {},
): string {
  const role = opts.role ?? 'user';
  const sep = opts.sep ?? ' ';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'message') continue;
    const msg = e.message as { role?: string; content?: unknown } | undefined;
    if (msg?.role !== role) continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      collectTextParts(content, parts);
      return parts.join(sep);
    }
    // Content neither string nor array: keep scanning earlier entries.
  }
  return '';
}

// ──────────────────────────────────────────────────────────────────────
// Assistant-message navigation
//
// Helpers for reaching into the loosely-typed message arrays carried on
// `agent_end` / `message_update` events. The event shape varies across
// providers (string content vs an array of content parts) and we handle
// both defensively. Inputs are typed as `unknown` because the runtime
// provider payload shape isn't part of the lib's contract.
// ──────────────────────────────────────────────────────────────────────

/**
 * Loose duck-type describing the fields we touch on a pi message. Real
 * messages carry more, but the lib never trusts that.
 */
export interface LooseMessage {
  readonly role?: string;
  readonly stopReason?: string;
  readonly content?: unknown;
}

export interface FindLastAssistantMessageOptions {
  unwrapMessage?: boolean;
}

export interface AssistantTextOptions {
  joiner?: string;
  trim?: boolean;
}

export interface ExtractLastAssistantTextOptions extends FindLastAssistantMessageOptions, AssistantTextOptions {
  stopOnAborted?: boolean;
}

function unwrapMessageEntry(entry: unknown, opts: FindLastAssistantMessageOptions): LooseMessage | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  if (!opts.unwrapMessage) return entry;
  const wrapped = entry as { message?: unknown };
  const message = wrapped.message ?? entry;
  return message && typeof message === 'object' ? message : undefined;
}

export function extractAssistantContentText(content: unknown, opts: AssistantTextOptions = {}): string {
  return extractContentText(content, { sep: opts.joiner, trim: opts.trim });
}

export function extractAssistantMessageText(msg: LooseMessage | undefined, opts: AssistantTextOptions = {}): string {
  if (!msg) return '';
  return extractAssistantContentText(msg.content, opts);
}

/**
 * Walk `messages` backwards and return the most recent message whose
 * `role === 'assistant'`. Returns `undefined` for an empty / missing
 * array or when no assistant message is found.
 */
export function findLastAssistantMessage(
  messages: readonly unknown[] | undefined,
  opts: FindLastAssistantMessageOptions = {},
): LooseMessage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = unwrapMessageEntry(messages[i], opts);
    if (msg?.role === 'assistant') return msg;
  }
  return undefined;
}

/**
 * Pull the visible text out of the last assistant message in
 * `messages`. Handles both string content and the content-part array
 * shape; non-text parts (tool calls, images, etc.) are skipped. Falls
 * back to the empty string when no assistant message is present or its
 * content is in an unrecognized form.
 */
export function extractLastAssistantText(
  messages: readonly unknown[] | undefined,
  opts: ExtractLastAssistantTextOptions = {},
): string {
  const msg = findLastAssistantMessage(messages, opts);
  if (!msg) return '';
  if (opts.stopOnAborted && msg.stopReason === 'aborted') return '';
  return extractAssistantMessageText(msg, opts);
}
