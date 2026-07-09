/**
 * Pure token/turn/tool aggregation for the statusline footer.
 *
 * Extracted from `config/pi/extensions/statusline.ts` so the reduction
 * of `ctx.sessionManager.getBranch()` into the display model is
 * unit-testable without the pi runtime. Structural (duck-typed) shapes
 * are declared locally instead of importing `@earendil-works/pi-ai`
 * message types so the module stays pure per `lib/node/pi/AGENTS.md`;
 * only the fields the aggregation reads are described.
 */

import { byteLen } from '../shared.ts';

/** Usage block on an assistant message (all fields optional per provider). */
interface UsageLike {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  cost?: { total?: number };
}

/** A content part on an assistant / toolResult message. */
interface ContentLike {
  type?: string;
  text?: string;
}

interface AssistantMessageLike {
  role?: string;
  usage?: UsageLike;
  content: ContentLike[];
}

interface ToolResultMessageLike {
  role?: string;
  content?: ContentLike[];
}

/** The reduced numbers the footer renders. */
export interface Aggregates {
  sessionIn: number;
  sessionCacheRead: number;
  sessionCacheWrite: number;
  sessionOut: number;
  sessionCostTotal: number;
  turns: number;
  lastIn: number;
  lastCacheRead: number;
  lastCacheWrite: number;
  lastOut: number;
  toolCalls: number;
  /** Total UTF-8 byte length of tool-result text parts across the branch. */
  toolResultBytes: number;
}

/**
 * Reduce a session branch (array of message entries) into the footer's
 * display aggregates. Accepts `unknown` and bails to a zeroed result on
 * a non-array so a malformed session manager surfaces as empty rather
 * than a silent no-op.
 */
export function aggregate(branch: unknown): Aggregates {
  const out: Aggregates = {
    sessionIn: 0,
    sessionCacheRead: 0,
    sessionCacheWrite: 0,
    sessionOut: 0,
    sessionCostTotal: 0,
    turns: 0,
    lastIn: 0,
    lastCacheRead: 0,
    lastCacheWrite: 0,
    lastOut: 0,
    toolCalls: 0,
    toolResultBytes: 0,
  };

  // Defensive guard: if pi's session manager ever returns a non-iterable,
  // a silent `for...of` no-op would mask the problem. Bail explicitly.
  if (!Array.isArray(branch)) return out;

  for (const rawEntry of branch) {
    const entry = rawEntry as { type?: string; message?: { role?: string } };
    if (entry?.type !== 'message' || !entry.message) continue;

    if (entry.message.role === 'assistant') {
      const m = entry.message as AssistantMessageLike;
      const u = m.usage;
      if (u) {
        out.sessionIn += u.input ?? 0;
        out.sessionCacheRead += u.cacheRead ?? 0;
        out.sessionCacheWrite += u.cacheWrite ?? 0;
        out.sessionOut += u.output ?? 0;
        out.sessionCostTotal += u.cost?.total ?? 0;
        out.lastIn = u.input ?? 0;
        out.lastCacheRead = u.cacheRead ?? 0;
        out.lastCacheWrite = u.cacheWrite ?? 0;
        out.lastOut = u.output ?? 0;
      }
      for (const c of m.content) if (c.type === 'toolCall') out.toolCalls++;
    } else if (entry.message.role === 'user') {
      // Turns = user prompts submitted (matches M(N) semantics in the bash script,
      // which counts user-authored turns).
      out.turns++;
    } else if (entry.message.role === 'toolResult') {
      const m = entry.message as ToolResultMessageLike;
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          // Real UTF-8 byte length, not UTF-16 code-unit count, so a
          // multibyte tool result is sized honestly for the footer estimate.
          if (c.type === 'text' && c.text !== undefined) out.toolResultBytes += byteLen(c.text);
        }
      }
    }
  }

  return out;
}
