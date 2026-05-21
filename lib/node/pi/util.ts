/**
 * Tiny shared primitives used across pi-related lib helpers.
 *
 * Two utilities are factored here rather than duplicated:
 *
 *   - {@link shQuote} - single-quote-escape a shell argument; used by
 *     `sandbox/markers.ts` and `sandbox/platform.ts`.
 *   - {@link isPlainObject} - type-guard for `Record<string, unknown>`;
 *     used by `sandbox/config-load.ts` and `filesystem-policy/load.ts`.
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 */

/**
 * Single-quote-escape `s` for safe inclusion in a `/bin/sh` command.
 * Single-quoted strings have no metacharacter expansion; embedded
 * single quotes are escaped via the `'\''` close/escape/reopen idiom.
 *
 * Example: `shQuote("it's")` → `"'it'\\''s'"`.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * True when `v` is a non-null, non-array plain object. Narrows to
 * `Record<string, unknown>` so callers can index into it without a
 * cast.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
