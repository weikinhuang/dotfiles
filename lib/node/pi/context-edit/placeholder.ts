/**
 * Placeholder builders for context-edit overlays.
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * When a directive removes content from context we replace it with a
 * short, self-explaining marker so the model understands the gap was
 * intentional (and reversible) rather than silently losing data. The
 * markers carry a savings annotation in the same spirit as
 * `tool-output-condenser`'s banner, so a reader can see what was dropped.
 */

import { byteLen, formatCompactBytes } from '../shared/bytes.ts';

const MARKER = '⟨pi-context-edit⟩';

function withReason(base: string, reason: string | undefined): string {
  const r = reason?.trim();
  return r ? `${base} - ${r}` : base;
}

/** Count newline-delimited lines in `text` (0 for empty). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (const ch of text) {
    if (ch === '\n') n++;
  }
  return n;
}

/** Placeholder for a trimmed image part. */
export function imagePlaceholder(reason: string | undefined, approxBytes?: number): string {
  const size = approxBytes && approxBytes > 0 ? ` (~${formatCompactBytes(approxBytes)})` : '';
  return `${MARKER} ${withReason(`[IMAGE REMOVED${size}]`, reason)}`;
}

/** Placeholder for a trimmed text part - notes how much was dropped. */
export function textPlaceholder(original: string, reason: string | undefined): string {
  const lines = countLines(original);
  const bytes = byteLen(original);
  const stat = `${lines} line${lines === 1 ? '' : 's'}, ${formatCompactBytes(bytes)}`;
  return `${MARKER} ${withReason(`[CONTENT TRIMMED - ${stat}]`, reason)}`;
}

/** Placeholder for a collapsed tool call + result pair. */
export function collapsePlaceholder(toolName: string | undefined, reason: string | undefined): string {
  const name = toolName?.trim() ? ` ${toolName.trim()}` : '';
  return `${MARKER} ${withReason(`[TOOL CALLED${name}]`, reason)}`;
}

/** True when `text` is one of our placeholders - lets `enumerate` skip already-overlaid parts. */
export function isPlaceholder(text: string): boolean {
  return text.startsWith(MARKER);
}
