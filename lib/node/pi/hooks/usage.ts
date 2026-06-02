/**
 * USAGE text for the `/hooks` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const HOOKS_USAGE = [
  'Usage: /hooks',
  '',
  'Show all registered hooks (session / project / user) grouped by event.',
].join('\n');
