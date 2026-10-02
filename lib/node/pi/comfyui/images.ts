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
export type MediaKind = 'image' | 'video' | 'audio' | 'binary';

/** MIME type for any savable ComfyUI output, inferred from its filename. */
export function mediaMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.png') || !lower.includes('.')) return 'image/png';
  return 'application/octet-stream';
}

/** Classify a saved output from its inferred MIME type. */
export function mediaKindFromName(name: string): MediaKind {
  const mime = mediaMimeFromName(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'binary';
}

/**
 * Image-only compatibility helper. Unknown names still default to PNG, as
 * older image workflows may emit extensionless temporary files.
 */
export function mimeFromName(name: string): string {
  const mime = mediaMimeFromName(name);
  return mime.startsWith('image/') ? mime : 'image/png';
}
