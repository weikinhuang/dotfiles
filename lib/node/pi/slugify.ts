/**
 * Shared filesystem-safe ASCII slug builder.
 *
 * Several stores derive an on-disk filename/id from a user-supplied name
 * (memory entries, roleplay cast/entries, research run dirs). They all
 * lowercase, map non-alphanumerics to `-`, and trim/collapse dashes -
 * this centralises that core so the policy lives in one place. Behaviour
 * variations (diacritic folding, length cap, fallback) are opt-in so
 * each caller keeps its exact prior output.
 *
 * Pure module - no pi imports.
 */

export interface SlugifyAsciiOptions {
  /**
   * Fold diacritics to ASCII via NFKD + combining-mark strip (so `café`
   * → `cafe` instead of `caf`). Off by default to preserve the historic
   * output of callers that never did this.
   */
  stripDiacritics?: boolean;
  /**
   * Cap the slug length, trimming any trailing dash stranded by the cut.
   * Unbounded when omitted.
   */
  maxLength?: number;
  /**
   * Value returned when the input has no usable `[a-z0-9]` characters.
   * A function is called lazily (e.g. a timestamp slug); a string is
   * returned verbatim. Defaults to an empty string.
   */
  fallback?: string | (() => string);
}

/**
 * Turn an arbitrary string into a kebab-case ASCII slug: lowercase,
 * runs of non-`[a-z0-9]` collapsed to a single `-`, leading/trailing
 * dashes trimmed. Returns the configured `fallback` when nothing usable
 * remains.
 */
export function slugifyAscii(input: string, options: SlugifyAsciiOptions = {}): string {
  let s = input;
  if (options.stripDiacritics) {
    s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }
  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (options.maxLength !== undefined && s.length > options.maxLength) {
    // Re-trim a trailing dash the truncation may have stranded so we
    // never end on a `-`.
    s = s.slice(0, options.maxLength).replace(/-+$/g, '');
  }

  if (s.length === 0) {
    const fb = options.fallback;
    return typeof fb === 'function' ? fb() : (fb ?? '');
  }
  return s;
}
