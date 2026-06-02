/**
 * USAGE text for the `/filesystem` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const FILESYSTEM_USAGE = [
  'Usage: /filesystem',
  '',
  'Show the active filesystem policy (defaults / user / project / persona) and',
  'the session allowlist.',
].join('\n');
