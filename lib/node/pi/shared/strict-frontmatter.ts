/**
 * Shared strict `---` frontmatter fence parser.
 *
 * Both the memory store (`../memory-reducer.ts`) and the roleplay store
 * (`../roleplay/store.ts`) persist entries as a tiny hand-rolled YAML
 * subset: an opening `---` fence, a block of `key: value` lines, a
 * closing `---` fence, then a free-form markdown body. This module owns
 * the *mechanical* half of parsing that format - fence detection, header
 * splitting, and body slicing - so both stores share one implementation
 * and only layer their own domain validation (required keys, type
 * coercion, metadata) on top.
 *
 * No pi imports so it stays unit-testable under `vitest`.
 *
 * ## What this parser does (and, deliberately, does not do)
 *
 * `parseFencedFrontmatter` returns the raw, *unquoted-verbatim*
 * `key -> value` map plus the body, or `null` when the fence structure
 * is malformed. Callers are expected to run {@link stripQuotes} on the
 * individual values they care about - the roleplay store needs the raw
 * value for its inline-list / bare-scalar parsing (stripping quotes
 * up-front would corrupt a value like `triggers: [a, b]`), so quote
 * stripping is intentionally left to the domain layer rather than baked
 * into the shared field map.
 */

const FENCE = '---';

/**
 * Undo a frontmatter value's quoting. Double-quoted values have their
 * `\\` / `\"` escapes reversed (order matters: unescape `\\` first so a
 * `\"` next to a `\\` isn't double-counted) so a roundtrip of a
 * backslash- or quote-bearing value is stable. Single-quoted values are
 * treated as literal. An unquoted value is returned trimmed.
 *
 * Only matched surrounding pairs of the *same* quote char are stripped;
 * a lone leading quote or a mismatched pair is left as-is (trimmed).
 */
export function stripQuotes(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

export interface FencedFrontmatter {
  /**
   * Header `key: value` pairs. Keys are trimmed; values are the raw
   * substring after the first `:` (NOT quote-stripped - run
   * {@link stripQuotes} per value in the domain layer). Later duplicate
   * keys overwrite earlier ones (last wins).
   */
  fields: Record<string, string>;
  /**
   * Everything after the closing fence, with any leading blank lines
   * stripped. The body can itself contain `---` rules without confusing
   * the parser, since scanning stops at the first closing fence.
   */
  body: string;
}

/**
 * Parse the shared `---`-fenced frontmatter envelope.
 *
 * Returns `null` when the opening fence is absent (after a leading UTF-8
 * BOM and any leading whitespace are stripped), when there is no closing
 * fence, or when any non-blank header line lacks a `:`.
 *
 * Mechanics (identical to the two stores' original hand-rolled parsers):
 *   - CRLF is normalised to LF up-front.
 *   - A leading UTF-8 BOM and any leading whitespace are stripped before
 *     the opening-fence check, so a file saved with a BOM or an
 *     accidental blank first line still parses.
 *   - The body starts immediately after the closing fence's newline, so
 *     a `---` rule inside the body is never mistaken for the close.
 *   - A file ending exactly with `\n---` (no trailing newline) closes the
 *     frontmatter and yields an empty body.
 *   - Header lines have trailing whitespace stripped; blank lines are
 *     skipped; the key is everything before the first `:` (trimmed) and
 *     the value is everything after it (verbatim).
 */
export function parseFencedFrontmatter(raw: string): FencedFrontmatter | null {
  // Normalise CRLF, then strip a leading UTF-8 BOM and any leading
  // whitespace so a BOM-prefixed or blank-line-prefixed file still parses.
  const src = raw
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/^\s+/, '');
  if (!src.startsWith(`${FENCE}\n`) && !src.startsWith(`${FENCE}\r\n`)) return null;

  const afterOpen = FENCE.length + 1; // skip the opening `---\n`
  const closeIdx = src.indexOf(`\n${FENCE}\n`, afterOpen - 1);
  // Tolerate a file ending exactly with `\n---` (no trailing newline).
  const closeIdxEof = src.endsWith(`\n${FENCE}`) ? src.length - FENCE.length - 1 : -1;
  const end = closeIdx !== -1 ? closeIdx : closeIdxEof;
  if (end === -1) return null;

  const header = src.slice(afterOpen, end);
  // Step over the closing `\n---` + trailing newline. When the match came
  // from `closeIdxEof` (no final newline), bodyStart may equal src.length,
  // and the slice below yields an empty body - fine.
  const bodyStart = end + FENCE.length + 2;
  const body = bodyStart <= src.length ? src.slice(bodyStart) : '';

  const fields: Record<string, string> = {};
  for (const rawLine of header.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) continue;
    const sep = line.indexOf(':');
    if (sep === -1) return null;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1);
  }

  return { fields, body: body.replace(/^\n+/, '') };
}
