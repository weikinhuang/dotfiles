/**
 * Minimal RIFF/WAVE header reader for the `tts` extension.
 *
 * `/tts status` warns when a clone reference clip is longer than the 30 s ICL
 * limit, which needs the clip duration without decoding audio. This walks the
 * RIFF chunk list for `fmt ` (byte rate) and `data` (payload size). Non-WAV
 * input (e.g. an MP3 reference) returns undefined so the caller skips the
 * check. Pure; no pi imports.
 */

/** Longest reference clip llama.cpp's ICL cloning accepts; longer clips fall back to the speaker embedding. */
export const ICL_MAX_REF_SECONDS = 30;

/**
 * Duration in seconds of a WAV file from its header bytes, or undefined when
 * the bytes are not a parseable WAV. A `data` size of `0xFFFFFFFF` (streamed
 * WAV) or one past the end of the buffer is clamped to the bytes present.
 */
export function wavDurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;

  let byteRate: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 12 <= bytes.length) {
      byteRate = view.getUint32(body + 8, true);
    } else if (id === 'data') {
      if (byteRate === undefined || byteRate === 0) return undefined;
      const available = bytes.length - body;
      return Math.min(size, available) / byteRate;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  return undefined;
}
