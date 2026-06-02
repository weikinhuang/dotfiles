/**
 * USAGE text for the `/context-budget` command. Pure string module so
 * the extension shell and the `--help` path share one source of truth.
 */
export const CONTEXT_BUDGET_USAGE = [
  'Usage: /context-budget [preview]',
  '',
  'Preview the context-budget advisory that would be injected into the next turn.',
].join('\n');
