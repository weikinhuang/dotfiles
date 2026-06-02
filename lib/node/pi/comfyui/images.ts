/**
 * Pure helpers for the on-disk side of a generated ComfyUI image: the
 * extension shell fetches the bytes and writes the file, but the
 * filename -> MIME mapping is plain string logic, so it lives here and is
 * unit-tested without a server.
 *
 * No pi imports.
 */

/**
 * Map a generated image's filename to the MIME type used for its inline
 * tool-result block. ComfyUI emits PNG by default, so anything without a
 * recognized image extension falls back to `image/png`.
 */
export function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}
