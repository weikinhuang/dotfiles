/**
 * Pure bbox -> inpaint-mask geometry for the `comfyui` extension. The
 * model expresses an edit region as one or more normalized rectangles;
 * this turns them into a pixel-space "mask plan" (canvas size, filled
 * rectangles, polarity, feather) that the extension shell rasterizes into
 * a PNG via `sharp` and uploads as the workflow's mask slot.
 *
 * Only the validation + coordinate math live here so they are unit-tested
 * without `sharp`; the native rasterize/encode is the shell's job.
 *
 * No pi imports.
 */

/** A normalized rectangle: `[x, y, w, h]` in `0..1`, top-left origin. */
export type NormalizedBox = readonly number[];

/** One filled rectangle in pixel space (top-left origin). */
export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rasterizable mask: canvas dims, the white (edit) rectangles, polarity, feather. */
export interface MaskPlan {
  width: number;
  height: number;
  rects: MaskRect[];
  /** When true, the filled rects are "keep" and the background is "change". */
  invert: boolean;
  /** Gaussian edge softening, in px; `0` = hard edge. */
  feather: number;
}

export interface MaskOptions {
  /** Flip polarity (default false: filled rect = the region to change). */
  invert?: boolean;
  /** Gaussian feather in px; must be >= 0 finite. Default 0. */
  feather?: number;
}

const EPS = 1e-6;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Validate normalized `bboxes` against a `width`x`height` canvas and turn
 * them into a {@link MaskPlan}. Returns `{ error }` (never throws) when:
 *
 * - the canvas dimensions are not finite positive integers;
 * - `bboxes` is empty;
 * - any box is not a 4-number `[x, y, w, h]`;
 * - any box has a non-positive `w`/`h` (zero-area), a negative origin, or
 *   extends past the canvas edge (`x + w > 1` / `y + h > 1`);
 * - `feather` is negative / non-finite.
 *
 * Each box is scaled to pixels and rounded; a rect is floored to at least
 * 1px so a sub-pixel-but-valid box still paints.
 */
export function buildMaskPlan(
  bboxes: readonly NormalizedBox[],
  width: number,
  height: number,
  opts: MaskOptions = {},
): { plan?: MaskPlan; error?: string } {
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width < 1 || height < 1) {
    return { error: 'mask canvas needs positive width and height' };
  }
  if (!Array.isArray(bboxes) || bboxes.length === 0) {
    return { error: 'bbox mask needs at least one [x, y, w, h] rectangle' };
  }

  const feather = opts.feather ?? 0;
  if (!isFiniteNumber(feather) || feather < 0) {
    return { error: `invalid mask feather "${String(opts.feather)}" (must be a number >= 0)` };
  }

  const w = Math.round(width);
  const h = Math.round(height);
  const rects: MaskRect[] = [];

  for (const box of bboxes) {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(isFiniteNumber)) {
      return { error: 'each bbox must be a [x, y, w, h] array of four numbers' };
    }
    const [x, y, bw, bh] = box as [number, number, number, number];
    if (bw <= 0 || bh <= 0) return { error: `bbox [${box.join(', ')}] has zero or negative area` };
    if (x < -EPS || y < -EPS || x + bw > 1 + EPS || y + bh > 1 + EPS) {
      return { error: `bbox [${box.join(', ')}] is outside the normalized 0..1 range` };
    }
    const px = Math.max(0, Math.round(x * w));
    const py = Math.max(0, Math.round(y * h));
    rects.push({
      x: px,
      y: py,
      width: Math.min(w - px, Math.max(1, Math.round(bw * w))),
      height: Math.min(h - py, Math.max(1, Math.round(bh * h))),
    });
  }

  return { plan: { width: w, height: h, rects, invert: opts.invert ?? false, feather } };
}
