/**
 * USAGE text for the `/memory` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const MEMORY_USAGE = [
  'Usage: /memory [list|preview|dir|rescan|gc]',
  '',
  'List memories (no args or `list`), preview the injected index (`preview`),',
  'print the memory dir (`dir`), rescan disk (`rescan`), or prune orphaned',
  'session memory (`gc`).',
].join('\n');
