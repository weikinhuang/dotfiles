/**
 * Single-quote-escape a shell argument. Used by `sandbox/markers.ts`
 * and `sandbox/platform.ts`. Pure module - no pi imports.
 *
 * The plain-object type guard previously also lived here; it now ships
 * from `shared.ts` as `isRecord` so the lib tree has one canonical
 * "record" predicate. Callers that need the strict prototype check
 * (rejecting class instances) should keep their local copy.
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
