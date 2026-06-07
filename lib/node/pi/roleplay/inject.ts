/**
 * Pure depth-injection planning for the roleplay extension's `context`
 * event (SillyTavern "insert at depth N" / Author's Note).
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * The `context` event hands the extension a deep copy of the message
 * array before each LLM call; returning a new array replaces it for that
 * call only (non-persistent). This module decides *where* to splice
 * standing instructions: an author's note and any depth-tagged lore are
 * inserted at a configured depth counted from the end of the
 * conversation, so they ride close to the live turn and are recomputed
 * every call.
 *
 * Positioning is generic over the message type `T`: the caller supplies a
 * `makeMessage(text)` factory so this module never imports pi message
 * types.
 */

/** Default author's-note depth (messages from the end) when a persona omits one. */
export const DEFAULT_AUTHOR_NOTE_DEPTH = 4;

export interface DepthInsertion {
  /** Messages from the end: 0 = after the last message, 1 = before it, … */
  depth: number;
  text: string;
}

export interface LoreDepthChunk {
  name: string;
  body: string;
  depth: number;
}

/** Frame an author's note so the model reads it as a standing instruction. */
export function formatAuthorNote(note: string): string {
  return `[Author's note: ${note.trim()}]`;
}

/** Frame a depth-injected lore entry. */
export function formatDepthLore(name: string, body: string): string {
  return `[Lore — ${name}: ${body.trim()}]`;
}

/**
 * Build the depth insertions for a turn: one per depth-tagged lore chunk
 * plus the author's note (when present). Returns an empty array when there
 * is nothing to inject.
 */
export function buildInsertions(params: {
  authorNote?: string;
  authorNoteDepth?: number;
  lore?: readonly LoreDepthChunk[];
}): DepthInsertion[] {
  const out: DepthInsertion[] = [];
  for (const l of params.lore ?? []) {
    if (l.body.trim().length > 0) out.push({ depth: l.depth, text: formatDepthLore(l.name, l.body) });
  }
  const note = params.authorNote?.trim();
  if (note && note.length > 0) {
    out.push({ depth: params.authorNoteDepth ?? DEFAULT_AUTHOR_NOTE_DEPTH, text: formatAuthorNote(note) });
  }
  return out;
}

/**
 * Apply insertions to a message array, returning a new array. Each
 * insertion is placed before the message at index `len - depth` (clamped
 * to `[0, len]`), so depth 0 appends at the very end. Original messages
 * are never mutated or dropped. Multiple insertions at the same index
 * keep their input order.
 */
export function applyInsertions<T>(
  messages: readonly T[],
  insertions: readonly DepthInsertion[],
  makeMessage: (text: string) => T,
): T[] {
  if (insertions.length === 0) return [...messages];
  const len = messages.length;
  const byIndex = new Map<number, string[]>();
  for (const ins of insertions) {
    const idx = Math.max(0, Math.min(len, len - Math.max(0, Math.floor(ins.depth))));
    const bucket = byIndex.get(idx);
    if (bucket) bucket.push(ins.text);
    else byIndex.set(idx, [ins.text]);
  }
  const out: T[] = [];
  for (let i = 0; i <= len; i++) {
    for (const text of byIndex.get(i) ?? []) out.push(makeMessage(text));
    if (i < len) out.push(messages[i]);
  }
  return out;
}
