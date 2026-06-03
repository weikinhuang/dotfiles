/**
 * Pull explicitly-marked image-path tokens out of a free-text user
 * message for the `image-ref` extension, then rewrite the message once
 * each token is confirmed to be a real image.
 *
 * Attachment is OPT-IN: only a token prefixed with the `&` marker
 * (`&./mock.png`) is a candidate. A bare path mentioned in prose
 * ("let's rename Example.jpg") is never touched, so discussing a file
 * can't accidentally base64 it into the request. Because the marker is
 * the user's explicit intent signal, there is no extension allowlist or
 * path-shape guessing here - the byte sniff in `detect.ts` plus a real
 * filesystem `stat` (done in the extension) are the only authority, so
 * a marked file that turns out not to be an image just stays as text.
 *
 * Pure module - no pi imports, no filesystem - so token extraction and
 * the text rewrite are unit-testable in isolation.
 */

/** The opt-in prefix that marks a path for image attachment. */
export const MARKER = '&';

/** A candidate path token and where it sat in the original text. */
export interface PathToken {
  /** The cleaned path (marker, quotes, and trailing punctuation removed). */
  path: string;
  /** Raw substring as it appeared (incl. marker), so the rewrite can replace it verbatim. */
  raw: string;
}

// Trailing characters that are almost always prose punctuation, not part
// of a filename: a path at the end of a sentence ("look at &./a.png.").
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

/**
 * Strip the leading `&` marker, surrounding quotes, and stray trailing
 * sentence punctuation from a raw whitespace-delimited token. Returns
 * the cleaned path, or `''` when nothing usable remains. The caller has
 * already confirmed `raw` starts with {@link MARKER}.
 */
export function cleanToken(raw: string): string {
  let token = raw.trim();
  if (token.startsWith(MARKER)) token = token.slice(MARKER.length);
  // Fully quoted token: keep the inside verbatim (a spaceless quoted
  // path - whitespace-split means multi-word names can't survive here).
  const quoted = /^"([^"]+)"$/.exec(token) ?? /^'([^']+)'$/.exec(token);
  if (quoted) return quoted[1];
  token = token.replace(TRAILING_PUNCT, '');
  return token;
}

/**
 * Extract de-duplicated marked image-path tokens from `text`.
 *
 * Only whitespace-delimited tokens beginning with {@link MARKER} are
 * considered. Order is preserved (first occurrence wins) and duplicates
 * collapse to one token, so marking the same file twice attaches it once.
 */
export function extractPathTokens(text: string): PathToken[] {
  const seen = new Set<string>();
  const tokens: PathToken[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw.startsWith(MARKER)) continue;
    const path = cleanToken(raw);
    if (path.length === 0) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    tokens.push({ path, raw });
  }
  return tokens;
}

/** A confirmed attachment, ready to splice into the rewritten message. */
export interface AttachedRef {
  /** Original token text as it appeared in the message (incl. marker). */
  raw: string;
  /** Display name placed in the `<image>` tag (usually the basename). */
  name: string;
  /** Optional dimension note (e.g. "1024x768") appended inside the tag. */
  note?: string;
}

/**
 * Rewrite `text`, replacing each attached token's raw substring with a
 * stable `<image name="...">note</image>` reference. Mirrors pi's
 * `@file` convention so the model has a durable handle to refer back to
 * instead of a raw path string (the leading marker is dropped too).
 *
 * Only the first occurrence of each raw token is replaced (matching the
 * de-dup in {@link extractPathTokens}); any later identical mention is
 * left as-is, which is fine because the image is already attached.
 */
export function rewriteWithRefs(text: string, refs: AttachedRef[]): string {
  let out = text;
  for (const ref of refs) {
    const tag = ref.note ? `<image name="${ref.name}">${ref.note}</image>` : `<image name="${ref.name}"></image>`;
    out = out.replace(ref.raw, tag);
  }
  return out;
}
