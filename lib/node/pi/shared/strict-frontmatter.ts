/**
 * Shared `---` frontmatter fence parser.
 *
 * Both the memory store (`../memory-reducer.ts`) and the roleplay store
 * (`../roleplay/store.ts`) persist entries as a `---`-fenced YAML header
 * followed by a free-form markdown body. This module owns the
 * *mechanical* half of parsing that format - fence detection, header
 * extraction, and body slicing - and delegates the header itself to a
 * real YAML parser (the `yaml` package). Both stores share this one
 * implementation and only layer their own domain validation (required
 * keys, type coercion, metadata) on top.
 *
 * ## Boundary exception
 *
 * `lib/node/pi/AGENTS.md` forbids pure modules from importing third-party
 * runtime deps. This module is the single, deliberate exception: it is
 * the *only* pure module allowed to import `yaml`, so the entire
 * dependency surface for frontmatter parsing is one auditable file. The
 * earlier hand-rolled `key: value` line parser was too brittle - it
 * could not handle YAML block scalars (`|` / `>`) or a key whose value
 * wrapped onto indented continuation lines (as a markdown/YAML formatter
 * produces for long values in committed files), and it rejected the
 * whole file on any colon-less header line. Delegating to `yaml` fixes
 * that whole class of bug.
 *
 * ## What this parser does (and, deliberately, does not do)
 *
 * `parseFencedFrontmatter` returns the parsed header as a
 * `key -> unknown` map (values carry YAML's native types: strings,
 * numbers, booleans, arrays, nested maps) plus the body, or `null` when
 * the fence structure is malformed, the header is not valid YAML, or the
 * header is not a mapping. Domain layers coerce individual values to the
 * shapes they need.
 *
 * No pi imports so it stays unit-testable under `vitest`.
 */

import { parse as parseYaml } from 'yaml';

const FENCE = '---';

export interface FencedFrontmatter {
  /**
   * Parsed header key -> value map. Values carry YAML's native types
   * (string / number / boolean / array / nested map); domain layers
   * coerce per field. An empty header (all blank lines / comments)
   * yields an empty map.
   */
  fields: Record<string, unknown>;
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
 * fence, when the header is not valid YAML (a `yaml` parse error), or
 * when the header parses to something other than a mapping (a bare
 * scalar or a sequence).
 *
 * Mechanics:
 *   - CRLF is normalised to LF up-front.
 *   - A leading UTF-8 BOM and any leading whitespace are stripped before
 *     the opening-fence check, so a file saved with a BOM or an
 *     accidental blank first line still parses.
 *   - The body starts immediately after the closing fence's newline, so
 *     a `---` rule inside the body is never mistaken for the close.
 *   - A file ending exactly with `\n---` (no trailing newline) closes the
 *     frontmatter and yields an empty body.
 *   - The header text between the fences is handed verbatim to
 *     `yaml.parse`, so YAML block scalars, multi-line/continuation
 *     values, inline lists, quoting, and comments all behave per the
 *     YAML 1.2 core schema. A `yaml` parse error (including duplicate
 *     keys) makes the whole file parse as `null` rather than throwing,
 *     so callers can skip a malformed file with a warning instead of
 *     crashing the index.
 */
export function parseFencedFrontmatter(raw: string): FencedFrontmatter | null {
  // Normalise CRLF, then strip a leading UTF-8 BOM and any leading
  // whitespace so a BOM-prefixed or blank-line-prefixed file still parses.
  const src = raw
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/^\s+/, '');
  if (!src.startsWith(`${FENCE}\n`)) return null;

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
  const trimmedBody = body.replace(/^\n+/, '');

  let parsed: unknown;
  try {
    parsed = parseYaml(header);
  } catch {
    // Malformed YAML (syntax error, duplicate keys, …) - reject the file.
    return null;
  }

  // An empty header (all blank lines / comments) parses to null/undefined.
  if (parsed === null || parsed === undefined) return { fields: {}, body: trimmedBody };
  // The header must be a mapping; a bare scalar or a sequence is malformed.
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  return { fields: parsed as Record<string, unknown>, body: trimmedBody };
}
