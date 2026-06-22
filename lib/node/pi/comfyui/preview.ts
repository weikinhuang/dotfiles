/**
 * Pure geometry + format gating for the in-context image "token economy":
 * a generated image is saved to disk at full resolution, but the copy fed
 * back to the model can be downscaled, since image token cost scales with
 * pixel dimensions (re-encoding the same pixels does nothing).
 *
 * The actual decode/resize/encode is native (`sharp`) and lives in the
 * extension shell; only the resolution math + the format gate live here,
 * so they are unit-tested without `sharp` or a server.
 *
 * No pi imports.
 */

/** Target dimensions for a downscale, or `null` when no resize applies. */
export interface DownscalePlan {
  width: number;
  height: number;
}

/**
 * Plan a downscale of a `srcW`x`srcH` image so its longer side is at most
 * `maxDim` px, preserving aspect ratio. Returns `null` (leave the image
 * untouched) when downscaling does not apply:
 *
 * - `maxDim` is not a finite number > 0 (the feature is disabled);
 * - the source dimensions are not finite positives (unknown size - the
 *   shell should pass the bytes through rather than guess);
 * - the image already fits (`max(srcW, srcH) <= maxDim`), so upscaling is
 *   never done.
 *
 * Otherwise both dimensions are scaled by `maxDim / max(srcW, srcH)`,
 * rounded, and floored at 1 so a very oblong image never collapses a side
 * to 0.
 */
export function planDownscale(srcW: number, srcH: number, maxDim: number): DownscalePlan | null {
  if (!Number.isFinite(maxDim) || maxDim <= 0) return null;
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) return null;

  const longest = Math.max(srcW, srcH);
  if (longest <= maxDim) return null;

  const scale = maxDim / longest;
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/**
 * Whether an output of this MIME type should be downscaled for the model.
 * Only still raster formats `sharp` can losslessly resample in place are
 * eligible; animated GIFs and any non-image output (audio, video) pass
 * through untouched so we never flatten an animation or corrupt a
 * non-image block.
 */
export function isResizableMime(mime: string): boolean {
  const lower = mime.trim().toLowerCase();
  return lower === 'image/png' || lower === 'image/jpeg' || lower === 'image/webp';
}
