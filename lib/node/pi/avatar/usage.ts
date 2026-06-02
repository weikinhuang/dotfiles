/**
 * USAGE text for the `/avatar` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const AVATAR_USAGE = [
  'Usage: /avatar [on|off]',
  '',
  'Show avatar status (no args or `status`), or toggle the widget for this',
  'session with `on` / `off`.',
].join('\n');
