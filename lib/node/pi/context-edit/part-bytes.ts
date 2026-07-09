/**
 * Shared content-part helpers for the context-edit modules.
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * `apply.ts`, `enumerate.ts`, and `auto-collapse.ts` all need to read the
 * text off a loose content part and estimate an image part's decoded byte
 * weight. These two helpers were triplicated across those files; they live
 * here so the definitions stay in one tested place.
 */

import { isTextPart } from '../shared/guards.ts';
import { type LoosePart } from './target.ts';

/** Text of a content part, or `''` for any non-text part (image, toolCall, …). */
export function partText(part: LoosePart): string {
  return isTextPart(part) ? part.text : '';
}

/**
 * Estimate the decoded byte size of an image part from its base64 `data`
 * (base64 expands ~4/3, so the decoded size is ~3/4 of the string length).
 * Returns 0 when there is no string `data` to measure.
 */
export function approxImageBytes(part: LoosePart): number {
  const data = (part as { data?: unknown }).data;
  return typeof data === 'string' ? Math.floor((data.length * 3) / 4) : 0;
}
