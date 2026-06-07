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
import { collapseWhitespace } from '../shared/strings.ts';

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

export interface ImagePlaceholderOptions {
  /** Freeform "why trimmed" - rendered OUTSIDE the brackets via {@link withReason}, like the other placeholders. */
  reason?: string;
  /** Approx decoded byte size for the size annotation (`~1.2MB`). */
  approxBytes?: number;
  /**
   * Lossy-compressed caption of what the absent image depicted, rendered
   * INSIDE the brackets as a quoted string - the placeholder's payload,
   * matching how `textPlaceholder` nests its stat inside the marker.
   * Sourced and length-capped by the caller (see `image-description.ts`).
   */
  description?: string;
  /** Pixel dimensions, rendered inside as `W×H` when both are positive. */
  width?: number;
  height?: number;
}

/**
 * Normalize a caption for inline rendering: collapse whitespace to single
 * spaces and replace inner double-quotes with single quotes so the quoted
 * span stays unambiguous. Pure + deterministic (byte-stable). Length
 * capping is the caller's job (`capDescription` in `image-description.ts`).
 */
function cleanCaption(description: string | undefined): string {
  const d = description?.trim();
  if (!d) return '';
  return collapseWhitespace(d).replace(/"/g, "'");
}

/**
 * Placeholder for a trimmed image part.
 *
 * Shape (segments joined by ` · `, description quoted):
 *
 *   ⟨pi-context-edit⟩ [IMAGE REMOVED · 1024×1024 · ~1.2MB · "a red fox in snow"]
 *
 * Dimensions, size, and description are each optional; the freeform
 * `reason` stays OUTSIDE via {@link withReason}. Byte-stable: identical
 * inputs always render identical bytes, so a persisted directive yields
 * the same placeholder every turn and never breaks prefix caching.
 */
export function imagePlaceholder(options: ImagePlaceholderOptions = {}): string {
  const { reason, approxBytes, description, width, height } = options;
  const segments = ['IMAGE REMOVED'];
  if (width && height && width > 0 && height > 0) {
    segments.push(`${Math.floor(width)}×${Math.floor(height)}`);
  }
  if (approxBytes && approxBytes > 0) {
    segments.push(`~${formatCompactBytes(approxBytes)}`);
  }
  const caption = cleanCaption(description);
  if (caption) segments.push(`"${caption}"`);
  return `${MARKER} ${withReason(`[${segments.join(' · ')}]`, reason)}`;
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
