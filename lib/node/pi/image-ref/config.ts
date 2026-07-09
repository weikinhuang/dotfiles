/**
 * Pure config defaults + coercion + layering for the `image-ref`
 * extension. Mirrors the comfyui config module: the shell reads JSON
 * from disk (shipped default -> user global `~/.pi/agent/image-ref.json`
 * -> project local `<cwd>/.pi/image-ref.json`), and this module owns
 * validation + merge so it stays unit-testable.
 *
 * No pi imports.
 */

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';
import { isRecord } from '../shared.ts';

export interface ImageRefConfig {
  /**
   * Max images attached from a single message. A guard against a paste
   * that happens to contain a dozen path-like tokens ballooning the
   * request. Excess tokens are left as plain text.
   */
  maxImages: number;
  /**
   * Resize attached images to fit pi's inline limit (2000x2000, <4.5MB
   * base64) before sending. Off = attach original bytes (only sane for
   * already-small images).
   */
  autoResize: boolean;
  /**
   * Max on-disk file size (bytes) the extension will read for a single
   * image. Files larger than this are skipped (left as text) so a stray
   * multi-hundred-MB token can't stall a turn reading it.
   */
  maxFileBytes: number;
}

/** Shipped defaults used as the lowest config layer. */
export const DEFAULT_CONFIG: ImageRefConfig = {
  maxImages: 6,
  autoResize: true,
  maxFileBytes: 64 * 1024 * 1024,
};

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Validate one untrusted JSON layer into a partial config. */
export function coerceConfigLayer(raw: unknown): Partial<ImageRefConfig> {
  if (!isRecord(raw)) return {};
  const out: Partial<ImageRefConfig> = {};
  const maxImages = asPositiveInt(raw.maxImages);
  if (maxImages !== undefined) out.maxImages = maxImages;
  const autoResize = asBoolean(raw.autoResize);
  if (autoResize !== undefined) out.autoResize = autoResize;
  const maxFileBytes = asPositiveInt(raw.maxFileBytes);
  if (maxFileBytes !== undefined) out.maxFileBytes = maxFileBytes;
  return out;
}

/** Merge ordered layers (lowest first) over the shipped defaults. */
export function mergeConfigLayers(...layers: Partial<ImageRefConfig>[]): ImageRefConfig {
  const result: ImageRefConfig = { ...DEFAULT_CONFIG };
  for (const layer of layers) {
    if (layer.maxImages !== undefined) result.maxImages = layer.maxImages;
    if (layer.autoResize !== undefined) result.autoResize = layer.autoResize;
    if (layer.maxFileBytes !== undefined) result.maxFileBytes = layer.maxFileBytes;
  }
  return result;
}

/**
 * Load the fully-resolved config for `cwd`, layering the shipped
 * default (lowest) under the user-global file under the project file.
 * A missing / malformed file degrades to an empty layer.
 */
export function loadImageRefConfig(cwd: string): ImageRefConfig {
  const userLayer = coerceConfigLayer(readJsoncOrUndefined(piAgentPath('image-ref.json')));
  const projectLayer = coerceConfigLayer(readJsoncOrUndefined(piProjectPath(cwd, 'image-ref.json')));
  return mergeConfigLayers(userLayer, projectLayer);
}
