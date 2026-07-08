/**
 * Message content transforms for the `color-tags` extension.
 *
 * Two pure operations:
 *   - {@link applyToMessage} rewrites `[c:NAME]…[/c]` tags to ANSI in
 *     an assistant message's text / thinking parts, IN PLACE (pi reads
 *     the same content-array reference during render, so the in-place
 *     mutation is what makes colors show up live).
 *   - {@link scrubContextMessages} strips ANSI SGR bytes back out of
 *     outgoing assistant history before the next provider request, so
 *     the model never sees its own past `\x1b[…m` output. It copies
 *     rather than mutates, and only allocates when something changed.
 *
 * Pure module - no pi imports. The content shapes are narrowed to the
 * two fields these transforms touch.
 */

import { type ColorResolver, rewriteColorTags } from './parse-color-tags.ts';
import { ESC } from './resolve-color.ts';
import { stripAnsi } from './strip-ansi.ts';

/**
 * Minimal shape of an assistant content part we mutate. Mirrors
 * `TextContent` / `ThinkingContent` from `@earendil-works/pi-ai` but
 * narrowed to the two fields we actually touch.
 */
export interface MutableContentPart {
  type?: string;
  text?: string;
  thinking?: string;
}

export interface MutableMessage {
  role?: string;
  content?: MutableContentPart[];
}

export interface MutableContextMessage {
  role?: string;
  content?: MutableContentPart[];
}

/**
 * Mutate text / thinking content parts in `message` in place. Pi reads
 * the same content array reference from `event.message.content` during
 * render, so an in-place mutation is what makes the colors show up live.
 */
export function applyToMessage(message: MutableMessage, resolver: ColorResolver): void {
  if (message.role !== 'assistant') return;
  const parts = message.content;
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text.length > 0) {
      part.text = rewriteColorTags(part.text, resolver, { streaming: true });
    }
    if (typeof part.thinking === 'string' && part.thinking.length > 0) {
      part.thinking = rewriteColorTags(part.thinking, resolver, { streaming: true });
    }
  }
}

/**
 * Belt-and-suspenders ANSI scrub for outgoing context messages. Only
 * touches assistant parts that contain `\x1b` and only allocates a
 * new message when something actually changed.
 *
 * `Object.assign({}, ...)` instead of object spread to satisfy
 * oxlint's `oxc(no-map-spread)` rule.
 */
export function scrubContextMessages(
  messages: MutableContextMessage[],
): { messages: MutableContextMessage[] } | undefined {
  let outerMutated = false;
  const next = messages.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return m;
    let partsMutated = false;
    const newContent = m.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const newPart: MutableContentPart = Object.assign({}, part);
      if (typeof part.text === 'string' && part.text.includes(ESC)) {
        newPart.text = stripAnsi(part.text);
        partsMutated = true;
      }
      if (typeof part.thinking === 'string' && part.thinking.includes(ESC)) {
        newPart.thinking = stripAnsi(part.thinking);
        partsMutated = true;
      }
      return newPart;
    });
    if (partsMutated) {
      outerMutated = true;
      return Object.assign({}, m, { content: newContent });
    }
    return m;
  });
  return outerMutated ? { messages: next } : undefined;
}
