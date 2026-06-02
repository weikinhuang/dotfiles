/**
 * USAGE text for the `/header` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const HEADER_USAGE = [
  'Usage: /header [builtin|custom]',
  '',
  'Switch the session header source:',
  "  builtin   restore pi's default mascot + keybinding-hints header",
  '  custom    install the compact single-line header strip',
  '',
  'With no argument, prints the header source currently in effect.',
].join('\n');
