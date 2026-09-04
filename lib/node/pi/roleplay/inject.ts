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
 *
 * Two delivery shapes
 * ───────────────────
 * 1. STANDALONE MESSAGES (default, {@link applyInsertions}). Every
 *    insertion becomes its own `user`-role message spliced at its depth.
 *    Depth 0 therefore lands as N instruction-only user turns AFTER the
 *    user's real message, so the model's immediate stimulus before
 *    generation is a stack of standing instructions with the actual user
 *    message several turns back. On a chat template with no mid-conversation
 *    system role that can read as an instruction handoff to acknowledge
 *    (measured: compliance preambles naming an injected depth-0 record).
 * 2. MERGED TAIL BLOCK (opt-in, {@link planDepthTailMerge}). Everything that
 *    resolves to depth 0 is concatenated, in the same order, into ONE block
 *    which the caller splices onto the END of the trailing user /
 *    toolResult message's content instead of appending messages. The
 *    per-insertion framing is unchanged, so the text the model reads is
 *    byte-identical; only the message structure differs. Depth > 0 always
 *    keeps shape 1.
 *
 * Shape 2 is a real behavior change (a different position in the rendered
 * template, and the caller typically frames the block as a
 * `<system-reminder>`), so it is gated behind an opt-in config flag and
 * shape 1 stays the default.
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

/** Normalized depth used for positioning: negatives and fractions collapse the way {@link applyInsertions} clamps them. */
function normalizeDepth(depth: number): number {
  return Math.max(0, Math.floor(depth));
}

/** Blank line between the merged depth-0 parts, so each keeps its own paragraph. */
const TAIL_BLOCK_SEPARATOR = '\n\n';

export interface DepthTailMergePlan {
  /** Insertions that keep the standalone-message path (normalized depth > 0), in input order. */
  insertions: DepthInsertion[];
  /** The merged depth-0 text for the trailing message, or `null` when nothing resolves to depth 0. */
  tailBlock: string | null;
}

/**
 * Split {@link buildInsertions} output into the depth > 0 remainder (which
 * still goes through {@link applyInsertions} unchanged) and a single merged
 * block for everything at depth 0.
 *
 * Input order is preserved on both sides, so the merged block reads lore
 * first and an author's note whose resolved depth is 0 last, exactly the
 * order the standalone path emits today. Purely a repartition: no text is
 * added, dropped, or rewritten, so any upstream macro substitution and
 * budget selection still bound the result.
 */
export function planDepthTailMerge(insertions: readonly DepthInsertion[]): DepthTailMergePlan {
  const rest: DepthInsertion[] = [];
  const tail: string[] = [];
  for (const ins of insertions) {
    if (normalizeDepth(ins.depth) === 0) tail.push(ins.text);
    else rest.push(ins);
  }
  return { insertions: rest, tailBlock: tail.length > 0 ? tail.join(TAIL_BLOCK_SEPARATOR) : null };
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
    const idx = Math.max(0, Math.min(len, len - normalizeDepth(ins.depth)));
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
