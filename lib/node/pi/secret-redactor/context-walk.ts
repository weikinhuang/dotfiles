/**
 * Message-structure walk for the `secret-redactor` extension's `context`
 * hook. Pure - no pi imports - so the traversal that decides WHICH text
 * fields are model-bound gets its own vitest coverage, separate from the
 * `redactText` correctness suite.
 *
 * The redactor rewrites the model-bound deep copy of the conversation in
 * place: every `text` part, `thinking` part, and string `user` content is
 * passed through the injected `redact` function and overwritten when the
 * result differs. The caller supplies `redact` (a memoized `redactText`
 * wrapper) so this module stays free of the store / config.
 */

/** Redact one string, returning the (possibly unchanged) result. */
export type RedactFn = (text: string) => string;

/** Redact the `text` / `thinking` fields of a content-part array in place. */
function redactParts(parts: unknown[], redact: RedactFn): boolean {
  let changed = false;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string; thinking?: string };
    if (p.type === 'text' && typeof p.text === 'string') {
      const red = redact(p.text);
      if (red !== p.text) {
        p.text = red;
        changed = true;
      }
    } else if (p.type === 'thinking' && typeof p.thinking === 'string') {
      const red = redact(p.thinking);
      if (red !== p.thinking) {
        p.thinking = red;
        changed = true;
      }
    }
  }
  return changed;
}

/** Redact the model-bound text of a single message in place. */
function redactMessage(msg: unknown, redact: RedactFn): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { role?: string; content?: unknown };
  if (m.role === 'user') {
    if (typeof m.content === 'string') {
      const red = redact(m.content);
      if (red !== m.content) {
        m.content = red;
        return true;
      }
      return false;
    }
    if (Array.isArray(m.content)) return redactParts(m.content, redact);
    return false;
  }
  if ((m.role === 'assistant' || m.role === 'toolResult') && Array.isArray(m.content)) {
    return redactParts(m.content, redact);
  }
  return false;
}

/**
 * Redact every model-bound text field across `messages`, mutating each
 * message in place. Returns true when at least one field changed.
 */
export function redactMessages(messages: readonly unknown[], redact: RedactFn): boolean {
  let changed = false;
  for (const msg of messages) {
    if (redactMessage(msg, redact)) changed = true;
  }
  return changed;
}
