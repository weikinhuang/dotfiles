// Shared YAML-subset helpers used by both the frontmatter linter
// (`validate.ts`) and the description rewrite helper (`skill-md.ts`).
//
// Both files used to ship their own copies of this tiny scalar joiner
// and they drifted: `skill-md.ts` stripped the `>-` / `|` block-scalar
// indicators while `validate.ts` did not, so valid folded-block
// descriptions would trip the `description-angle-brackets` rule purely
// because the parser left the `>` in the joined string. Consolidating
// the two here keeps them in lockstep.
//
// The scope is deliberately small: just enough YAML to collapse a
// top-level scalar field's continuation lines into a single string,
// honouring single / double quoting and block-scalar indicators. Nested
// maps, tagged scalars, anchors / aliases, and multi-document streams
// are all out of scope - mirroring upstream `quick_validate.py`.
//
// SPDX-License-Identifier: MIT

/**
 * Collapse a field's value fragments (the tail after `key:` plus any
 * indented continuation lines, each already trimmed by the caller) into
 * a single scalar string.
 *
 * Behaviour, top-down:
 *   1. A leading `|` / `>` (optionally with YAML chomping / indent
 *      indicators like `|-`, `>2+`) is treated as a block-scalar lead.
 *      The indicator itself is dropped and the remaining fragments are
 *      joined with a single space - good enough for the length / shape
 *      checks our callers perform on `description` / `compatibility`.
 *   2. Single- or double-quoted flow scalars are unquoted, with the
 *      usual `\\` / `\"` (double) and `''` (single) escape rules.
 *   3. Everything else is joined with a single space and trimmed.
 *
 * The joiner intentionally does not reconstruct newlines inside block
 * scalars; keeping block scalars as a single line just loses the line
 * breaks, which is fine for length + character checks.
 */
export function joinFrontmatterScalar(fragments: readonly string[]): string {
  const first = fragments[0] ?? '';
  if (first === '|' || first === '>' || /^[|>][-+]?\d*\s*$/.test(first)) {
    return fragments.slice(1).join(' ').trim();
  }
  const joined = fragments.join(' ').trim();
  if (joined.length >= 2) {
    const f = joined[0];
    const l = joined[joined.length - 1];
    if (f === '"' && l === '"') return joined.slice(1, -1).replace(/\\([\\"])/g, '$1');
    if (f === "'" && l === "'") return joined.slice(1, -1).replace(/''/g, "'");
  }
  return joined;
}
