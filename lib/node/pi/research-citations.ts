/**
 * Citation placeholder rewriting for research-toolkit reports.
 *
 * During synthesis, an LLM writes a draft that references sources
 * via placeholders of the form `{{SRC:<id>}}`. The id is the
 * hash-keyed source identifier produced by the source store (see
 * the planned `research-sources.ts` - this module intentionally
 * stays filesystem-free so it can be unit-tested in isolation).
 *
 * After synthesis, we need two things:
 *
 *   1. **Validation** - every placeholder the model emitted must
 *      point at a source we actually have. An unknown id means the
 *      model hallucinated a source, and the report needs to fail
 *      structural review rather than silently shipping a dangling
 *      citation. `validatePlaceholders` is the gate for that.
 *
 *   2. **Rewrite** - replace `{{SRC:<id>}}` with stable `[^N]`
 *      markers and emit a footnotes block containing
 *      `[^N]: <title> - <url>` entries in first-use order. That's
 *      what `renumber` does.
 *
 * Both functions are pure: strings in, strings out. No filesystem,
 * no network, no pi. They compose with any caller that can hand us
 * an `id → {url, title}` mapping.
 *
 * No pi imports.
 */

// ──────────────────────────────────────────────────────────────────────
// Regex + types.
// ──────────────────────────────────────────────────────────────────────

/**
 * Matches a single placeholder token. The id sub-match captures
 * everything up to the next `}` - no greediness across lines, no
 * embedded `}` characters (our source store's hash-prefix ids are
 * lowercase hex, so the restriction is not load-bearing, but it
 * keeps the grammar unambiguous if a future id scheme adds
 * punctuation).
 *
 * Global flag lets the caller iterate via `matchAll` and gives
 * `replace` the "every occurrence" behavior we want.
 *
 * Exported so the structural check
 * (`deep-research-structural-check.ts`) can reuse the canonical
 * pattern - keeping one regex prevents a format tweak here from
 * silently diverging from the post-render validator.
 */
export const SRC_PLACEHOLDER_RE = /\{\{SRC:([^}]+)\}\}/g;

/**
 * A single placeholder occurrence extracted from a draft.
 *
 *   - `match`: the full matched substring, e.g. `{{SRC:abc123}}`.
 *     Useful for callers doing their own surgical replacements.
 *   - `id`: the captured id substring, e.g. `abc123`.
 */
export interface Placeholder {
  match: string;
  id: string;
}

/**
 * Minimal shape the `renumber` function needs to render a footnote.
 * Full `SourceRef` (see `research-sources.ts` in Phase 2) is a
 * superset - we accept only what we use so this module can be
 * exercised without pulling in the source store's richer types.
 */
export interface CitationSource {
  id: string;
  url: string;
  title: string;
}

// ──────────────────────────────────────────────────────────────────────
// Extraction.
// ──────────────────────────────────────────────────────────────────────

/**
 * Find every placeholder occurrence in `draft`, in document order.
 * Duplicates are NOT deduped - the caller decides whether they care
 * about each occurrence or the set of unique ids.
 */
export function extractPlaceholders(draft: string): Placeholder[] {
  const out: Placeholder[] = [];
  // `matchAll` returns an iterator; `RegExp.global` is required on
  // the pattern (it is, above) or the runtime throws.
  for (const m of draft.matchAll(SRC_PLACEHOLDER_RE)) {
    // `m[0]` is the full match; `m[1]` is the id capture.
    const full = m[0];
    const id = m[1];
    if (typeof full === 'string' && typeof id === 'string' && id.length > 0) {
      out.push({ match: full, id });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Validation.
// ──────────────────────────────────────────────────────────────────────

export interface ValidatePlaceholdersResult {
  /**
   * True iff every placeholder's id appears in the `known` set.
   * Empty drafts (no placeholders) are trivially ok.
   */
  ok: boolean;
  /**
   * Unique unknown ids in first-appearance order. An id referenced
   * three times with the same unknown id appears once here.
   */
  unknown: string[];
}

/**
 * Check whether every `{{SRC:<id>}}` in `draft` refers to an id the
 * caller knows about. Consumers pass `new Set(Object.keys(index))`
 * or equivalent. Returning the list of unknown ids (rather than
 * throwing) lets the caller decide whether to surface them to the
 * model for correction, quarantine the draft, or re-prompt the
 * planner for missing sources.
 */
export function validatePlaceholders(draft: string, known: ReadonlySet<string>): ValidatePlaceholdersResult {
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const { id } of extractPlaceholders(draft)) {
    if (known.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    unknown.push(id);
  }
  return { ok: unknown.length === 0, unknown };
}

// ──────────────────────────────────────────────────────────────────────
// Renumbering + footnote emission.
// ──────────────────────────────────────────────────────────────────────

export interface RenumberResult {
  /**
   * The rewritten report: every `{{SRC:<id>}}` replaced with a
   * `[^N]` marker whose number reflects first-use order.
   * Placeholders for unknown ids (not in the source index) are
   * left untouched so a subsequent validation step catches them.
   */
  report: string;
  /**
   * A newline-terminated markdown footnotes block enumerating
   * every known source referenced by the report. Format:
   *
   *     [^1]: <title> - <url>
   *     [^2]: <title> - <url>
   *     ...
   *
   * When the report references zero known sources, `footnotes` is
   * the empty string (no block is emitted). Callers typically
   * concatenate `report + "\n\n" + footnotes` to form the final
   * markdown document.
   */
  footnotes: string;
}

/**
 * Replace `{{SRC:<id>}}` placeholders in `draft` with
 * first-use-order `[^N]` footnote markers. Returns the rewritten
 * body and the footnotes block.
 *
 * Policy:
 *
 *   - Numbering is assigned on first occurrence and reused on
 *     every subsequent occurrence of the same id. That keeps the
 *     in-prose citations stable even when the draft reuses a
 *     source many times.
 *   - Unknown ids (not present in `sourceIndex`) are left as-is so
 *     a post-render `validatePlaceholders` call surfaces them.
 *     Rewriting them to `[^?]` or `[^N]` without a matching entry
 *     would silently hide the hallucination; we prefer loud.
 *   - Footnote entries use the title verbatim but collapse
 *     embedded newlines/tabs into single spaces so the block stays
 *     on one line per entry. The url is appended after an em-dash
 *     (` - `) separator.
 */
export function renumber(draft: string, sourceIndex: ReadonlyMap<string, CitationSource>): RenumberResult {
  // First-use order of *known* ids in the draft.
  const order = new Map<string, number>();
  for (const { id } of extractPlaceholders(draft)) {
    if (!sourceIndex.has(id)) continue;
    if (!order.has(id)) order.set(id, order.size + 1);
  }

  // Rewrite. We walk the matches a second time using `replace` so
  // the returned string preserves non-matched characters verbatim.
  const report = draft.replace(SRC_PLACEHOLDER_RE, (full, id: string) => {
    const n = order.get(id);
    // Unknown-id path - leave the placeholder intact for the
    // post-render validator to catch.
    if (n === undefined) return full;
    return `[^${n}]`;
  });

  if (order.size === 0) {
    return { report, footnotes: '' };
  }

  const footnotes = Array.from(order)
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => {
      // `sourceIndex.has(id)` is true by construction of `order`.
      const src = sourceIndex.get(id)!;
      const title = src.title.replace(/\s+/g, ' ').trim() || '(untitled)';
      return `[^${n}]: ${title} - ${src.url}`;
    })
    .join('\n');

  return { report, footnotes: `${footnotes}\n` };
}
