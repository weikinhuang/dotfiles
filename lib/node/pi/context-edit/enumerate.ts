/**
 * Build the ranked candidate list that powers the context-edit commands'
 * autocomplete and bare-command listings.
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * The extension shells call `enumerate(messages, opts)` with the resolved
 * LLM message list (from `sessionManager.buildSessionContext().messages`,
 * which is the same shape the `context` hook sees). Each candidate names
 * a trimmable / editable / collapsible piece of content with a stable
 * `Target` (or `toolCallId`), a short label, a one-line snippet, and a
 * size estimate so the heaviest items sort first.
 *
 * Candidate ids are short, human-typeable handles (`img1`, `tool3`,
 * `msg2`) assigned per-enumeration. They are NOT stable across turns -
 * they're for the interactive pick. The directive that gets stored keys
 * off the resolved `Target` / `toolCallId`, which IS stable.
 */

import { byteLen, formatCompactBytes } from '../shared/bytes.ts';
import { collapseWhitespace, truncate } from '../shared/strings.ts';
import { countLines, isPlaceholder } from './placeholder.ts';
import { type LooseMessage, type LoosePart, type Target, toParts } from './target.ts';

export type CandidateKind = 'image' | 'tool-result' | 'tool-call' | 'message';

export interface Candidate {
  /** Short typeable handle for this enumeration (`img1`, `tool3`, `msg2`). */
  id: string;
  /**
   * Document-order position (0-based) in which this candidate was
   * encountered while walking the message list, newest = highest. The
   * output array is re-sorted heaviest-first, so `seq` is the only
   * surviving record of recency; agent-drop recency-ordinal addressing
   * (`lib/node/pi/context-edit/agent-drop.ts`) keys off it.
   */
  seq: number;
  kind: CandidateKind;
  /** Stable target for trim/edit candidates. */
  target?: Target;
  /** Stable id for tool-call / tool-result candidates. */
  toolCallId?: string;
  toolName?: string;
  role?: string;
  /** Estimated byte weight, used for ranking + display. */
  bytes: number;
  /** Line count for text parts (0 for images). */
  lines: number;
  /** One-line preview. */
  snippet: string;
}

export interface EnumerateOptions {
  /** Minimum byte size for a text part / tool result to be listed (default 2048). */
  minTextBytes?: number;
  /** Snippet character cap (default 80). */
  snippetChars?: number;
  /**
   * Listing order. `size` (default) ranks heaviest-first - right for
   * trim/collapse where you target the bulkiest content. `order` keeps
   * document order (oldest-first), which reads naturally when editing a
   * message for steering.
   */
  sort?: 'size' | 'order';
}

const DEFAULT_MIN_TEXT_BYTES = 2048;
const DEFAULT_SNIPPET_CHARS = 80;

function partText(part: LoosePart): string {
  return part.type === 'text' && typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text
    : '';
}

function approxImageBytes(part: LoosePart): number {
  const data = (part as { data?: unknown }).data;
  return typeof data === 'string' ? Math.floor((data.length * 3) / 4) : 0;
}

function snippetOf(text: string, chars: number): string {
  return truncate(collapseWhitespace(text), chars);
}

/**
 * Enumerate trimmable / editable / collapsible content across the message
 * list, ranked heaviest-first. The `occurrence` counter disambiguates the
 * rare two-messages-same-role-same-timestamp case so the emitted target
 * resolves back to exactly the message we saw.
 */
