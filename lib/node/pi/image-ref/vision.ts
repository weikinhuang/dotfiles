/**
 * Whether the active model can actually see an image, used by the
 * `image-ref` extension to decide if attaching is worthwhile.
 *
 * Same shape as comfyui's `resolveSendToModel` gate: pi models carry an
 * `input` capability array (e.g. `["text", "image"]`). When it is a
 * real array lacking `"image"`, the model is text-only and attaching a
 * base64 payload only wastes tokens (or errors), so the extension skips
 * it and leaves the path as plain text. When the capability is unknown
 * (not an array - a detection gap), we optimistically allow attaching so
 * a metadata miss never silently drops a supported image.
 *
 * Pure module - no pi imports.
 */

/** Return `true` unless the model positively cannot accept image input. */
export function modelAcceptsImages(modelInput: unknown): boolean {
  if (Array.isArray(modelInput)) {
    return (modelInput as unknown[]).includes('image');
  }
  return true;
}
