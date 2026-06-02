/**
 * USAGE text for the `/agents` command family. Pure string module so
 * each extension-shell handler and its `--help` path share one source
 * of truth.
 */
export const AGENTS_USAGE = [
  'Usage: /agents [list|show <name>|running]',
  '',
  'List loaded sub-agents (no args or `list`), show one definition',
  '(`show <name>`), or list active background children (`running`).',
].join('\n');

export const AGENTS_RUNNING_USAGE = [
  'Usage: /agents:running',
  '',
  'Open a live overlay listing active background sub-agents (auto-refreshing).',
].join('\n');