export function enumerate(messages: readonly LooseMessage[], opts: EnumerateOptions = {}): Candidate[] {
  const minTextBytes = opts.minTextBytes ?? DEFAULT_MIN_TEXT_BYTES;
  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET_CHARS;

  const out: Candidate[] = [];
  let imgN = 0;
  let toolN = 0;
  let msgN = 0;
  let seq = 0;
  const nextSeq = (): number => seq++;

  // Track (role,timestamp) occurrences to build stable message targets.
  const occ = new Map<string, number>();
  const nextOccurrence = (role: string, ts: number): number => {
    const key = `${role}:${ts}`;
    const n = occ.get(key) ?? 0;
    occ.set(key, n + 1);
    return n;
  };

  for (const m of messages) {
    const parts = toParts(m.content);

    if (m.role === 'toolResult') {
      const toolCallId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined;
      // Images inside a tool result (e.g. comfyui output) are their own candidates.
      let textBytes = 0;
      let textLines = 0;
      let firstText = '';
      let imageCount = 0;
      let imageBytes = 0;
      for (const p of parts) {
        if (p.type === 'image') {
          imageCount++;
          imageBytes += approxImageBytes(p);
        } else {
          const t = partText(p);
          if (isPlaceholder(t)) continue;
          textBytes += byteLen(t);
          textLines += countLines(t);
          if (!firstText) firstText = t;
        }
      }
      if (imageCount > 0 && toolCallId) {
        out.push({
          id: `img${++imgN}`,
          seq: nextSeq(),
          kind: 'image',
          target: { by: 'toolCallId', toolCallId },
          toolCallId,
          toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
          role: m.role,
          bytes: imageBytes,
          lines: 0,
          snippet: `${imageCount} image${imageCount === 1 ? '' : 's'} from ${m.toolName ?? 'tool'}`,
        });
      }
      if (toolCallId && textBytes >= minTextBytes) {
        out.push({
          id: `tool${++toolN}`,
          seq: nextSeq(),
          kind: 'tool-result',
          target: { by: 'toolCallId', toolCallId },
          toolCallId,
          toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
          role: m.role,
          bytes: textBytes,
          lines: textLines,
          snippet: snippetOf(firstText, snippetChars),
        });
      }
      continue;
    }

    if (m.role === 'assistant') {
      // Tool calls (collapsible). Each toolCall part is a candidate.
      for (const p of parts) {
        if (p.type === 'toolCall') {
          const id = typeof (p as { id?: unknown }).id === 'string' ? (p as { id: string }).id : undefined;
          if (!id) continue;
          const name = typeof (p as { name?: unknown }).name === 'string' ? (p as { name: string }).name : undefined;
          const args = (p as { arguments?: unknown }).arguments;
          const argBytes = args ? byteLen(JSON.stringify(args)) : 0;
          out.push({
            id: `call${++toolN}`,
            seq: nextSeq(),
            kind: 'tool-call',
            toolCallId: id,
            toolName: name,
            role: m.role,
            bytes: argBytes,
            lines: 0,
            snippet: snippetOf(`${name ?? 'tool'} ${args ? JSON.stringify(args) : ''}`, snippetChars),
          });
        }
      }
    }

    // User / assistant text messages (editable + trimmable-by-snippet).
    if (m.role === 'user' || m.role === 'assistant') {
      const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
      const occurrence = nextOccurrence(m.role, ts);
      let text = '';
      for (const p of parts) {
        const t = partText(p);
        if (!isPlaceholder(t)) text += (text ? '\n' : '') + t;
      }
      if (text.trim().length === 0) continue;
      out.push({
        id: `msg${++msgN}`,
        seq: nextSeq(),
        kind: 'message',
        target: { by: 'message', role: m.role, timestamp: ts, occurrence },
        role: m.role,
        bytes: byteLen(text),
        lines: countLines(text),
        snippet: snippetOf(text, snippetChars),
      });
    }
  }

  // `out` is already in document (encounter) order, so `order` returns it
  // as-is. `size` (default) ranks heaviest-first, stable for equal weights
  // by keeping insertion order.
  if ((opts.sort ?? 'size') === 'order') return out;
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.bytes - a.c.bytes || a.i - b.i)
    .map(({ c }) => c);
}

/** Human label for a candidate, used in listings + completion descriptions. */
export function candidateLabel(c: Candidate): string {
  const size = c.bytes > 0 ? formatCompactBytes(c.bytes) : '';
  const lineInfo = c.lines > 0 ? `${c.lines}L` : '';
  const meta = [lineInfo, size].filter(Boolean).join(' ');
  const head =
    c.kind === 'image'
      ? 'image'
      : c.kind === 'tool-result'
        ? `result ${c.toolName ?? ''}`.trim()
        : c.kind === 'tool-call'
          ? `call ${c.toolName ?? ''}`.trim()
          : `${c.role} msg`;
  return `${head}${meta ? ` (${meta})` : ''}: ${c.snippet}`;
}
