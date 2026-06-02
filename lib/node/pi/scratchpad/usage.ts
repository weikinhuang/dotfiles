/**
 * USAGE text for the `/scratchpad` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const SCRATCHPAD_USAGE = [
  'Usage: /scratchpad [list|preview]',
  '',
  'Show the scratchpad (no args or `list`) or preview (`preview`) what would be',
  "injected into the next turn's system prompt.",
].join('\n');
