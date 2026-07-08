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

/**
 * Flatten one message's `content` to plain text. A string is returned
 * as-is; an array joins its text parts with `sep`; anything else yields the
 * empty string.
 */
export function messageContentToText(content: unknown, sep = '\n'): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    collectTextParts(content, parts);
    return parts.join(sep);
  }
  return '';
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
    if (typeof content === 'string') {
      parts.push(content);
    } else if (Array.isArray(content)) {
      collectTextParts(content, parts);
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
