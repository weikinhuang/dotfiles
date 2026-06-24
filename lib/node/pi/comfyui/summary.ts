/**
 * Shared text formatters for a landed image render. Pure (no pi imports,
 * no session state) so both the foreground `generate_image` path
 * (generate.ts) and the background `image_jobs collect` path (jobs.ts)
 * build their model-facing summary line through one source of truth -
 * previously the "N image(s) … via X … Saved to Y … (not sent to model)"
 * template was duplicated across the two files and drifted apart.
 */

import type { SendDecision } from './config.ts';

/** "1 image" / "N images" - the pluralized image count clause. */
export function imageCountNote(count: number): string {
  return `${count} image${count === 1 ? '' : 's'}`;
}

/** " (seed N)" when a seed is known, else "". */
export function seedNote(seed: number | undefined): string {
  return seed !== undefined ? ` (seed ${seed})` : '';
}

/**
 * The trailing "why the image was not handed to the model" note. Empty
 * when the image is being sent; distinguishes a positively vision-less
 * model from a plain `sendToModel: false`.
 */
export function notSentNote(decision: SendDecision): string {
  if (decision.send) return '';
  return decision.visionBlocked
    ? ' (active model has no image input; not sent to model)'
    : ' (image not sent to model)';
}

export interface RenderedImageSummary {
  /** Leading verb: "Generated" (foreground) or "Collected" (background collect). */
  verb: string;
  /** Number of images that landed on disk. */
  count: number;
  /** " from [jobId]" segment for a collected background job, else omit. */
  fromJob?: string;
  /** Pre-decorated generation-id note, e.g. " [g3]" (generate) or " (g3)" (collect). */
  idNote?: string;
  /** Workflow name the render ran through. */
  workflow: string;
  /** Render seed, when known. */
  seed?: number;
  /** Absolute directory the image(s) were saved to. */
  saveDir: string;
  /** The resolve-send decision; drives the trailing not-sent note. */
  decision: SendDecision;
  /** Extra text appended at the very end (e.g. the enhance note, or an ephemeral marker). */
  extra?: string;
}

/**
 * Build the one-line model-facing summary for a render that landed on
 * disk. Used by both the foreground render and the background collect so
 * the wording stays identical across the two paths.
 */
export function summarizeRenderedImages(s: RenderedImageSummary): string {
  return (
    `${s.verb} ${imageCountNote(s.count)}${s.fromJob ?? ''}${s.idNote ?? ''} via "${s.workflow}"` +
    `${seedNote(s.seed)}. Saved to ${s.saveDir}.${notSentNote(s.decision)}${s.extra ?? ''}`
  );
}
