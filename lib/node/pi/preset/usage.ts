/**
 * USAGE text for the `/preset` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const PRESET_USAGE = [
  'Usage: /preset [<name>|off]',
  '',
  'List presets (no args), activate a named preset (`<name>`), or clear the',
  'active preset and restore prior state (`off`).',
].join('\n');
