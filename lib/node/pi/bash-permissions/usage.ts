/**
 * USAGE text for the `/bash-*` command family. Pure string module so
 * each extension-shell handler and its `--help` path share one source
 * of truth.
 */
export const BASH_ALLOW_USAGE = [
  'Usage: /bash-allow <exact-command | prefix*>',
  '',
  'Add an allow rule for bash commands (exact match or `prefix*`).',
].join('\n');

export const BASH_DENY_USAGE = [
  'Usage: /bash-deny <exact-command | prefix*>',
  '',
  'Add a deny rule for bash commands (exact match or `prefix*`).',
].join('\n');

export const BASH_PERMISSIONS_USAGE = [
  'Usage: /bash-permissions',
  '',
  'Show all bash permission rules (session / project / user) and auto-mode state.',
].join('\n');

export const BASH_AUTO_USAGE = [
  'Usage: /bash-auto [on|off|status]',
  '',
  'Toggle session auto-allow for bash commands (no args toggles). Hardcoded deny',
  'and explicit deny rules still block.',
].join('\n');
