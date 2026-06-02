/**
 * USAGE text for the `/persona` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const PERSONA_USAGE = [
  'Usage: /persona [<name>|off|info <name>]',
  '',
  'List personas (no args), activate one (`<name>`), clear the active persona',
  'and restore prior state (`off`), or print a resolved persona for debugging',
  '(`info <name>`).',
].join('\n');
