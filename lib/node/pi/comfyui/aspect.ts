/**
 * Pure aspect-ratio preset resolution for the `comfyui` extension.
 *
 * The model passes an `aspect` intent (e.g. `16:9`, `portrait`, `square`)
 * instead of guessing pixel dimensions. {@link resolveAspect} turns that
 * into a `{ width, height }` at a target pixel budget, snapped to a
 * multiple of 8 (the latent grid most ComfyUI graphs require). The
 * extension shell layers the result under any explicit per-call
 * width/height.
 *
 * No pi imports - testable under vitest.
 */

/** Default pixel budget when the caller has no project-configured area. */
export const DEFAULT_TARGET_PIXELS = 1_024 * 1_024;

/** Latent-grid multiple every returned dimension is snapped to. */
const GRID = 8;

/** Named aspect presets mapped to a width:height ratio. */
const NAMED_RATIOS: Readonly<Record<string, readonly [number, number]>> = {
  square: [1, 1],
  portrait: [3, 4],
  landscape: [4, 3],
  tall: [9, 16],
  wide: [16, 9],
  widescreen: [16, 9],
  cinema: [21, 9],
};

function roundToGrid(value: number): number {
  return Math.max(GRID, Math.round(value / GRID) * GRID);
}

/**
 * Parse an `aspect` value into a `[w, h]` ratio. Accepts a named preset
 * (case-insensitive) or a `W:H` / `W x H` pair of positive numbers.
 * Returns `undefined` for anything unparseable or non-positive.
 */
export function parseAspectRatio(aspect: string): [number, number] | undefined {
  const trimmed = aspect.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  const named = NAMED_RATIOS[trimmed];
  if (named !== undefined) return [named[0], named[1]];

  const match = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (match === null) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  return [w, h];
}

/**
 * Resolve an `aspect` intent to grid-snapped `{ width, height }` at
 * `targetPixels` total area, preserving the ratio. Returns `undefined`
 * for an unparseable aspect so the caller falls back to its other
 * dimension sources.
 */
export function resolveAspect(
  aspect: string,
  targetPixels: number = DEFAULT_TARGET_PIXELS,
): { width: number; height: number } | undefined {
  const ratio = parseAspectRatio(aspect);
  if (ratio === undefined) return undefined;
  const area = Number.isFinite(targetPixels) && targetPixels > 0 ? targetPixels : DEFAULT_TARGET_PIXELS;
  const [rw, rh] = ratio;
  // width = ratio * height, and width * height = area, so
  // height = sqrt(area / ratio); width = ratio * height.
  const ratioWh = rw / rh;
  const height = Math.sqrt(area / ratioWh);
  const width = ratioWh * height;
  return { width: roundToGrid(width), height: roundToGrid(height) };
}
