/**
 * Small, dependency-free utilities shared across the other `lib/node/pi/*`
 * modules. No pi imports — testable under `vitest`.
 *
 * These helpers were previously duplicated (ellipsis truncation lived in
 * three separate modules with slightly different trim semantics; `byteLen`
 * and a `trimOrUndefined` pattern each had one copy but were obviously
 * reusable). Consolidating them here keeps fixes landing in one place
 * without pulling a full util library in.
 */

export interface TruncateOptions {
  /** Trim whitespace from `s` before measuring / slicing. Default false. */
  trim?: boolean;
}

/**
 * Cap `s` at `n` characters, appending `…` when the limit is hit. When
 * `trim` is enabled the input is trimmed first so callers don't need a
 * two-step `s.trim()` then `truncate()` dance.
 *
 * Guarantees:
 *   - Returns `s` (or the trimmed form) unchanged when it already fits.
 *   - When truncating, the returned string is exactly `n` chars long —
 *     `n - 1` original chars plus the `…` ellipsis.
 *   - `n <= 0` yields an empty string; `n === 1` yields just `…` when
 *     the input was longer than 0 chars (otherwise empty).
 */
export function truncate(s: string, n: number, opts: TruncateOptions = {}): string {
  const input = opts.trim ? s.trim() : s;
  if (n <= 0) return '';
  if (input.length <= n) return input;
  if (n === 1) return '…';
  return `${input.slice(0, n - 1)}…`;
}

/**
 * Trim `s`; return the trimmed form when non-empty, otherwise `undefined`.
 * Handy for optional fields where an empty string should clear the slot.
 */
export function trimOrUndefined(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Shared UTF-8 encoder. Exposed so callers that measure bytes in a tight
 * loop can reuse a single encoder instance instead of allocating.
 */
export const BYTE_ENCODER = new TextEncoder();

/** UTF-8 byte length of `s`. */
export function byteLen(s: string): number {
  return BYTE_ENCODER.encode(s).length;
}
