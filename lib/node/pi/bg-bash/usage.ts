/**
 * USAGE text for the `/bg-bash` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const BG_BASH_USAGE = [
  'Usage: /bg-bash [list|logs <id>|kill <id> [sig]|clear]',
  '',
  'Inspect the background-job registry (overlay by default), show a job log',
  '(`logs <id>`), signal a job (`kill <id> [sig]`), or drop terminal jobs',
  '(`clear`).',
].join('\n');
