/**
 * Type guards used throughout the lib + extension surface to validate
 * untrusted payloads (JSON from disk, model output, session-entry
 * state) before reading properties off them.
 *
 * Each guard is intentionally loose so it composes; callers that need
 * stricter variants (non-empty strings, plain prototypes only, …) roll
 * their own check on top.
 */

/**
 * Type guard for "plain object" values - rejects `null`, arrays, and
 * scalars. The canonical first step in a structural validator before
 * reading properties off an untrusted payload (JSON from disk, model
 * output, session-entry state). Kept here so every validator shares
 * one definition of "record"; see the precedent in
 * `iteration-loop-schema.ts`.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Type guard for "array of strings". Matches the common-case semantic
 * shared by validators that accept a list of identifiers, paths, or
 * tags. Domain-specific variants that need stricter rules (e.g.
 * non-empty strings) should compose this with their own check rather
 * than redefining the loose form.
 */
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

/**
 * Type guard for non-empty strings. Equivalent to
 * `typeof v === 'string' && v.length > 0` but reads as one predicate
 * at every callsite where a required string field is being validated
 * against an untrusted payload.
 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Type guard for "finite number" - i.e. a real `number`, not `NaN`,
 * `Infinity`, or `-Infinity`. Used by reducer validators that need to
 * accept timestamps, counters, byte sizes, etc. without crashing on
 * upstream junk.
 */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Type guard for a duck-typed text content part: `{ type: 'text' }`
 * carrying a string `text`. Shared by the context-edit / context-reminder
 * walkers that iterate pi's loosely-typed message-part unions and need to
 * read `.text` off the text parts only. Callers with an extra predicate
 * (e.g. a reminder block that must also start with a given tag) compose
 * this with their own check at the call site.
 */
export function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string';
}
