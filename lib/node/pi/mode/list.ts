/**
 * Listing formatter for `/mode` (no args). Pure module — no pi
 * imports — so the format is unit-tested directly under vitest. The
 * extension shell calls this and pipes the result into
 * `ctx.ui.notify`.
 */

export interface ListEntry {
  description?: string;
}

export interface FormatModeListingOptions {
  /** Mode names in the order they should appear (alphabetical at the call site). */
  nameOrder: readonly string[];
  /** Indexed parsed-mode records; only `description` is read. */
  modes: Readonly<Record<string, ListEntry>>;
  /** Currently-active mode name (`undefined` when none). */
  activeName: string | undefined;
}

/**
 * Render the multi-line listing produced by `/mode` (no args). Returns
 * an empty array when `nameOrder` is empty so the caller can branch
 * on "no modes loaded" without inspecting the formatted lines.
 *
 * Format:
 *
 *   (active: plan)            ← or `(no mode active)`
 *   * plan — Drop a plan doc; never edits source.
 *     chat — Long-form Q&A with web access; no writes.
 *     …
 *
 * The active mode is prefixed with `* ` (two chars including the
 * trailing space); inactive entries are indented to match.
 */
export function formatModeListing(opts: FormatModeListingOptions): string[] {
  const { nameOrder, modes, activeName } = opts;

  if (nameOrder.length === 0) {
    return [];
  }

  const header = activeName !== undefined ? `(active: ${activeName})` : '(no mode active)';
  const lines = nameOrder.map((name) => {
    const star = name === activeName ? '* ' : '  ';
    const desc = modes[name]?.description ?? '';
    return `${star}${name} — ${desc}`;
  });

  return [header, ...lines];
}
