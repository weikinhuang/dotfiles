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
  'Session-only sandbox bypass (cleared by /sandbox-enable, /sandbox-reset, or session_shutdown).',
].join('\n');

export const SANDBOX_ENABLE_USAGE = [
  'Usage: /sandbox-enable',
  '',
  'Clear the full-session bypass and initialize protection for new commands.',
  'Keeps network-only overrides and session grants; existing processes are unchanged.',
].join('\n');

export const SANDBOX_NETWORK_USAGE = [
  'Usage: /sandbox-network [enable|disable|status]',
  '',
  'Show status by default. Change only network sandboxing for this session.',
  'disable permits ALL network destinations while keeping filesystem protection.',
  'enable forces filtering on above config/env; it does not clear a full sandbox bypass.',
  'Stop active wrapped jobs before switching network isolation; restart clients afterward.',
].join('\n');

export const SANDBOX_RESET_USAGE = [
  'Usage: /sandbox-reset',
  '',
  'Clear session network/write grants, network mode override, and full sandbox bypass.',
  'Reload configured policies without changing files or terminating existing processes.',
].join('\n');

export const SANDBOX_EXPLAIN_USAGE = [
  'Usage: /sandbox-explain path <path>',
  '       /sandbox-explain host <host[:port]|URL>',
  '',
  'Explain effective read/write or host policy, matching rules, and contributing sources.',
  'Diagnostic only: no connections, writes, or approval prompts.',
].join('\n');

export const SANDBOX_TEST_USAGE = [
  'Usage: /sandbox-test',
  '',
  'Run native filesystem-enforcement checks against isolated synthetic temporary files.',
  'Tests allowed writes, denied reads, and denied writes without changing session policy.',
  'Never falls back to unwrapped execution; does not probe the network.',
].join('\n');
