/**
 * Pure combine helpers for the `hooks` extension's per-event handlers.
 *
 * The sequential fire-and-short-circuit loop (which hooks run, whether
 * a `block` / `allow` stops the chain) stays in the extension shell
 * because it is tied to the async subprocess spawns. What is pure - and
 * lives here - is how the collected `additionalContext` strings fold
 * back into the tool-result content and the system prompt.
 */

/**
 * Build the tool-result content array for a PostToolUse hook chain.
 * Copies the existing `content` (when it is an array) and appends each
 * collected `additionalContext` string as a `text` part, each prefixed
 * with a leading newline. Callers only invoke this when `appended` is
 * non-empty.
 */
export function appendToolResultContext(content: unknown, appended: readonly string[]): unknown[] {
  const next = Array.isArray(content) ? content.slice() : [];
  for (const text of appended) {
    next.push({ type: 'text', text: `\n${text}` });
  }
  return next;
}

/**
 * Fold collected UserPromptSubmit `additionalContext` strings onto the
 * existing system prompt. The strings are joined with a blank line and
 * appended after a blank-line separator, unless the base system prompt
 * is empty (in which case the joined tail is returned on its own).
 * Callers only invoke this when `appended` is non-empty.
 */
export function appendSystemPromptContext(systemPrompt: string, appended: readonly string[]): string {
  const tail = appended.join('\n\n');
  return systemPrompt.length > 0 ? `${systemPrompt}\n\n${tail}` : tail;
}
