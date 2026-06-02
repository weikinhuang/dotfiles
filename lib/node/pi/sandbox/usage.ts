/**
 * USAGE text for the `/sandbox*` command family. Pure string module so
 * each extension-shell handler and its `--help` path share one source
 * of truth.
 */
export const SANDBOX_USAGE = [
  'Usage: /sandbox',
  '',
  'Show sandbox status, configuration sources, and recent violations.',
].join('\n');

export const SANDBOX_ALLOW_USAGE = [
  'Usage: /sandbox-allow <domain>',
  '',
  'Add a domain to the sandbox network allowlist.',
].join('\n');

export const SANDBOX_DENY_USAGE = [
  'Usage: /sandbox-deny <domain>',
  '',
  'Add a domain to the sandbox network denylist.',
].join('\n');

export const SANDBOX_ALLOW_WRITE_USAGE = [
  'Usage: /sandbox-allow-write <path>',
  '',
  'Add a path to filesystem.write.allow.paths (UI-confirmed; weakens policy).',
].join('\n');

export const SANDBOX_VIOLATIONS_USAGE = [
  'Usage: /sandbox-violations [--net|--fs]',
  '',
  'Show recent sandbox violations, optionally filtered to network (`--net`) or',
  'filesystem (`--fs`) events.',
].join('\n');

export const SANDBOX_RESCAN_USAGE = [
  'Usage: /sandbox-rescan',
  '',
  'Recompile Linux rule basenames/segments to literal paths via ripgrep.',
].join('\n');

export const SANDBOX_RECHECK_USAGE = [
  'Usage: /sandbox-recheck',
  '',
  'Re-run dependency detection (after installing bubblewrap / ripgrep / socat).',
].join('\n');

export const SANDBOX_DISABLE_USAGE = [
  'Usage: /sandbox-disable',
  '',
  'Session-only sandbox bypass (cleared on session_shutdown).',
].join('\n');
