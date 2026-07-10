/**
 * Image-side helpers for the comfyui extension: model-facing-copy
 * downscaling and named-role image inputs (path uploads + bbox-mask
 * synthesis). Lives under `ext/` because it imports `sharp` (a runtime-only
 * dependency a pure `lib/node/pi/` module may not take); the pure mask math
 * stays in `../../comfyui/mask.ts`.
 */

import type SharpFactory from 'sharp';

import { type Conn, type ImageBlockTransform, uploadImage, uploadImageBuffer } from '../../comfyui/client.ts';
import { buildMaskPlan, type MaskPlan, maskSvg } from '../../comfyui/mask.ts';
import { isResizableMime, planDownscale } from '../../comfyui/preview.ts';
import type { RoleMapping } from '../../comfyui/types.ts';
import { expandTilde } from '../../path-expand.ts';

// Lazy, cached `sharp` import. Native, so it loads from the extension
// shell (never pure `lib/`) and only when a downscale is actually
// requested. A load failure (unsupported arch / missing install) is
// swallowed by the transform below so a render never breaks over a
// preview resize.
interface SharpModule {
  default: typeof SharpFactory;
}
let sharpModule: Promise<SharpModule> | null = null;
function loadSharp(): Promise<SharpModule> {
  return (sharpModule ??= import('sharp'));
}

/**
 * Build an {@link ImageBlockTransform} that downscales the model-facing
 * image copy so its longer side is at most `maxDim` px (token economy).
 * Only still raster images are resized; the decode/encode is `sharp` and
 * every failure path returns the original bytes, so the on-disk full-res
 * file and the render itself are never at risk.
 */
function makeDownscaler(maxDim: number): ImageBlockTransform {
  return async (bytes, mimeType) => {
    if (!isResizableMime(mimeType)) return bytes;
    try {
      const sharp = (await loadSharp()).default;
      const img = sharp(bytes, { failOn: 'none' });
      const meta = await img.metadata();
      const plan = planDownscale(meta.width ?? 0, meta.height ?? 0, maxDim);
      if (!plan) return bytes;
      return await img.resize(plan.width, plan.height, { fit: 'inside' }).toBuffer();
    } catch {
      return bytes;
    }
  };
}

/** Transform for the configured/per-call preview cap, or undefined when off. */
export function previewTransformFor(maxDim: number | undefined): ImageBlockTransform | undefined {
  return maxDim !== undefined && maxDim > 0 ? makeDownscaler(maxDim) : undefined;
}

// ── Named image roles + bbox-mask synthesis (T5) ───────────────────────

/** A bbox synth spec for a `mask` role; the extension rasterizes it. */
interface BboxMaskSpec {
  bbox: number[][];
  feather?: number;
  invert?: boolean;
}

/** A role slot's value as the model passes it: a file path or a bbox synth spec. */
export type RoleImageInput = string | BboxMaskSpec;

export function isBboxSpec(value: RoleImageInput): value is BboxMaskSpec {
  return typeof value === 'object' && value !== null && Array.isArray(value.bbox);
}

/** Rasterize a {@link MaskPlan} to PNG bytes via `sharp` (optional gaussian feather). */
async function rasterizeMask(plan: MaskPlan): Promise<Buffer> {
  const sharp = (await loadSharp()).default;
  let img = sharp(Buffer.from(maskSvg(plan)));
  if (plan.feather > 0) img = img.blur(plan.feather);
  return img.png().toBuffer();
}

/**
 * Resolve a role-keyed `images` map into a `role -> uploaded-server-name`
 * record: a path is uploaded as-is; a `{ bbox }` on a `mask` slot is
 * rasterized (sized off the `init` image's metadata, else the resolved
 * `width`/`height`) and uploaded. Validation problems (unknown role, bbox
 * on a non-mask slot, missing size, bad geometry) return `{ error }`; an
 * upload/abort still throws so the caller's handler sees it.
 */
export async function resolveRoleImages(
  conn: Conn,
  roleMap: Record<string, RoleMapping>,
  sources: Record<string, RoleImageInput>,
  sizeFallback: { width?: number; height?: number },
  home: string,
  report: (text: string) => void,
  signal: AbortSignal,
): Promise<{ uploadedByRole?: Record<string, string>; error?: string }> {
  const entries = Object.entries(sources);

  // A bbox mask needs a canvas size: prefer the init image's real
  // dimensions, else the resolved width/height. Read once, up front.
  let dims: { width: number; height: number } | undefined;
  if (entries.some(([, src]) => isBboxSpec(src))) {
    const initSrc = sources.init;
    if (typeof initSrc === 'string') {
      try {
        const sharp = (await loadSharp()).default;
        const meta = await sharp(expandTilde(initSrc, home)).metadata();
        if (meta.width !== undefined && meta.height !== undefined) {
          dims = { width: meta.width, height: meta.height };
        }
      } catch {
        // fall back to the resolved width/height below
      }
    }
    if (dims === undefined && sizeFallback.width !== undefined && sizeFallback.height !== undefined) {
      dims = { width: sizeFallback.width, height: sizeFallback.height };
    }
  }

  try {
    const resolved = await Promise.all(
      entries.map(async ([role, src]): Promise<[string, string]> => {
        const slot = roleMap[role];
        if (slot === undefined) {
          throw new Error(
            `unknown image role "${role}" (workflow accepts: ${Object.keys(roleMap).join(', ') || 'none'})`,
          );
        }
        if (isBboxSpec(src)) {
          if (slot.kind !== 'mask') {
            throw new Error(`image role "${role}" is not a mask slot; a bbox can only target a mask role`);
          }
          if (dims === undefined) {
            throw new Error(`bbox mask for role "${role}" needs an init image or explicit width/height`);
          }
          const built = buildMaskPlan(src.bbox, dims.width, dims.height, {
            invert: src.invert ?? slot.invert,
            ...(src.feather !== undefined ? { feather: src.feather } : {}),
          });
          if (built.error !== undefined || built.plan === undefined) {
            throw new Error(built.error ?? `failed to build mask for role "${role}"`);
          }
          report(`rendering ${role} mask…`);
          const png = await rasterizeMask(built.plan);
          return [role, await uploadImageBuffer(conn, png, `comfyui-mask-${role}.png`, signal)];
        }
        report(`uploading ${role} image…`);
        return [role, await uploadImage(conn, src, home, signal)];
      }),
    );
    return { uploadedByRole: Object.fromEntries(resolved) };
  } catch (err) {
    if (signal.aborted) throw err;
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
