/**
 * Assistant-message rendering for `/btw`.
 *
 * Pure module - no `@earendil-works/pi-ai` imports - so callers can pass
 * any structurally compatible content array.
 */

/**
 * Minimal shape of the objects inside an `AssistantMessage.content`
 * array that {@link extractAnswerText} knows how to handle. Declared
 * locally so this module has no dependency on `@earendil-works/pi-ai`.
 * Runtime shape compatibility is what counts - callers can pass the
 * real pi-ai types freely.
 */
export interface AssistantContentPart {
  type: string;
  text?: string;
}

/**
 * Extract the user-visible answer text from an assistant message's
 * content array. Keeps `text` parts, drops `thinking` parts (side
 * questions are answered in one shot; the user only cares about the
 * final answer) and `toolCall` parts (we pass `tools: []` so these
 * shouldn't appear, but if the model emits one anyway we don't want to
 * surface raw JSON).
 *
 * Consecutive text parts are joined with no separator so a model that
 * streams text in several chunks still reads naturally.
 */
export function extractAnswerText(content: readonly AssistantContentPart[] | undefined): string {
  if (!content || content.length === 0) return '';
  const out: string[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      out.push(part.text);
    }
  }
  return out.join('').trim();
}
