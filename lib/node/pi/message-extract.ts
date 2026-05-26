/**
 * Helpers for reaching into the loosely-typed message arrays carried on
 * `agent_end` / `message_update` events.
 *
 * The event shape varies across providers (string content vs an array
 * of content parts) and we want to handle both defensively. Two
 * extensions previously had near-identical copies of these helpers:
 *
 *   - `config/pi/extensions/todo.ts::extractLastAssistantText`
 *   - `config/pi/extensions/stream-watchdog.ts::findLastAssistant`
 *
 * Pure module - no pi imports - so it's directly unit-testable. The
 * inputs are deliberately typed as `unknown` because the runtime
 * provider payload shape isn't part of the lib's contract.
 */

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
  if (!opts.unwrapMessage) return entry as LooseMessage;
  const wrapped = entry as { message?: unknown };
  const message = wrapped.message ?? entry;
  return message && typeof message === 'object' ? (message as LooseMessage) : undefined;
}

export function extractAssistantContentText(content: unknown, opts: AssistantTextOptions = {}): string {
  const { joiner = '\n', trim = false } = opts;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
        const part = (c as { text?: string }).text;
        if (typeof part === 'string') parts.push(part);
      }
    }
    text = parts.join(joiner);
  }
  return trim ? text.trim() : text;
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
