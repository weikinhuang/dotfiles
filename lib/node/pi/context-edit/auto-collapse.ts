/**
 * Pure helpers for tool-collapse: background-job heuristics + the
 * stateless auto-collapse selection.
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * Auto-collapse is intentionally derived fresh each turn rather than
 * persisted: it is a policy ("collapse big tool results once they are N
 * turns old"), not a user decision, so there is nothing to store or undo.
 * The `context` hook computes the set every call and applies it
 * transiently on top of the manual (persisted) collapses.
 */

import { byteLen } from '../shared/bytes.ts';
import { approxImageBytes, partText } from './part-bytes.ts';
import { isPlaceholder } from './placeholder.ts';
import { type LooseMessage, toParts } from './target.ts';

/** Tool names treated as fire-and-forget / background by default. */
export const DEFAULT_BACKGROUND_TOOLS = ['comfyui', 'generate_image', 'bg_bash'] as const;

export function isBackgroundTool(toolName: string | undefined, names: ReadonlySet<string>): boolean {
  return toolName !== undefined && names.has(toolName.toLowerCase());
}

function resultTextBytes(m: LooseMessage): number {
  let bytes = 0;
  for (const p of toParts(m.content)) {
    if (p.type === 'image') {
      bytes += approxImageBytes(p);
    } else {
      const t = partText(p);
      if (t && !isPlaceholder(t)) bytes += byteLen(t);
    }
  }
  return bytes;
}

export interface AutoCollapseOptions {
  /** Collapse tool results with at least this many assistant turns after them. */
  afterTurns: number;
  /** Only results at or above this many bytes. */
  minBytes: number;
}

/**
 * Select tool-call ids to auto-collapse: tool results that are both
 * `afterTurns` assistant-turns old and at least `minBytes` in size, and
 * not already a placeholder. Returns an empty array when `afterTurns <= 0`
 * (feature off). Counting assistant messages strictly AFTER a result
 * approximates "turns since this output arrived".
 */
export function selectAutoCollapse(messages: readonly LooseMessage[], opts: AutoCollapseOptions): string[] {
  if (opts.afterTurns <= 0) return [];

  // Precompute, for each index, how many assistant messages occur after it.
  const assistantAfter: number[] = Array.from({ length: messages.length }, () => 0);
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    assistantAfter[i] = count;
    if (messages[i].role === 'assistant') count++;
  }

  const ids: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'toolResult') continue;
    const id = typeof m.toolCallId === 'string' ? m.toolCallId : undefined;
    if (!id) continue;
    if (assistantAfter[i] < opts.afterTurns) continue;
    if (resultTextBytes(m) < opts.minBytes) continue;
    ids.push(id);
  }
  return ids;
}
