/**
 * Derived non-vision image-strip policy (feature 4 of
 * `plans/pi-agentic-context-edit-nonvision-strip.md`).
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * When the ACTIVE model is text-only it cannot read images, so an image
 * in context is pure dead weight (wasted tokens at best, a provider error
 * at worst). This module derives a set of transient {@link TrimDirective}
 * that blank every image part with the same `[IMAGE REMOVED · … ]`
 * placeholder the manual `/context-trim` path produces.
 *
 * Like `auto-collapse`, the strip is a POLICY, not a user decision: it is
 * recomputed fresh each turn from the active model's vision capability and
 * never persisted. Switching back to a vision model simply stops deriving
 * it, so the images reappear (derived, non-destructive - matching
 * `auto-collapse`'s semantics).
 *
 * Description sourcing is the FREE subset of feature 3: generated images
 * (`comfyui` / `generate_image`) carry their generation prompt, so the
 * stripped placeholder keeps that caption. There is no vision auto-caption
 * here - it would fire a vision call per turn and break prefix caching,
 * and the active model is text-only anyway. An un-described observed image
 * strips to a size-only placeholder (the accepted fallback).
 *
 * The directives carry NEGATIVE ids (transient, never collide with the
 * positive persisted-directive ids) and `createdAt: 0` so the overlay is
 * byte-stable turn over turn.
 */

import { type TrimDirective } from './directive.ts';
import { capDescription, extractGenerationPrompt } from './image-description.ts';
import { type LooseMessage, type Target, toParts } from './target.ts';

/** Stable reason stamped OUTSIDE the placeholder brackets. Byte-stable. */
export const NONVISION_STRIP_REASON = 'text-only model';

/**
 * Derive transient trim directives that blank every image part in
 * `messages`. Intended to run on the ALREADY-overlaid message list (after
 * the manual persisted directives have been applied), so an image a human
 * already trimmed is now a text placeholder and is naturally skipped here.
 *
 * Returns an empty array when there are no image parts. The caller applies
 * the result with `applyDirectives` and discards it - nothing is persisted.
 */
export function selectNonVisionStrip(messages: readonly LooseMessage[]): TrimDirective[] {
  const out: TrimDirective[] = [];
  let id = -1;

  // Mirror `enumerate`'s per-message occurrence counter so a message
  // target keyed on (role, timestamp, occurrence) resolves back to exactly
  // the message we saw, even on the rare same-ms collision.
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
      if (!toolCallId) continue; // can't address a result part without its id
      // Free description (generation prompt) is shared across the result's
      // images; observed images have none and fall back to size-only.
      const description = capDescription(extractGenerationPrompt(messages, toolCallId));
      for (let p = 0; p < parts.length; p++) {
        if (parts[p].type !== 'image') continue;
        const target: Target = { by: 'toolCallId', toolCallId, partIndex: p };
        out.push({ kind: 'trim', id: id--, target, reason: NONVISION_STRIP_REASON, description, createdAt: 0 });
      }
      continue;
    }

    if (m.role === 'user' || m.role === 'assistant') {
      const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
      // Increment once per message (matching enumerate), regardless of
      // whether this message carries an image, so occurrence stays aligned
      // with how `resolveTarget` counts same-(role,timestamp) messages.
      const occurrence = nextOccurrence(m.role, ts);
      for (let p = 0; p < parts.length; p++) {
        if (parts[p].type !== 'image') continue;
        const target: Target = { by: 'message', role: m.role, timestamp: ts, occurrence, partIndex: p };
        // Observed (pasted) images carry no generation prompt -> size-only.
        out.push({ kind: 'trim', id: id--, target, reason: NONVISION_STRIP_REASON, createdAt: 0 });
      }
    }
  }

  return out;
}
